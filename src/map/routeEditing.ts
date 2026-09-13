import type { Point } from "../routing/types";

/** Nearest position on a polyline, in the coordinate space supplied by the caller. */
export function nearestPosition(line: Point[], point: Point) {
  let best = { distance: Infinity, position: 0, point };
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1],
      b = line[i];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(
        1,
        ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) /
          (dx * dx + dy * dy || 1),
      ),
    );
    const p: Point = [a[0] + t * dx, a[1] + t * dy];
    const distance = Math.hypot(point[0] - p[0], point[1] - p[1]);
    if (distance < best.distance)
      best = { distance, position: i - 1 + t, point: p };
  }
  return best;
}

/** Map a position along the displayed route to an ordered waypoint leg. */
export function insertionIndex(
  line: Point[],
  anchors: Point[],
  position: number,
) {
  let start = 0;
  for (let i = 1; i < anchors.length - 1; i++) {
    const nearest = nearestPosition(line.slice(start), anchors[i]);
    const boundary = start + nearest.position;
    if (position < boundary) return i;
    start = Math.min(line.length - 1, Math.ceil(boundary));
  }
  return anchors.length - 1;
}
