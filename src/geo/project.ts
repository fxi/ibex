import { distance } from "./distance";
import type { Point } from "../routing/types";

/** Whether a point lies inside a [west, south, east, north] box. */
export function pointInBounds(
  p: Point,
  b: [number, number, number, number],
): boolean {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}

/**
 * The closest point to `p` on the segment `a`–`b`, the fraction along it, and how far away
 * it is in metres. Longitude is scaled by the cosine of the query point's latitude, so the
 * projection is done on a locally square grid rather than in raw degrees.
 */
export function project(
  p: Point,
  a: Point,
  b: Point,
): { point: Point; t: number; distance: number } {
  const cos = Math.cos((p[1] * Math.PI) / 180),
    dx = (b[0] - a[0]) * cos,
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p[0] - a[0]) * cos * dx + (p[1] - a[1]) * dy) /
        (dx * dx + dy * dy || 1),
    ),
  );
  const point: Point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  return { point, t, distance: distance(p, point) };
}
