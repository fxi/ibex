/**
 * Edits that stay where they were made.
 *
 * Moving a waypoint reroutes both legs that meet there, end to end, so on a 500 km route a
 * nudge made at street level could redraw the ride 200 km away. Instead, where the route
 * leaves the screen on either side of the grab, a pinch waypoint is pinned onto the current
 * line. Only the stretch between the pinches is routed again; the legs outside them are
 * cut from the route as it already is, so they cannot change.
 *
 * Pinches are ordinary waypoints once placed. What they give up is what every waypoint
 * gives up: a route may turn around at one (see routing/legs).
 */
import { distance } from "./engine";
import type { Components, Point, RouteResult, RouteSegment } from "./types";

/** What an edit grabbed: waypoint `index`, or the leg ending at waypoint `index`. */
export type RouteGrab =
  | { kind: "move"; index: number }
  /** `position` is fractional, along the route geometry, where the leg was grabbed. */
  | { kind: "insert"; index: number; position: number };

/** Where a pinch waypoint is pinned: a fractional `position` along the route geometry. */
export type Pinch = { position: number; point: Point };
export type Pinches = { before?: Pinch; after?: Pinch };

const same = (a: Point, b: Point) =>
  Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/** The point at fractional `position` along `geometry`. */
function pointAt(geometry: Point[], position: number): Point {
  const i = Math.max(0, Math.min(Math.floor(position), geometry.length - 2));
  const t = position - i;
  const a = geometry[i],
    b = geometry[i + 1];
  if (t <= 0) return a;
  if (t >= 1) return b;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/**
 * The geometry vertex each routed waypoint sits on. Every leg starts and ends on its snapped
 * waypoint and joined legs share that vertex, so each is found in order along the line.
 * Undefined when the route does not match `count` waypoints.
 */
export function anchorVertices(
  route: RouteResult,
  count: number,
): number[] | undefined {
  const { geometry, anchors } = route;
  if (route.status !== "ok" || anchors.length !== count || geometry.length < 2)
    return;
  const vertices: number[] = [];
  let from = 0;
  for (const anchor of anchors) {
    let found = -1;
    for (let i = from; i < geometry.length && found < 0; i++)
      if (same(geometry[i], anchor)) found = i;
    if (found < 0) return;
    vertices.push(found);
    from = found;
  }
  return vertices.at(-1) === geometry.length - 1 ? vertices : undefined;
}

/**
 * Where to pin the route on each side of a grab: where it crosses out of `visible`,
 * walking out from the grab. The crossing is found along the span that leaves, not at a
 * vertex, because a long straight way can put its next vertex kilometres off screen.
 *
 * No pinch on a side whose neighbouring waypoint is reached on screen, which is then the
 * natural limit, and none at all when the grab itself is off screen.
 */
export function findPinches(
  geometry: Point[],
  vertices: number[],
  grab: RouteGrab,
  visible: (point: Point) => boolean,
): Pinches {
  const [at, lower, upper] =
    grab.kind === "move"
      ? [
          vertices[grab.index],
          vertices[grab.index - 1],
          vertices[grab.index + 1],
        ]
      : [grab.position, vertices[grab.index - 1], vertices[grab.index]];
  if (!visible(pointAt(geometry, at))) return {};
  // Bisect between a position still on screen and one that is not.
  const crossing = (inside: number, outside: number): Pinch | undefined => {
    let lo = inside,
      hi = outside;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (visible(pointAt(geometry, mid))) lo = mid;
      else hi = mid;
    }
    return Math.abs(lo - at) < 1e-6
      ? undefined
      : { position: lo, point: pointAt(geometry, lo) };
  };
  const walk = (limit: number | undefined, step: 1 | -1) => {
    if (limit === undefined) return;
    let inside = at;
    for (
      let i = step < 0 ? Math.ceil(at) - 1 : Math.floor(at) + 1;
      step < 0 ? i >= limit : i <= limit;
      i += step
    ) {
      if (!visible(geometry[i])) return crossing(inside, i);
      inside = i;
    }
    return undefined;
  };
  return { before: walk(lower, -1), after: walk(upper, 1) };
}

/** Rising and falling metres between consecutive known heights. */
function climb(profile: [number, number | null][]): [number, number] {
  let up = 0,
    down = 0;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1][1],
      b = profile[i][1];
    if (a === null || b === null) continue;
    if (b > a) up += b - a;
    else down += a - b;
  }
  return [up, down];
}

/**
 * The stretch of `route` between fractional positions `from` and `to` along its geometry,
 * as a leg of its own. An end that falls between two vertices becomes a vertex.
 *
 * Geometry, segments and the elevation profile are cut exactly. Totals the route only
 * holds as sums are shared out: by the segments that carry them where segments can tell
 * (surface, hike-a-bike, ferry), by climbing along the profile for ascent, and by length
 * for cost and uncertainty. Joining the pieces back gives the route's own totals.
 */
