import {
  exceedance,
  tractionGrade,
  type CapabilityProfile,
  type Threshold,
} from "../routing/capability";
import { surfaceRoughness } from "../routing/signals";
import { ENGINE } from "../routing/vocabulary";
import type { RideClass, RouteResult, RouteSegment } from "../routing/types";
import {
  LEVEL_COLORS,
  SURFACE_STYLE,
  rideTotals,
  segmentSpans,
  type Lens,
  type Level,
  type Span,
  type SegmentSpan,
} from "./rideStyle";

/**
 * What a finished route is made of, and which parts of it are going to hurt.
 *
 * All of this is derived, never stored: the router already decided where to go, and these
 * are the same facts read back for a rider rather than for the search. Keeping it pure and
 * away from React means the thresholds can be unit-tested against real profiles, which
 * matters because none of the numbers below are ours — they come from the rider's own
 * capability (see `src/routing/capability.ts`) so that the same 18% ramp is a warning on a
 * road bike and unremarkable on a trail bike.
 */

/** A stretch of route at a constant grade, as the elevation profile recorded it. */
export type GradeRun = Span & { grade: number };

/**
 * The route's grade, run by run, straight out of the elevation profile.
 *
 * `elevationProfile` is built by integrating `edge.grades`, so each consecutive pair of
 * samples already *is* one grade run — full resolution, in the distance domain, for free.
 * This is why nothing here reads `RouteSegment.grade`, which is only the grade of the
 * segment's first run and would quietly miss a short steep ramp inside a long segment.
 *
 * A `null` height is a hole in the DEM: it ends the current run rather than being bridged
 * by a gradient nobody measured.
 */
export function gradeRuns(profile: [number, number | null][]): GradeRun[] {
  const runs: GradeRun[] = [];
  for (let i = 1; i < profile.length; i++) {
    const [startM, from] = profile[i - 1];
    const [endM, to] = profile[i];
    if (from === null || to === null) continue;
    const span = endM - startM;
    // Every edge restarts the profile from its start node's DEM height, while the edge
    // before it ended at a height integrated from its grade runs. The two sit a few
    // millimetres apart and disagree by up to a metre or so, which read as a slope is
    // thousands of percent. That pair is a seam between edges, not ground.
    if (span < JUNCTION_M) continue;
    const grade = (to - from) / span;
    // The builder never emits a grade past its clamp, so anything steeper is a seam too.
    if (Math.abs(grade) > MAX_GRADE) continue;
    runs.push({ startM, endM, grade });
  }
  return runs;
}

/** Closer than this, two profile samples are an edge seam rather than a grade run. */
export const JUNCTION_M = 1;
/** The steepest grade the builder emits (`CLAMP` in `scripts/terrain_profile.py`). */
export const MAX_GRADE = 0.45;

/** Something worth marking along the profile: a warning's start, or a waypoint. */
export type Pin = { meters: number; kind: "warning" | "waypoint" };
/** One drawn mark, standing for `count` pins too close together to draw separately. */
export type PinMark = Pin & { count: number };

/**
 * Collapse pins that would land on top of each other into one mark.
 *
 * The profile is 280 user units wide however long the route is, so on a 600 km ride two
 * warnings a kilometre apart are the same half-pixel. Drawing both is just a smudge; one
 * mark that admits it stands for several is honest and legible. A warning outranks a
 * waypoint in a merge: the waypoint is where the rider chose to go, the warning is the
 * thing they would rather not discover on arrival.
 */
export function pinMarks(pins: Pin[], gapM: number): PinMark[] {
  const marks: PinMark[] = [];
  for (const pin of [...pins].sort((a, b) => a.meters - b.meters)) {
    const last = marks[marks.length - 1];
    if (last && pin.meters - last.meters <= gapM) {
      last.count += 1;
      if (pin.kind === "warning") last.kind = "warning";
      continue;
    }
    marks.push({ ...pin, count: 1 });
  }
  return marks;
}

/**
 * The stretch a window covers, clamped to the route: `[from, to]` in metres.
 *
 * Shared by the chart's own scale and by the pointer mapping below. Those two clamping the
 * same window even slightly differently would put a click a little away from where the
 * rider pressed, which is the kind of thing nobody reports and everybody feels.
 */
export function windowRange(
  distanceM: number,
  window?: Span,
): [number, number] {
  const end = Math.max(1, distanceM);
  if (!window) return [0, end];
  const from = Math.max(0, Math.min(window.startM, end));
  return [from, Math.max(from + 1, Math.min(window.endM, end))];
}

