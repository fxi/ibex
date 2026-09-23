/**
 * Turning a recorded track into waypoints the router reproduces.
 *
 * Waypoints are not guessed from the geometry alone: a fixed spacing either pins every few
 * hundred metres, which nobody will edit, or leaves the router free to take a road it likes
 * better and silently change the ride. Instead the recording is seeded sparsely, routed,
 * and pinned again only where the route parts from it — at the point of the recording
 * farthest from the route, which is where the router turned off. That point sits at the
 * fork, so waypoints land at intersections without anything having to detect one.
 */
import { distance, project } from "./engine";
import { anchorVertices } from "./localEdit";
import type { Point, RouteResult } from "./types";

/** One seed per this many metres: short legs, well inside the search window. */
export const SEED_SPACING_M = 5000;
/** GPS noise and OSM's own offset stay under this; a different road does not. */
export const OFFSET_TOLERANCE_M = 40;
/** A leg this much longer or shorter than its stretch of recording took another way. */
export const LENGTH_TOLERANCE = 0.1;
/** Below this, a length difference is a hairpin smoothed away, not another way. */
const LENGTH_SLACK_M = 150;

/** Metres from the start of `line` to each of its vertices. */
export function along(line: Point[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++)
    out.push(out[i - 1] + distance(line[i - 1], line[i]));
  return out;
}

/**
 * Indices into `recording` to route through first: both ends and one every `spacingM`.
 * A loop shorter than that still gets a midpoint, so no leg starts and ends at one place.
 */
export function seedIndices(
  recording: Point[],
  spacingM = SEED_SPACING_M,
): number[] {
  const last = recording.length - 1;
  if (last < 1) return [];
  const at = along(recording),
    total = at[last];
  const legs = Math.max(
    Math.ceil(total / spacingM),
    distance(recording[0], recording[last]) < total / 2 ? 2 : 1,
  );
  const indices = [0];
  let i = 0;
  for (let k = 1; k < legs; k++) {
    const target = (total * k) / legs;
    while (i < last && at[i] < target) i++;
    if (i > indices.at(-1)! && i < last) indices.push(i);
  }
  indices.push(last);
  return indices;
}

/** How far each point of `stretch` is from `line`, and the farthest one. */
export function offset(
  stretch: Point[],
  line: Point[],
): { max: number; index: number } {
  let max = 0,
    index = 0;
  for (const [i, p] of stretch.entries()) {
    let near = Infinity;
    if (line.length === 1) near = distance(p, line[0]);
    for (let j = 1; j < line.length && near > 0; j++)
      near = Math.min(near, project(p, line[j - 1], line[j]).distance);
    if (near > max) {
      max = near;
      index = i;
    }
  }
  return { max, index };
}

export type Refinement = {
  /** Indices into the recording, with a new one wherever a leg parted from it. */
  indices: number[];
  /** Legs that part from the recording, whether or not they could be pinned again. */
  deviating: number;
  /** Whether any waypoint was added; if not, routing again would change nothing. */
  changed: boolean;
};

/**
 * Compare each leg of `route` with the stretch of `recording` between its waypoints, and
 * pin a waypoint where it parts. Undefined when the route cannot be split into legs.
 */
export function refineIndices(
  recording: Point[],
  indices: number[],
  route: RouteResult,
  maxAnchors = Infinity,
): Refinement | undefined {
  const vertices = anchorVertices(route, indices.length);
  if (!vertices) return;
  const out = [indices[0]];
  let deviating = 0;
  for (let k = 1; k < indices.length; k++) {
    const from = indices[k - 1],
      to = indices[k];
    const stretch = recording.slice(from, to + 1),
      leg = route.geometry.slice(vertices[k - 1], vertices[k] + 1);
    const far = offset(stretch, leg);
    const recorded = along(stretch).at(-1)!,
      routed = along(leg).at(-1)!;
    const off =
      far.max > OFFSET_TOLERANCE_M ||
      (Math.abs(routed - recorded) > LENGTH_SLACK_M &&
        Math.abs(routed - recorded) > recorded * LENGTH_TOLERANCE);
    if (off) {
      deviating++;
      // Where every point is close but the length is wrong, the route doubled back on
      // itself somewhere; the middle of the stretch splits that as well as anything.
      const pin =
        far.max > OFFSET_TOLERANCE_M
          ? from + far.index
          : from + Math.floor((to - from) / 2);
      if (
        pin > from &&
        pin < to &&
        out.length + (indices.length - k) < maxAnchors
      )
        out.push(pin);
    }
    out.push(to);
  }
  return { indices: out, deviating, changed: out.length > indices.length };
}