export function sliceRoute(
  route: RouteResult,
  from: number,
  to: number,
): RouteResult {
  const g = route.geometry;
  const along = [0];
  for (let i = 1; i < g.length; i++)
    along.push(along[i - 1] + distance(g[i - 1], g[i]));
  const alongAt = (p: number) => {
    const i = Math.max(0, Math.min(Math.floor(p), g.length - 2));
    return along[i] + (p - i) * (along[i + 1] - along[i]);
  };
  const line = along.at(-1)! || 1;
  const share = (alongAt(to) - alongAt(from)) / line;
  const m0 = (route.distanceM * alongAt(from)) / line,
    m1 = (route.distanceM * alongAt(to)) / line;

  const first = Math.ceil(from),
    last = Math.floor(to);
  const geometry: Point[] = [
    ...(first > from ? [pointAt(g, from)] : []),
    ...g.slice(first, last + 1),
    ...(last < to ? [pointAt(g, to)] : []),
  ];
  const offset = first > from ? 1 : 0;
  const index = (p: number) =>
    p <= from ? 0 : p >= to ? geometry.length - 1 : p - first + offset;

  const segments: RouteSegment[] = [];
  for (const s of route.segments) {
    const start = Math.max(s.start, from),
      end = Math.min(s.end, to);
    if (end <= start || index(end) <= index(start)) continue;
    const whole = along[s.end] - along[s.start];
    segments.push({
      ...s,
      start: index(start),
      end: index(end),
      lengthM:
        whole > 0 ? (s.lengthM * (alongAt(end) - alongAt(start))) / whole : 0,
    });
  }
  const measured = (list: RouteSegment[], keep: (s: RouteSegment) => boolean) =>
    list.filter(keep).reduce((sum, s) => sum + s.lengthM, 0);
  const part = (value: number, keep: (s: RouteSegment) => boolean) => {
    const all = measured(route.segments, keep);
    return all > 0 ? (value * measured(segments, keep)) / all : 0;
  };

  const heightAt = (m: number): number | null => {
    const p = route.elevationProfile;
    for (let i = 1; i < p.length; i++) {
      const [ma, ha] = p[i - 1],
        [mb, hb] = p[i];
      if (m < ma || m > mb) continue;
      if (ha === null || hb === null) return null;
      return mb > ma ? ha + ((hb - ha) * (m - ma)) / (mb - ma) : hb;
    }
    return null;
  };
  const elevationProfile: [number, number | null][] = [
    [0, heightAt(m0)],
    ...route.elevationProfile
      .filter(([m]) => m > m0 && m < m1)
      .map(([m, h]): [number, number | null] => [m - m0, h]),
    [m1 - m0, heightAt(m1)],
  ];
  const [upAll, downAll] = climb(route.elevationProfile),
    [up, down] = climb(elevationProfile);

  const surfaceM: Record<string, number> = {};
  for (const [surface, m] of Object.entries(route.surfaceM)) {
    const value = part(m, (s) => s.surface === surface);
    if (value > 0) surfaceM[surface] = value;
  }
  return {
    status: "ok",
    mode: route.mode,
    geometry,
    anchors: [geometry[0], geometry[geometry.length - 1]],
    cost: route.cost * share,
    components: Object.fromEntries(
      Object.entries(route.components).map(([k, v]) => [k, v * share]),
    ) as Components,
    distanceM: m1 - m0,
    hikeABikeM: part(route.hikeABikeM, (s) => s.ride === "walk"),
    ferryM: part(route.ferryM, (s) => s.ride === "ferry"),
    ascentM:
      route.ascentM === null
        ? null
        : upAll > 0
          ? (route.ascentM * up) / upAll
          : 0,
    descentM:
      route.descentM === null
        ? null
        : downAll > 0
          ? (route.descentM * down) / downAll
          : 0,
    elevationProfile,
    edgeIds: [],
    segments,
    surfaceM,
    uncertainM: route.uncertainM * share,
    metrics: {
      durationMs: 0,
      explored: 0,
      expansions: 0,
      tiles: 0,
      loadedBytes: 0,
    },
  };
}

/**
 * The waypoints after an edit, and the legs among them already known.
 *
 * Without `local`, this is the plain edit. With it, each pinch becomes a waypoint beside
 * the edited one, and the leg reaching it from outside is cut from `local.route`. Kept legs
 * are numbered one-based, as legs are everywhere else.
 */
export function applyLocalEdit(
  anchors: Point[],
  grab: RouteGrab,
  point: Point,
  local?: { route: RouteResult; vertices: number[]; pinches: Pinches },
): { anchors: Point[]; kept: Map<number, RouteResult> } {
  const i = grab.index;
  const next = grab.kind === "move" ? i + 1 : i;
  const head = anchors.slice(0, i),
    tail = anchors.slice(next);
  const before = local?.pinches.before,
    after = local?.pinches.after;
  const middle = [
    ...(before ? [before.point] : []),
    point,
    ...(after ? [after.point] : []),
  ];
  const kept = new Map<number, RouteResult>();
  if (local && before)
    kept.set(
      head.length,
      sliceRoute(local.route, local.vertices[i - 1], before.position),
    );
  if (local && after)
    kept.set(
      head.length + middle.length,
      sliceRoute(local.route, after.position, local.vertices[next]),
    );
  return { anchors: [...head, ...middle, ...tail], kept };
}