/**
 * The distance a pointer sitting `offsetX` across a `width`-wide chart is over, in metres.
 *
 * The inverse of `profileGeometry`'s `x`, window included — which is why it is not written
 * inline at the call site: while a window is active the mapping runs against the visible
 * stretch, and reading it against the whole route instead would silently misplace a click.
 */
export function metersAtX(
  offsetX: number,
  width: number,
  distanceM: number,
  window?: Span,
): number {
  const [from, to] = windowRange(distanceM, window);
  if (width <= 0) return from;
  const t = Math.max(0, Math.min(1, offsetX / width));
  return from + t * (to - from);
}

/** The SVG box a profile is drawn into, in user units. */
export type ProfileBox = { w: number; h: number; top: number; base: number };
export type ProfileGeometry = {
  /** One path per run of known terrain, so a DEM gap breaks the curve. */
  lines: string[];
  /** The same runs closed down to the baseline, for filling and clipping. */
  areas: string[];
  min: number;
  max: number;
  x: (meters: number) => number;
  y: (height: number) => number;
};

/**
 * The elevation curve as path strings, with the scales that produced them.
 *
 * Lifted out of the chart component so the fiddly part — where a gap in the DEM breaks a
 * path, how the height scale handles a flat route — can be tested in Node, and so a band
 * drawn under the curve uses exactly the same `x` as the curve itself. Returns null when
 * there is not enough known terrain to draw anything.
 */
export function profileGeometry(
  profile: [number, number | null][],
  distanceM: number,
  box: ProfileBox,
  window?: Span,
): ProfileGeometry | null {
  // A window redraws the chart over that stretch alone: the height range is taken from
  // what is visible, so zooming into a flat valley inside an alpine ride actually shows
  // the valley's shape instead of a straight line at the bottom of the Alps.
  const [from, to] = windowRange(distanceM, window);
  // Samples come from grade runs and can sit far apart, so a narrow window may contain
  // none of them. Interpolating its edges means a window always draws the ground it covers
  // instead of going blank between two samples. A null edge is a real gap and stays out.
  let visible = profile;
  if (window) {
    const inside = profile.filter(([meters]) => meters >= from && meters <= to);
    const startHeight = heightAtM(profile, from);
    const endHeight = heightAtM(profile, to);
    visible = [
      ...(startHeight !== null && inside[0]?.[0] !== from
        ? [[from, startHeight] as [number, number | null]]
        : []),
      ...inside,
      ...(endHeight !== null && inside.at(-1)?.[0] !== to
        ? [[to, endHeight] as [number, number | null]]
        : []),
    ];
  }
  const known = visible.filter((p): p is [number, number] => p[1] !== null);
  if (known.length < 2) return null;
  const min = known.reduce((m, p) => Math.min(m, p[1]), Infinity);
  const max = known.reduce((m, p) => Math.max(m, p[1]), -Infinity);
  const span = Math.max(1, to - from);
  const x = (meters: number) => ((meters - from) / span) * box.w;
  // A 20 m floor on the height range keeps a flat route from being drawn as a mountain of
  // rounding noise.
  const y = (height: number) =>
    box.base -
    ((height - min) / Math.max(20, max - min)) * (box.base - box.top);

  const lines: string[] = [];
  const areas: string[] = [];
  let line = "";
  let start: [number, number] | undefined;
  let last: [number, number] | undefined;
  const flush = () => {
    if (line && start && last)
      areas.push(
        `${line} L${x(last[0]).toFixed(1)},${box.base} L${x(start[0]).toFixed(1)},${box.base} Z`,
      );
    if (line) lines.push(line);
    line = "";
    start = undefined;
  };
  for (const [meters, height] of visible) {
    if (height === null) {
      flush();
      continue;
    }
    const point: [number, number] = [meters, height];
    line += `${line ? " L" : "M"}${x(meters).toFixed(1)},${y(height).toFixed(1)}`;
    start ??= point;
    last = point;
  }
  flush();
  return { lines, areas, min, max, x, y };
}

/** A stretch of the route tinted by how much of one signal it carries. */
export type LaneBand = Span & { color: string; label: string };

