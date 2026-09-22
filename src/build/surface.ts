/**
 * Raster cost surfaces for a cell.
 *
 * The signals that shape a route's character — how stressful ground is, how scenic — are
 * approximations by design: forest cover, built-up density, proximity to a viewpoint. They
 * are not measurements of anything exact, so they are painted into a raster at the
 * resolution the answer deserves and sampled along each edge.
 *
 * This replaces the vector path the Python builder uses (shapely polygons, unions, prepared
 * containment). That path spends its effort on a precision the signal does not have, and
 * pays for it with boundary cases that have no right answer: a track drawn along a forest
 * edge shares its nodes, so "is this point inside" depends on which polygon happened to be
 * dissolved into which. At raster resolution the question does not arise.
 *
 * One pixel is `METRES_PER_PIXEL` square. A z9 cell plus halo is about 2,100 pixels across,
 * a z10 cell about 1,250 — a few megabytes of `Float32Array`, built in one pass.
 */
import type { Point } from "../routing/types";

/**
 * Fine enough that a small wood does not bleed onto the road beside it.
 *
 * Measured on the z9 cell 9-266-187 against the vector builder: at 30 m, 112 ways read as
 * mostly-forest when they are not — a 15 m roundabout arm sits inside one pixel that a
 * neighbouring wood painted. At 10 m that falls to 14, and mean divergence over all 26,222
 * ways drops from 0.019 to 0.008. The cost is the paint pass: 2.6 s for a z9 cell and its
 * halo, about a quarter of that for z10, which is the grid this builder targets.
 */
export const METRES_PER_PIXEL = 10;
const METRES_PER_DEGREE_LAT = 111320;

export type BBox = [number, number, number, number];

/**
 * How a paint operation meets what is already there.
 *
 * `set` is right for a mask — wood is wood however many polygons cover it. `max` is right
 * for a strength: a viewpoint's pull should not be erased by a weaker bench overlapping it.
 */
export type Combine = "set" | "max";

export class Surface {
  readonly width: number;
  readonly height: number;
  readonly values: Float32Array;
  private readonly lonScale: number;
  private readonly latScale: number;

