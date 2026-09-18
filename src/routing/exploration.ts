import { toCompiled } from "./compile";
import { distance, route } from "./engine";
import { eligible, traversalSegments } from "./eligibility";
import { edgeSignals } from "./signals";
import { STRENGTH } from "./vocabulary";
import type { Graph, Point, RouteRequest, RouteResult } from "./types";

/** A bounded destination search, layered over the positive-cost path finder. */
export function explore(
  graph: Graph,
  request: RouteRequest,
  baseline: RouteResult,
): RouteResult {
  const p = toCompiled(request.profile);
  const appetite = Math.max(0, STRENGTH[p.weights.scenic.level]);
  const budget = Math.max(0, p.detour.budget_ratio - 1.5);
  if (baseline.status !== "ok" || !appetite || !budget) return baseline;
  const started = performance.now();
  // There are no POI identities in the graph. A reward of one or more locates an
  // amenity cluster — a viewpoint, a peak, or benches, water and a guidepost together —
  // and its value is how strongly it draws (forest and gravel sources top out at .5 and
  // .7). Prefer a usable track access to it, never an unsurveyed footpath merely
  // surrounded by forest.
  const sources = graph.edges
    .filter((e) => {
      if ((e.reward ?? 0) < 1 || !eligible(e, p)) return false;
      const s = edgeSignals(e);
      return (
        (s.surfaceKnown ||
          ["residential", "unclassified", "service"].includes(e.highway)) &&
        s.roughness <= p.capability.surface_roughness.comfortable_until &&
        traversalSegments(e, p, s).every((run) => run.mode === "ride")
      );
    })
    .sort((a, b) => {
      const value = (e: typeof a) =>
        edgeSignals(e).unpaved * Math.max(0, STRENGTH[p.weights.unpaved.level]);
      return value(b) - value(a) || a.length - b.length || a.id - b.id;
    });
  const destinations: { point: Point; strength: number }[] = [];
  for (const e of sources) {
    const point = e.geometry.at(-1)!;
    const near = destinations.find((d) => distance(point, d.point) < 500);
    if (near) near.strength = Math.max(near.strength, e.reward!);
    else destinations.push({ point, strength: e.reward! });
  }
  const candidates = destinations
    .flatMap(({ point, strength }) => {
      let extra = Infinity,
        leg = 1;
      for (let i = 1; i < request.anchors.length; i++) {
        const a = request.anchors[i - 1],
          b = request.anchors[i];
        const d = distance(a, point) + distance(point, b) - distance(a, b);
        if (d < extra) {
          extra = d;
          leg = i;
        }
      }
      return [{ point, strength, leg, extra }];
    })
    .filter((c) => c.extra <= baseline.distanceM * Math.min(0.5, budget / 5))
    .sort((a, b) => a.extra - b.extra)
    .slice(0, 8);
  if (!candidates.length) return baseline;

  // Pay once for every distinct destination a route visits, never per edge or lap:
  // destinations are 500 m apart, and a candidate that retraces its way is refused below.
  // Paying only for the best one made a second highlight worth nothing, and a ride that
  // links two of them lost to one that saw either. Keep travel cost intact so diagnostics
  // still compare like with like. A richer destination is worth more: the prize scales
  // with its strength, one for a bare viewpoint and up to two for one people furnished
  // with benches, water and signs.
  const prize = (strength: number) =>
    Math.min(3000, baseline.distanceM * 0.2) *
    appetite *
    Math.min(1, budget / 2.5) *
    strength;
  const assess = (r: RouteResult): RouteResult => {
    const visited = destinations
      .filter((d) => r.geometry.some((point) => distance(point, d.point) <= 80))
      .sort((a, b) => b.strength - a.strength);
    const bonus = visited.reduce((sum, d) => sum + prize(d.strength), 0);
    return {
      ...r,
      experience: {
        score: r.cost - bonus,
        scenicBonus: bonus,
        destination: visited[0]?.point,
        candidates: 0,
      },
    };
  };
  let best = assess(baseline),
    settled = 0,
    attempted = 0;
  const limit = request.maxSettled ?? 1500000;
  for (const candidate of candidates) {
    if (settled >= limit) break;
    if (
      baseline.geometry.some((point) => distance(point, candidate.point) <= 80)
    )
      continue;
    const anchors = [...request.anchors];
    anchors.splice(candidate.leg, 0, candidate.point);
    const r = route(
      graph,
      { ...request, anchors, maxSettled: limit - settled },
      "reference",
    );
    settled += r.metrics.explored;
    attempted++;
    if (
      r.status !== "ok" ||
      r.distanceM > baseline.distanceM * (1 + Math.min(0.5, budget / 5)) ||
      r.hikeABikeM > baseline.hikeABikeM + 1
    )
      continue;
    // Going somewhere and coming back to collect a prize is not a through-going scenic
    // detour, whether it retraces its way or loops round a block to the Marais de Lissoud.
    // A shortest path never passes a point twice, so any point the route passes again was
    // brought back by the inserted destination: measure the longest such lap.
    const along = new Map<string, number>();
    let lap = 0,
      travelled = 0;
    for (let i = 0; i < r.geometry.length; i++) {
      if (i > 0) travelled += distance(r.geometry[i - 1], r.geometry[i]);
      const key = r.geometry[i].join(",");
      const first = along.get(key);
      if (first === undefined) along.set(key, travelled);
      else lap = Math.max(lap, travelled - first);
    }
    if (lap > 100) continue;
    const scored = assess(r);
    if (scored.experience!.score < best.experience!.score) best = scored;
  }
  return {
    ...best,
    anchors: baseline.anchors,
    experience: { ...best.experience!, candidates: attempted },
    metrics: {
      ...best.metrics,
      explored: baseline.metrics.explored + settled,
      durationMs: baseline.metrics.durationMs + performance.now() - started,
    },
  };
}