/**
 * Where a gradient sits between comfortable and pushing, in the rider's own terms.
 *
 * Level 1 is past comfortable, 2 the upper half of the way to the grade where the
 * capability model stops the pedals, and 3 that grade and beyond: the router would have
 * the rider walking. Linear in the grade rather than in `exceedance`, whose fourth power
 * would put nearly every band in the last step, so the legend can print plain percentages.
 */
export function steepLevel(value: number, t: Threshold): Level {
  if (value <= t.comfortable_until) return 0;
  const over =
    (value - t.comfortable_until) /
    Math.max(1e-6, t.high_cost_at - t.comfortable_until);
  return over >= 1 ? 3 : over > 0.5 ? 2 : 1;
}

/** The grade at which each steepness level starts, on ordinary ground. */
export function steepSteps(t: Threshold): [number, number, number] {
  return [
    t.comfortable_until,
    (t.comfortable_until + t.high_cost_at) / 2,
    t.high_cost_at,
  ];
}

export type SteepRun = GradeRun & { level: Level; uphill: boolean };

/**
 * Every grade run with how hard it is for this rider, the ground under it included.
 *
 * Read from the grade runs rather than the segments, so a short ramp inside a long segment
 * still shows. The router charges a climb against the ground under it, so this has to as
 * well or the chart quietly disagrees with the line it is drawing: `elevationProfile` is
 * metres and height and knows nothing about surfaces, so the roughness comes from the
 * segment the run sits in. With no segments — a synthetic profile, or a route stored
 * before segments carried roughness — this falls back to the untouched threshold.
 */
export function steepRuns(
  profile: [number, number | null][],
  capability: CapabilityProfile,
  segments: RouteSegment[] = [],
  distanceM = 0,
): SteepRun[] {
  const spans = segmentSpans(segments, distanceM);
  const roughnessAt = (startM: number, endM: number) => {
    const middle = (startM + endM) / 2;
    const span = spans.find((s) => middle >= s.startM && middle <= s.endM);
    return span?.segment.roughness;
  };
  return gradeRuns(profile).map((run) => {
    const uphill = run.grade > 0;
    const roughness = roughnessAt(run.startM, run.endM);
    const threshold = !uphill
      ? capability.downhill_grade
      : roughness === undefined || !Number.isFinite(roughness)
        ? capability.uphill_grade
        : tractionGrade(
            capability.uphill_grade,
            roughness,
            true,
            capability.surface_roughness,
          );
    return {
      ...run,
      uphill,
      level: steepLevel(uphill ? run.grade : -run.grade, threshold),
    };
  });
}

/** Shorter than this, a change of steepness level is texture, not something to draw. */
export const LEVEL_MIN_M = 50;

/**
 * Level stretches as they are worth drawing: a calm gap shorter than `minM` between two
 * steeper stretches takes the milder of them, an isolated steep blip that short takes the
 * steeper of its neighbours, and what is left is joined. The DEM's runs are a few metres
 * long, so drawn raw a steady climb is a string of dashes; the kilometres in the
 * composition are counted from the raw runs, never from this.
 */
export function smoothLevels<T extends Span & { level: Level }>(
  runs: T[],
  minM = LEVEL_MIN_M,
): (Span & { level: Level })[] {
  const spans = runs.map((r) => ({
    startM: r.startM,
    endM: r.endM,
    level: r.level,
  }));
  for (let i = 1; i + 1 < spans.length; i++) {
    const [before, span, after] = [spans[i - 1], spans[i], spans[i + 1]];
    if (span.endM - span.startM >= minM) continue;
    if (before.level > span.level && after.level > span.level)
      span.level = Math.min(before.level, after.level) as Level;
    else if (before.level < span.level && after.level < span.level)
      span.level = Math.max(before.level, after.level) as Level;
  }
  const joined: (Span & { level: Level })[] = [];
  for (const span of spans) {
    const last = joined.at(-1);
    if (last && last.level === span.level && span.startM - last.endM < minM)
      last.endM = span.endM;
    else joined.push(span);
  }
  return joined;
}

/**
 * Where the route is steeper than this rider is comfortable with, warm where it is worse.
 *
 * Nothing is painted below `comfortable_until`: an empty lane means the route is within
 * the rider's range, which is a more useful thing to see than a wash of colour.
 */
