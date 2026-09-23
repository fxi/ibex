import { distance } from "../geo/distance";
import { project } from "../geo/project";
import type { Point } from "../routing/types";

/** Grid step in degrees: a few hundred metres, so a lookup reads a handful of cells. */
const CELL_DEG = 0.01;
/** A segment spanning more cells than this is checked on every lookup instead of indexed. */
const MAX_CELLS = 64;
const M_PER_DEG = 111_320;

const key = (ix: number, iy: number) => (ix + 20_000) * 40_000 + (iy + 10_000);

/**
 * Distances along one route, and where a point falls on it.
 *
 * A 500 km route is tens of thousands of vertices and a search along it finds thousands of
 * places, so projecting each place on every segment would be a hundred million projections.
 * Segments are bucketed on a coarse grid instead, and a lookup reads only the cells within
 * its reach. Metres are rescaled to the route's own `distanceM`, so a note's kilometre agrees
 * with the total the rider reads everywhere else.
 */
export class RouteIndex {
  readonly meters: Float64Array;
  readonly lengthM: number;
  private readonly cells = new Map<number, number[]>();
  private readonly long: number[] = [];

  constructor(
    readonly geometry: Point[],
    distanceM?: number,
  ) {
    const meters = new Float64Array(geometry.length);
    for (let i = 1; i < geometry.length; i++)
      meters[i] = meters[i - 1] + distance(geometry[i - 1], geometry[i]);
    const raw = meters.at(-1) ?? 0;
    const scale = distanceM && raw > 0 ? distanceM / raw : 1;
    if (scale !== 1) for (let i = 0; i < meters.length; i++) meters[i] *= scale;
    this.meters = meters;
    this.lengthM = meters.at(-1) ?? 0;
    for (let i = 0; i + 1 < geometry.length; i++) {
      const [a, b] = [geometry[i], geometry[i + 1]];
      const x0 = Math.floor(Math.min(a[0], b[0]) / CELL_DEG),
        x1 = Math.floor(Math.max(a[0], b[0]) / CELL_DEG),
        y0 = Math.floor(Math.min(a[1], b[1]) / CELL_DEG),
        y1 = Math.floor(Math.max(a[1], b[1]) / CELL_DEG);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) {
        this.long.push(i);
        continue;
      }
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const k = key(x, y);
          const list = this.cells.get(k);
          if (list) list.push(i);
          else this.cells.set(k, [i]);
        }
    }
  }

  /** The closest place on the route within `maxM`, or undefined when it is further. */
  locate(
    p: Point,
    maxM: number,
  ): { m: number; offsetM: number; point: Point } | undefined {
    const dy = maxM / M_PER_DEG,
      dx = dy / Math.max(0.05, Math.cos((p[1] * Math.PI) / 180));
    const x0 = Math.floor((p[0] - dx) / CELL_DEG),
      x1 = Math.floor((p[0] + dx) / CELL_DEG),
      y0 = Math.floor((p[1] - dy) / CELL_DEG),
      y1 = Math.floor((p[1] + dy) / CELL_DEG);
    let best: { i: number; t: number; d: number; point: Point } | undefined;
    const test = (i: number) => {
      const r = project(p, this.geometry[i], this.geometry[i + 1]);
      if (r.distance <= maxM && (!best || r.distance < best.d))
        best = { i, t: r.t, d: r.distance, point: r.point };
    };
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (const i of this.cells.get(key(x, y)) ?? []) test(i);
    for (const i of this.long) test(i);
    if (!best) return;
    const { i, t, d, point } = best;
    return {
      m: this.meters[i] + t * (this.meters[i + 1] - this.meters[i]),
      offsetM: d,
      point,
    };
  }

  /** The last vertex at or before `m`. */
  vertexBefore(m: number): number {
    let lo = 0,
      hi = this.meters.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.meters[mid] <= m) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The point `m` metres along the route. */
  pointAtM(m: number): Point {
    const g = this.geometry;
    if (g.length < 2) return g[0];
    const i = Math.min(this.vertexBefore(m), g.length - 2);
    const span = this.meters[i + 1] - this.meters[i];
    const t =
      span > 0 ? Math.max(0, Math.min(1, (m - this.meters[i]) / span)) : 0;
    return [
      g[i][0] + t * (g[i + 1][0] - g[i][0]),
      g[i][1] + t * (g[i + 1][1] - g[i][1]),
    ];
  }

  /** The route between two distances, its ends interpolated. */
  slice(fromM: number, toM: number): Point[] {
    const first = this.vertexBefore(fromM) + 1,
      last = this.vertexBefore(toM);
    const inner = this.geometry.slice(first, last + 1);
    return [this.pointAtM(fromM), ...inner, this.pointAtM(toM)];
  }
}
