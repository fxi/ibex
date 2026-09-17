import type { Point } from "../routing/types";

/**
 * Metres between two lon/lat points, equirectangular about their mean latitude. Exact
 * enough at the scale of an edge and far cheaper than haversine, which matters because the
 * search calls it per candidate edge.
 *
 * It lives here rather than in the engine because an imported GPX is measured with it too:
 * a second copy meant an imported track's `distanceM` and a planned route's could drift
 * apart on the same ground.
 */
export function distance(a: Point, b: Point): number {
  const r = Math.PI / 180;
  return (
    6371000 *
    Math.hypot(
      (a[0] - b[0]) * r * Math.cos(((a[1] + b[1]) * r) / 2),
      (a[1] - b[1]) * r,
    )
  );
}