export function steepLaneBands(
  profile: [number, number | null][],
  capability: CapabilityProfile,
  segments: RouteSegment[] = [],
  distanceM = 0,
): LaneBand[] {
  const runs = steepRuns(profile, capability, segments, distanceM);
  // The label names the steepest grade inside each drawn stretch.
  const steepestIn = (span: Span) => {
    let worst = runs[0];
    for (const run of runs)
      if (
        run.endM > span.startM &&
        run.startM < span.endM &&
        run.level > 0 &&
        (!worst || Math.abs(run.grade) > Math.abs(worst.grade))
      )
        worst = run;
    return worst;
  };
  return smoothLevels(runs)
    .filter((span) => span.level > 0)
    .map((span) => {
      const worst = steepestIn(span);
      return {
        startM: span.startM,
        endM: span.endM,
        color: LEVEL_COLORS[span.level as 1 | 2 | 3],
        label: `${Math.round(Math.abs(worst.grade) * 100)}% ${worst.uphill ? "climb" : "descent"}`,
      };
    });
}

/**
 * How busy a road is, from the engine's traffic stress.
 *
 * Nothing at or below `ENGINE.traffic_from` — the tertiary-level stress below which the
 * cost model leaves traffic to preference alone — so a clean line means genuinely calm
 * rather than merely below some house threshold. Above it, stress is read off road class
 * (`STRESS_BY_HIGHWAY` in `src/build/graph.ts`: secondary 0.8, primary 0.95), so the steps
 * fall between the classes: a signed primary is moderate, a secondary busy, a primary very
 * busy. `Number.isFinite` guards a route computed before segments carried stress.
 */
export function trafficLevel(stress: number): Level {
  if (!Number.isFinite(stress) || stress <= ENGINE.traffic_from) return 0;
  return stress >= 0.9 ? 3 : stress >= 0.7 ? 2 : 1;
}
export const TRAFFIC_LABELS: Record<Level, string> = {
  0: "Calm",
  1: "Moderate",
  2: "Busy",
  3: "Very busy",
};

/** Where the route runs busier than a quiet departmental road, warm where it is worse. */
export function stressLaneBands(
  segments: RouteSegment[],
  distanceM: number,
): LaneBand[] {
  const bands: LaneBand[] = [];
  for (const { segment, startM, endM } of segmentSpans(segments, distanceM)) {
    const level = trafficLevel(segment.stress);
    if (!level) continue;
    bands.push({
      startM,
      endM,
      color: LEVEL_COLORS[level],
      label: `${Math.round(segment.stress * 100)}% traffic stress`,
    });
  }
  return bands;
}

/** One line of a lens's composition: a level, what it is called, and how much of the ride. */
export type LensEntry = {
  level: Level | "unknown";
  label: string;
  meters: number;
  share: number;
};

const shares = (
  totals: Map<Level | "unknown", number>,
  labels: Record<Level | "unknown", string>,
  distanceM: number,
): LensEntry[] => {
  const total = [...totals.values()].reduce((sum, m) => sum + m, 0);
  if (!total || !distanceM) return [];
  const scale = distanceM / total;
  return ([0, 1, 2, 3, "unknown"] as const)
    .filter((level) => (totals.get(level) ?? 0) > 0)
    .map((level) => {
      const meters = (totals.get(level) ?? 0) * scale;
      return {
        level,
        label: labels[level],
        meters,
        share: meters / distanceM,
      };
    });
};

const pct = (grade: number) => `${Math.round(grade * 100)}`;

/**
 * How much of the route climbs within each steepness level, with the levels named by this
 * rider's own gradients: "≤ 6%" on a loaded tourer is "≤ 11%" on a light climber. The
 * percentages are the ordinary-ground ones; loose ground lowers them, as it lowers what the
 * router lets the rider ride. Stretches with no terrain data are counted apart.
 */
export function steepComposition(
  route: RouteResult,
  capability: CapabilityProfile,
): LensEntry[] {
  const totals = new Map<Level | "unknown", number>();
  let measured = 0;
  for (const run of steepRuns(
    route.elevationProfile,
    capability,
    route.segments,
    route.distanceM,
  )) {
    const length = run.endM - run.startM;
    measured += length;
    totals.set(run.level, (totals.get(run.level) ?? 0) + length);
  }
  // Seams between edges are skipped as runs; only a real hole in the DEM is worth a line.
  if (route.distanceM - measured > 100)
    totals.set("unknown", route.distanceM - measured);
  const [c, m, h] = steepSteps(capability.uphill_grade);
  return shares(
    totals,
    {
      0: `≤ ${pct(c)}%`,
      1: `${pct(c)}–${pct(m)}%`,
      2: `${pct(m)}–${pct(h)}%`,
      3: `≥ ${pct(h)}% · push`,
      unknown: "No terrain data",
    },
    route.distanceM,
  );
}

