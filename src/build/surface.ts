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
    const crossings: number[] = [];
    for (let y = from; y <= to; y++) {
      // Sample at the pixel centre so a horizontal edge along a pixel boundary cannot
      // produce an ambiguous crossing count.
      const scan = y + 0.5;
      crossings.length = 0;
      for (const ring of rings)
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const yi = this.py(ring[i][1]);
          const yj = this.py(ring[j][1]);
          if (yi > scan !== yj > scan) {
            const xi = this.px(ring[i][0]);
            const xj = this.px(ring[j][0]);
            crossings.push(xi + ((scan - yi) / (yj - yi)) * (xj - xi));
          }
        }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);
      const row = y * this.width;
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const left = Math.max(0, Math.ceil(crossings[k] - 0.5));
        const right = Math.min(this.width - 1, Math.floor(crossings[k + 1] - 0.5));
        for (let x = left; x <= right; x++)
          if (combine === "set" || value > this.values[row + x]) this.values[row + x] = value;
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
   */
  dilate(radiusM: number): void {
    const r = Math.round(radiusM / this.metresPerPixel);
    if (r < 1) return;
    const { width, height, values } = this;
    const pass = (horizontal: boolean) => {
      const source = Float32Array.from(values);
      const outer = horizontal ? height : width;
      const inner = horizontal ? width : height;
      for (let a = 0; a < outer; a++)
        for (let b = 0; b < inner; b++) {
          let best = 0;
          for (let d = -r; d <= r; d++) {
            const c = b + d;
            if (c < 0 || c >= inner) continue;
            const v = horizontal ? source[a * width + c] : source[c * width + a];
            if (v > best) best = v;
          }
          if (best > 0) {
            if (horizontal) values[a * width + b] = best;
            else values[b * width + a] = best;
          }
        }
    };
    pass(true);
    pass(false);
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