  constructor(
    readonly bbox: BBox,
    readonly metresPerPixel = METRES_PER_PIXEL,
  ) {
    // Longitude degrees shorten with latitude; one scale for the cell is accurate enough
    // across the 50 km it spans.
    const midLat = (bbox[1] + bbox[3]) / 2;
    const metresPerDegreeLon = METRES_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180);
    this.lonScale = metresPerDegreeLon / metresPerPixel;
    this.latScale = METRES_PER_DEGREE_LAT / metresPerPixel;
    this.width = Math.max(1, Math.ceil((bbox[2] - bbox[0]) * this.lonScale));
    this.height = Math.max(1, Math.ceil((bbox[3] - bbox[1]) * this.latScale));
    this.values = new Float32Array(this.width * this.height);
  }

  private px(lon: number): number {
    return (lon - this.bbox[0]) * this.lonScale;
  }

  private py(lat: number): number {
    return (lat - this.bbox[1]) * this.latScale;
  }

  /** Pixels per metre, for callers converting a radius. */
  get pixelsPerMetre(): number {
    return 1 / this.metresPerPixel;
  }

  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.values[y * this.width + x];
  }

  /**
   * Paint a polygon, holes included, by even-odd scanline fill.
   *
   * Every ring goes in together: a pixel inside an odd number of rings is inside the
   * polygon, which is what makes a hole a hole without tracking which ring is which.
   *
   * Vertices are projected once into pixel space and bucketed by the first row they can
   * cross, because callers hand this every ring in the cell at once. Re-projecting each
   * ring on every row cost 17.9 s of a 30 s z9 build — the scan is thousands of rows deep
   * and a dense cell's forest rings hold tens of thousands of vertices.
   */
  fill(rings: readonly (readonly Point[])[], value = 1, combine: Combine = "set"): void {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const ring of rings)
      for (const p of ring) {
        const y = this.py(p[1]);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    if (!Number.isFinite(minY)) return;
    const from = Math.max(0, Math.floor(minY));
    const to = Math.min(this.height - 1, Math.ceil(maxY));
    if (to < from) return;

    // One entry per ring segment, oriented from vertex i to the vertex before it, which is
    // the pairing the even-odd test below reads.
    const xi: number[] = [];
    const yi: number[] = [];
    const xj: number[] = [];
    const yj: number[] = [];
    const last: number[] = [];
    const buckets: number[][] = [];
    for (const ring of rings) {
      const n = ring.length;
      if (n < 2) continue;
      let bx = this.px(ring[n - 1][0]);
      let by = this.py(ring[n - 1][1]);
      for (let i = 0; i < n; i++) {
        const ax = this.px(ring[i][0]);
        const ay = this.py(ring[i][1]);
        const prevX = bx;
        const prevY = by;
        bx = ax;
        by = ay;
        // A segment crosses the scan at `y + 0.5` exactly when one end is above it and the
        // other is not, so it is live for `min <= y + 0.5 < max` and nowhere else.
        const lo = ay < prevY ? ay : prevY;
        const hi = ay < prevY ? prevY : ay;
        if (lo === hi) continue;
        const first = Math.max(from, Math.ceil(lo - 0.5));
        const stop = Math.min(to, Math.ceil(hi - 0.5) - 1);
        if (first > stop) continue;
        const at = xi.length;
        xi.push(ax);
        yi.push(ay);
        xj.push(prevX);
        yj.push(prevY);
        last.push(stop);
        (buckets[first] ??= []).push(at);
      }
    }
    if (!xi.length) return;

    const ex = Float64Array.from(xi);
    const ey = Float64Array.from(yi);
    const px = Float64Array.from(xj);
    const py = Float64Array.from(yj);
    const ends = Int32Array.from(last);
    const crossings = new Float64Array(xi.length);
    const overwrite = combine === "set";
    const active: number[] = [];

    for (let y = from; y <= to; y++) {
      const entering = buckets[y];
      if (entering) for (const e of entering) active.push(e);
      if (!active.length) continue;
      const scan = y + 0.5;
      let count = 0;
      let live = 0;
      for (let k = 0; k < active.length; k++) {
        const e = active[k];
        if (ends[e] < y) continue;
        active[live++] = e;
        const a = ey[e];
        crossings[count++] = ex[e] + ((scan - a) / (py[e] - a)) * (px[e] - ex[e]);
      }
      active.length = live;
      if (count < 2) continue;
      const row = crossings.subarray(0, count);
      row.sort();
      const at = y * this.width;
      for (let k = 0; k + 1 < count; k += 2) {
        const left = Math.max(0, Math.ceil(row[k] - 0.5));
        const right = Math.min(this.width - 1, Math.floor(row[k + 1] - 0.5));
        for (let x = left; x <= right; x++)
          if (overwrite || value > this.values[at + x]) this.values[at + x] = value;
      }
    }
  }

  /** Paint a disc, for a place centre or any point-with-influence. */
  stamp(centre: Point, radiusM: number, value = 1, combine: Combine = "set"): void {
    const cx = this.px(centre[0]);
    const cy = this.py(centre[1]);
    const r = radiusM / this.metresPerPixel;
    const from = Math.max(0, Math.floor(cy - r));
    const to = Math.min(this.height - 1, Math.ceil(cy + r));
    for (let y = from; y <= to; y++) {
      const dy = y + 0.5 - cy;
      const span = Math.sqrt(Math.max(0, r * r - dy * dy));
      const left = Math.max(0, Math.ceil(cx - span - 0.5));
      const right = Math.min(this.width - 1, Math.floor(cx + span - 0.5));
      const row = y * this.width;
      for (let x = left; x <= right; x++)
        if (combine === "set" || value > this.values[row + x]) this.values[row + x] = value;
    }
  }

  /**
   * Grow painted areas by a radius.
   *
   * The Python buffers urban land use by 40 m so the streets *between* plots count as town
   * rather than only the plots themselves. Two separable passes approximate the disc, which
   * is all a 30 m grid can express anyway.
   *
   * Each pass reads a copy of the row band it needs rather than a copy of the whole
   * surface: a z9 cell is 41 million pixels, so the two full `Float32Array` copies the
   * obvious version makes are 164 MB of allocation, and the column-major inner loop touched
   * a fresh cache line per pixel.
   */
  dilate(radiusM: number): void {
    const r = Math.round(radiusM / this.metresPerPixel);
    if (r < 1) return;
    const { width, height, values } = this;
    const out = new Float32Array(width);

    const source = new Float32Array(width);
    for (let y = 0; y < height; y++) {
      const at = y * width;
      source.set(values.subarray(at, at + width));
      out.fill(0);
      for (let d = -r; d <= r; d++) {
        const lo = Math.max(0, -d);
        const hi = Math.min(width, width - d);
        for (let x = lo; x < hi; x++) {
          const v = source[x + d];
          if (v > out[x]) out[x] = v;
        }
      }
      for (let x = 0; x < width; x++) if (out[x] > 0) values[at + x] = out[x];
    }

    // The vertical pass needs rows this pass has not overwritten yet, so it keeps the last
    // 2r+1 original rows in a ring. Row y+r is read before output row y+r is written.
    const span = 2 * r + 1;
    const ring = new Float32Array(span * width);
    const held = new Int32Array(span).fill(-1);
    const load = (y: number) => {
      if (y < 0 || y >= height) return;
      const slot = y % span;
      if (held[slot] === y) return;
      ring.set(values.subarray(y * width, (y + 1) * width), slot * width);
      held[slot] = y;
    };
    for (let y = 0; y <= r; y++) load(y);
    for (let y = 0; y < height; y++) {
      load(y + r);
      const at = y * width;
      out.fill(0);
      const lo = Math.max(0, y - r);
      const hi = Math.min(height - 1, y + r);
      for (let sy = lo; sy <= hi; sy++) {
        const from = (sy % span) * width;
        for (let x = 0; x < width; x++) {
          const v = ring[from + x];
          if (v > out[x]) out[x] = v;
        }
      }
      for (let x = 0; x < width; x++) if (out[x] > 0) values[at + x] = out[x];
    }
  }

  /** The surface's value at a point. */
  sample(point: Point): number {
    return this.at(Math.floor(this.px(point[0])), Math.floor(this.py(point[1])));
  }

  /**
   * The mean value along a polyline, stepped about one pixel at a time.
   *
   * A zero-length line still reports its one point, so a degenerate edge reads as the
   * ground it sits on rather than as nothing.
   */
  sampleLine(coords: readonly Point[]): number {
    if (coords.length === 0) return 0;
    if (coords.length === 1) return this.sample(coords[0]);
    let total = 0;
    let count = 0;
    for (let i = 0; i + 1 < coords.length; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      const dx = this.px(b[0]) - this.px(a[0]);
      const dy = this.py(b[1]) - this.py(a[1]);
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        total += this.sample([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
        count++;
      }
    }
    total += this.sample(coords[coords.length - 1]);
    count++;
    return total / count;
  }

  /**
   * The strongest value anywhere along a polyline.
   *
   * An attraction is not diluted by the length of the way that reaches it: passing one
   * viewpoint makes the whole way worth riding, which a mean would average away on a long
   * edge.
   */
  sampleMax(coords: readonly Point[]): number {
    let best = 0;
    for (let i = 0; i + 1 < coords.length; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      const dx = this.px(b[0]) - this.px(a[0]);
      const dy = this.py(b[1]) - this.py(a[1]);
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const v = this.sample([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
        if (v > best) best = v;
      }
    }
    const last = this.sample(coords[coords.length - 1]);
    return last > best ? last : best;
  }
}