/** How much of the route runs on roads of each traffic level. */
export function trafficComposition(route: RouteResult): LensEntry[] {
  const totals = new Map<Level | "unknown", number>();
  for (const s of route.segments) {
    const level = Number.isFinite(s.stress)
      ? trafficLevel(s.stress)
      : "unknown";
    totals.set(level, (totals.get(level) ?? 0) + s.lengthM);
  }
  return shares(
    totals,
    { ...TRAFFIC_LABELS, unknown: "Traffic unknown" },
    route.distanceM,
  );
}

/**
 * How far along the route a geometry vertex sits, in metres.
 *
 * Waypoints are addressed by vertex (`anchorVertices`) while everything a rider reads is in
 * metres, so this is the bridge. Interpolating inside the segment that contains the vertex
 * keeps it consistent with `segmentSpans`, which is the only place the two domains are
 * reconciled.
 */
export function metersAtVertex(
  segments: RouteSegment[],
  distanceM: number,
  vertex: number,
): number {
  const spans = segmentSpans(segments, distanceM);
  if (!spans.length) return 0;
  for (const { segment, startM, endM } of spans) {
    if (vertex < segment.start || vertex > segment.end) continue;
    const vertices = segment.end - segment.start;
    const t = vertices > 0 ? (vertex - segment.start) / vertices : 0;
    return startM + (endM - startM) * t;
  }
  // Off both ends: a vertex before the first segment is the start, anything else the finish.
  return vertex <= spans[0].segment.start ? 0 : distanceM;
}

/**
 * The geometry vertex at a distance along the route, fractional between vertices.
 *
 * The inverse of `metersAtVertex`, and it walks the same rescaled spans rather than the raw
 * segment lengths: reading the two domains differently would land a located point a little
 * off the band the rider actually pointed at. Feed the result to `pointAt` for coordinates.
 */
export function vertexAtM(
  segments: RouteSegment[],
  distanceM: number,
  meters: number,
): number {
  const spans = segmentSpans(segments, distanceM);
  if (!spans.length) return 0;
  for (const { segment, startM, endM } of spans) {
    if (meters < startM || meters > endM) continue;
    const width = endM - startM;
    const t = width > 0 ? (meters - startM) / width : 0;
    return segment.start + (segment.end - segment.start) * t;
  }
  return meters <= spans[0].startM
    ? spans[0].segment.start
    : spans.at(-1)!.segment.end;
}

/**
 * The route's height at a distance, or null where the terrain is unknown.
 *
 * `sliceRoute` has its own copy of this as a closure over one route; this is the same
 * reading as a plain function so a waypoint row can ask for one height without slicing
 * anything. Null rather than a guess: a hole in the DEM is not sea level.
 */
export function heightAtM(
  profile: [number, number | null][],
  meters: number,
): number | null {
  for (let i = 1; i < profile.length; i++) {
    const [fromM, from] = profile[i - 1];
    const [toM, to] = profile[i];
    if (meters < fromM || meters > toM) continue;
    if (from === null || to === null) return null;
    return toM > fromM
      ? from + ((to - from) * (meters - fromM)) / (toM - fromM)
      : to;
  }
  return null;
}

export type CompositionEntry = {
  ride: RideClass;
  label: string;
  meters: number;
  /** Fraction of the route, 0..1. Shares across the entries sum to 1. */
  share: number;
};

/**
 * How much of the route rode as each surface class.
 *
 * Built from `rideTotals`, deliberately not from `RouteResult.surfaceM`: that record is
 * keyed by the raw OSM `surface` string and attributes a whole edge to it, so it neither
 * agrees with the classes the map draws nor sums to the route's distance. Metres are
 * rescaled to `distanceM` for the same reason `segmentSpans` rescales, so the listed
 * kilometres add up to the distance shown beside them.
 *
 * Ordered by `SURFACE_STYLE` rather than by size, so the legend, the map and the Legend tab
 * always list the classes in the same order.
 */
export function composition(
  segments: RouteSegment[],
  distanceM: number,
): CompositionEntry[] {
  const totals = rideTotals(segments);
  const total = [...totals.values()].reduce((sum, m) => sum + m, 0);
  if (!total || !distanceM) return [];
  const scale = distanceM / total;
  return SURFACE_STYLE.filter((s) => (totals.get(s.ride) ?? 0) > 0).map((s) => {
    const meters = (totals.get(s.ride) ?? 0) * scale;
    return {
      ride: s.ride,
      label: s.label,
      meters,
      share: meters / distanceM,
    };
  });
}

