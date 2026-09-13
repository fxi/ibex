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
  // Model 4 has no POI identities. A reward of one locates a viewpoint/peak source
  // neighbourhood (forest and gravel sources top out at .5 and .7). Prefer a usable
  // track access to it, never an unsurveyed footpath merely surrounded by forest.
  const sources = graph.edges
    .filter((e) => {
      if (e.reward !== 1 || !eligible(e, p)) return false;
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
  const destinations: Point[] = [];
  for (const e of sources) {
    const point = e.geometry.at(-1)!;
    if (!destinations.some((other) => distance(point, other) < 500))
      destinations.push(point);
  }
  const candidates = destinations
    .flatMap((point) => {
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
      return [{ point, leg, extra }];
    })
    .filter((c) => c.extra <= baseline.distanceM * Math.min(0.5, budget / 5))
    .sort((a, b) => a.extra - b.extra)
    .slice(0, 8);
  if (!candidates.length) return baseline;

  // Pay once per outing for its best scenic destination. Never pay per edge or lap.
  // Keep travel cost intact so diagnostics still compare like with like.
  const prize =
    Math.min(3000, baseline.distanceM * 0.2) *
    appetite *
    Math.min(1, budget / 2.5);
  const assess = (r: RouteResult): RouteResult => {
    const visited = candidates.find((c) =>
      r.geometry.some((point) => distance(point, c.point) <= 80),
    );
    return {
      ...r,
      experience: {
        score: r.cost - (visited ? prize : 0),
        scenicBonus: visited ? prize : 0,
        destination: visited?.point,
        candidates: 0,
      },
    };
  };
  let best = assess(baseline),
    settled = 0,
    attempted = 0;
  // The full-graph optimum already earned the only available prize. Every forced
  // detour costs at least as much and cannot earn more, so no extra search can win.
  if (best.experience!.scenicBonus > 0) return best;
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
    // An out-and-back to collect a prize is not a through-going scenic detour. Count
    // repeated undirected geometry spans; this survives splits at inserted anchors.
    const seen = new Set<string>();
    let repeated = 0;
    for (let i = 1; i < r.geometry.length; i++) {
      const a = r.geometry[i - 1],
        b = r.geometry[i];
      const key = [a.join(","), b.join(",")].sort().join("|");
      if (seen.has(key)) repeated += distance(a, b);
      seen.add(key);
    }
    if (repeated > 100) continue;
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
