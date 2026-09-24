/**
 * The centre line a track carries under the steepness and traffic lenses.
 *
 * Colour stays identity: the track keeps its own line, and the lens rides along its middle
 * the way the surface centre line does — nothing where the going is fine, a warm line where
 * it is not. Built once per route, lens and profile, because syncSources runs on every
 * change the map draws and a long ride has thousands of grade runs.
 */
import type { CapabilityProfile } from "../routing/capability";
import { pointAt } from "../routing/localEdit";
import { distance } from "../geo/distance";
import type { Point, RouteResult } from "../routing/types";
import {
  LEVEL_COLORS,
  segmentSpans,
  type Lens,
  type Level,
  type RideMeta,
} from "./rideStyle";
import { smoothLevels, steepRuns, trafficLevel } from "./routeStats";

export type LensFeature = {
  type: "Feature";
  properties: RideMeta & { color: string; level: Level };
  geometry: { type: "LineString"; coordinates: Point[] };
};

/**
 * Metres along the route to a fractional geometry vertex, by binary search.
 *
 * Walks the same rescaled segment spans as `vertexAtM`, so a band starts on the map where
 * the chart draws it; `vertexAtM` itself rebuilds the spans on every call, which is fine for
 * one tap and far too slow for every band of a long ride. A route with no segments — an
 * imported recording — is measured along its own geometry instead.
 */
export function vertexLookup(route: RouteResult): (meters: number) => number {
  const spans = segmentSpans(route.segments, route.distanceM);
  if (spans.length) {
    return (meters) => {
      let lo = 0,
        hi = spans.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid].endM < meters) lo = mid + 1;
        else hi = mid;
      }
      const { segment, startM, endM } = spans[lo];
      const t =
        endM > startM
          ? Math.max(0, Math.min(1, (meters - startM) / (endM - startM)))
          : 0;
      return segment.start + (segment.end - segment.start) * t;
    };
  }
  const g = route.geometry;
  const along = new Float64Array(g.length);
  for (let i = 1; i < g.length; i++)
    along[i] = along[i - 1] + distance(g[i - 1], g[i]);
  const scale =
    along[g.length - 1] > 0 ? route.distanceM / along[g.length - 1] : 1;
  return (meters) => {
    const m = meters / scale;
    let lo = 0,
      hi = g.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (along[mid] <= m) lo = mid;
      else hi = mid - 1;
    }
    if (lo >= g.length - 1) return g.length - 1;
    const span = along[lo + 1] - along[lo];
    return lo + (span > 0 ? (m - along[lo]) / span : 0);
  };
}

/** The route between two fractional vertices. */
function between(geometry: Point[], from: number, to: number): Point[] {
  const inner = geometry.slice(Math.floor(from) + 1, Math.ceil(to));
  return [pointAt(geometry, from), ...inner, pointAt(geometry, to)];
}

/** Consecutive stretches at one level, joined, so the line has clean joins. */
function merged(
  spans: { from: number; to: number; level: Level }[],
): { from: number; to: number; level: Level }[] {
  const out: { from: number; to: number; level: Level }[] = [];
  for (const span of spans) {
    if (!span.level) continue;
    const last = out.at(-1);
    if (last && last.level === span.level && span.from - last.to < 1e-6)
      last.to = span.to;
    else out.push({ ...span });
  }
  return out;
}

export function lensFeatures(
  route: RouteResult,
  lens: Lens,
  capability: CapabilityProfile | undefined,
  meta: RideMeta,
): LensFeature[] {
  let spans: { from: number; to: number; level: Level }[] = [];
  if (lens === "traffic")
    spans = merged(
      route.segments.map((s) => ({
        from: s.start,
        to: s.end,
        level: trafficLevel(s.stress),
      })),
    );
  else if (lens === "steep" && capability) {
    const vertexAt = vertexLookup(route);
    spans = merged(
      smoothLevels(
        steepRuns(
          route.elevationProfile,
          capability,
          route.segments,
          route.distanceM,
        ),
      ).map((span) => ({
        from: span.startM,
        to: span.endM,
        level: span.level,
      })),
    ).map((s) => ({ ...s, from: vertexAt(s.from), to: vertexAt(s.to) }));
  }
  return spans
    .filter((s) => s.to > s.from)
    .map((s) => ({
      type: "Feature",
      properties: {
        ...meta,
        level: s.level,
        color: LEVEL_COLORS[s.level as 1 | 2 | 3],
      },
      geometry: {
        type: "LineString",
        coordinates: between(route.geometry, s.from, s.to),
      },
    }));
}