/**
 * How much a section is going to cost the rider, in three rungs.
 *
 * The boundaries are the engine's, not ours. `exceedance` reads 0 at the rider's
 * `comfortable_until` and 1 at their `high_cost_at`, and 1 is exactly where `segmentMode`
 * stops pedalling and starts pushing — so "hard" means *the router thinks you would be off
 * the bike*. "severe" sits a quarter further up the straightened ramp beyond that.
 *
 * Total by design: callers filter on `exceedance > 0` before asking, because below that
 * there is nothing to report at all.
 */
export type Severity = "caution" | "hard" | "severe";
const SEVERITY_ORDER: Severity[] = ["caution", "hard", "severe"];

export function severityOf(value: number): Severity {
  return value >= 2 ? "severe" : value >= 1 ? "hard" : "caution";
}

const worseOf = (a: Severity, b: Severity): Severity =>
  SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;

/**
 * Don't report a thirty-metre ramp, and don't shred one climb into eleven rows.
 *
 * These two are the only invented numbers in this file. They are reporting hygiene rather
 * than physics: everything that decides *whether* a stretch is hard comes from the rider's
 * capability, and these only decide what is worth a line of its own.
 */
export const WARNING_MIN_M = 120;
export const WARNING_GAP_M = 200;
/** A crossing or a short link is not a traffic warning; a stretch ridden along one is. */
export const TRAFFIC_MIN_M = 500;

/**
 * Join spans separated by less than `gapM` into one, keeping what they were made of.
 *
 * Expects spans ordered by `startM`, which both `segmentSpans` and `gradeRuns` guarantee.
 */
export function mergeSpans<T extends Span>(
  spans: T[],
  gapM: number,
): (Span & { parts: T[] })[] {
  const merged: (Span & { parts: T[] })[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.startM - last.endM <= gapM) {
      last.endM = Math.max(last.endM, span.endM);
      last.parts.push(span);
    } else merged.push({ startM: span.startM, endM: span.endM, parts: [span] });
  }
  return merged;
}

export type WarningKind = "walk" | "rough" | "steep" | "traffic";
export type Warning = Span & {
  kind: WarningKind;
  /** The lens the warning belongs to, so each lens lists what it draws. */
  lens: Lens;
  severity: Severity;
  headline: string;
  detail: string;
};

const km = (meters: number) => (meters / 1000).toFixed(1);
const percent = (grade: number) => `${Math.round(Math.abs(grade) * 100)}%`;

/** The steepest grade anywhere inside a span, uphill and downhill kept apart. */
function steepestIn(runs: GradeRun[], span: Span, uphill: boolean): number {
  let worst = 0;
  for (const run of runs) {
    if (run.endM <= span.startM || run.startM >= span.endM) continue;
    const grade = uphill ? run.grade : -run.grade;
    if (grade > worst) worst = grade;
  }
  return worst;
}

/**
 * The sections of this route worth warning a rider about, worst first.
 *
 * Hike-a-bike is filed under what caused it: a push the gradient forces is a steepness
 * warning, steps or ground past the rider's handling a surface one. The segment does not
 * record why the router got off, so the cause is read back the same way it decided: a
 * section with a grade at or past the rider's walking grade was pushed for the slope.
 *
 * Otherwise four kinds only. `unknown` surface is left out because it is a confidence
 * rather than a hazard — the route's uncertain share says that better — and a ferry is
 * left out because with no duration model anywhere in the app, "check the timetable" is
 * the only honest thing to say about one, and that is not a warning.
 */
export function routeWarnings(
  route: RouteResult,
  capability: CapabilityProfile,
): Warning[] {
  const segments = route.segments;
  const spans = segmentSpans(segments, route.distanceM);
  const runs = gradeRuns(route.elevationProfile);
  const warnings: Warning[] = [];

  const sectionsOf = (matching: SegmentSpan[]) =>
    mergeSpans(matching, WARNING_GAP_M).filter(
      (s) => s.endM - s.startM >= WARNING_MIN_M,
    );

  // Pushing. The router already judged this unrideable, so it starts at `hard` however
  // gentle the ground looks; a steep carry is worse again.
  for (const section of sectionsOf(
    spans.filter((s) => s.segment.ride === "walk"),
  )) {
    const up = steepestIn(runs, section, true);
    const down = steepestIn(runs, section, false);
    const steps = section.parts.some((p) => p.segment.highway === "steps");
    const slope =
      !steps &&
      (exceedance(up, capability.uphill_grade) >= 1 ||
        exceedance(down, capability.downhill_grade) >= 1);
    const severity = worseOf(
      "hard",
      severityOf(exceedance(up, capability.uphill_grade)),
    );
    warnings.push({
      startM: section.startM,
      endM: section.endM,
      kind: "walk",
      lens: slope ? "steep" : "surface",
      severity,
      headline: "Hike-a-bike",
      detail:
        `${km(section.endM - section.startM)} km pushing` +
        (steps
          ? " · steps"
          : slope
            ? ` · up to ${percent(up >= down ? up : down)}`
            : " · ground past your handling"),
    });
  }

  // Broken ground, judged against this rider's tyres and suspension rather than a fixed
  // idea of rough: the same gravel is a warning on 28 mm and the point of the ride on 60.
  //
  // The router's own roughness where the route carries it, since that is the number the
  // ride was priced with. `surfaceRoughness` reads `surface` alone and so disagrees on
  // exactly the ways that matter — a `track` with a `tracktype` and no `surface`. A route
  // stored before segments carried roughness falls back to the old reading.
  const roughnessOf = (s: SegmentSpan) =>
    Number.isFinite(s.segment.roughness)
      ? s.segment.roughness
      : surfaceRoughness(s.segment.surface, s.segment.highway);
  const roughSpans = spans.filter((s) => {
    if (s.segment.ride !== "rough") return false;
    return exceedance(roughnessOf(s), capability.surface_roughness) > 0;
  });
  for (const section of sectionsOf(roughSpans)) {
    const worst = section.parts.reduce(
      (max, part) => Math.max(max, roughnessOf(part)),
      0,
    );
    warnings.push({
      startM: section.startM,
      endM: section.endM,
      kind: "rough",
      lens: "surface",
      severity: severityOf(exceedance(worst, capability.surface_roughness)),
      headline: "Rough surface",
      detail: `${km(section.endM - section.startM)} km of broken ground`,
    });
  }

  // Gradient, both ways. A steep descent is the same data as a steep climb and is the thing
  // riders most want flagged when the surface under it is loose.
  for (const uphill of [true, false]) {
    const threshold = uphill
      ? capability.uphill_grade
      : capability.downhill_grade;
    const steep = runs.filter(
      (run) =>
        exceedance(uphill ? run.grade : -run.grade, threshold) > 0 &&
        (uphill ? run.grade > 0 : run.grade < 0),
    );
    for (const section of mergeSpans(steep, WARNING_GAP_M).filter(
      (s) => s.endM - s.startM >= WARNING_MIN_M,
    )) {
      const worst = steepestIn(section.parts, section, uphill);
      warnings.push({
        startM: section.startM,
        endM: section.endM,
        kind: "steep",
        lens: "steep",
        severity: severityOf(exceedance(worst, threshold)),
        headline: uphill ? "Steep climb" : "Steep descent",
        detail: `${km(section.endM - section.startM)} km · up to ${percent(worst)}`,
      });
    }
  }

  // Busy roads. Busy is a caution and very busy hard: traffic is a preference the router
  // weighs, not a limit the rider meets, so it never reaches severe.
  const busy = spans.filter((s) => trafficLevel(s.segment.stress) >= 2);
  for (const section of mergeSpans(busy, WARNING_GAP_M).filter(
    (s) => s.endM - s.startM >= TRAFFIC_MIN_M,
  )) {
    const worst = Math.max(
      ...section.parts.map((p) => trafficLevel(p.segment.stress)),
    );
    const roads = [...new Set(section.parts.map((p) => p.segment.highway))]
      .map((h) => h.replace("_link", ""))
      .filter((h, i, all) => all.indexOf(h) === i);
    warnings.push({
      startM: section.startM,
      endM: section.endM,
      kind: "traffic",
      lens: "traffic",
      severity: worst >= 3 ? "hard" : "caution",
      headline: worst >= 3 ? "Very busy road" : "Busy road",
      detail: `${km(section.endM - section.startM)} km on ${roads.join(", ")} roads`,
    });
  }

  return warnings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) ||
      a.startM - b.startM,
  );
}
