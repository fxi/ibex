/**
 * Measure the per-signal distribution across a real graph.
 *
 * `REFERENCE` in `src/routing/vocabulary.ts` has to sit near each signal's median or the
 * preference scores collapse into a narrow band, and `NET_SCALE` has to match the spread
 * of `net` that real edges actually reach. Both are calibrations, not constants of
 * nature: re-run this whenever the builder changes how a signal is derived.
 *
 *   npx tsx scripts/audit_signals.ts [graph.json|fixture] [profile-id]
 */
import fs from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { eligible } from "../src/routing/eligibility";
import { scoreEdge, total } from "../src/routing/engine";
import { edgeSignals, scenicValue } from "../src/routing/signals";
import { REFERENCE } from "../src/routing/vocabulary";
import type { Graph } from "../src/routing/types";
import { loadProfile } from "./profile";

const source = process.argv[2] ?? "tests/fixtures/voirons-graph.json.gz";
const profile = await loadProfile(process.argv[3] ?? "gravel_40");
const raw = await fs.readFile(source);
const graph: Graph = JSON.parse(
  (source.endsWith(".gz") ? gunzipSync(raw) : raw).toString(),
);

const edges = graph.edges.filter((e) => eligible(e, profile) && e.length > 20);
const quantiles = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const q = (f: number) => s[Math.floor(f * (s.length - 1))];
  return {
    p05: q(0.05),
    p25: q(0.25),
    p50: q(0.5),
    p75: q(0.75),
    p95: q(0.95),
  };
};

const columns: Record<string, number[]> = {
  traffic_stress: [],
  unpaved: [],
  roughness: [],
  technicality: [],
  scenic: [],
  urbanity: [],
  cycle_infrastructure: [],
};
const rates: number[] = [];
for (const e of edges) {
  const s = edgeSignals(e);
  columns.traffic_stress.push(e.stress);
  columns.unpaved.push(s.unpaved);
  columns.roughness.push(s.roughness);
  columns.technicality.push(Math.max(s.technicalUp, s.technicalDown));
  columns.scenic.push(scenicValue(e));
  columns.urbanity.push(e.urban ?? 0);
  columns.cycle_infrastructure.push(e.cyclingNetwork ?? 0);
  rates.push(total(scoreEdge(e, profile)) / e.length);
}

const fmt = (n: number) => n.toFixed(2).padStart(5);
console.log(`${source} · ${profile.id} · ${edges.length} edges\n`);
console.log(
  "signal                  p05   p25   p50   p75   p95     ref   drift",
);
for (const [key, values] of Object.entries(columns)) {
  const q = quantiles(values);
  const ref = REFERENCE[key as keyof typeof REFERENCE];
  console.log(
    `${key.padEnd(22)}${fmt(q.p05)} ${fmt(q.p25)} ${fmt(q.p50)} ${fmt(q.p75)} ${fmt(q.p95)}   ${fmt(ref)}   ${fmt(q.p50 - ref)}`,
  );
}
const r = quantiles(rates);
console.log(
  `\nrate per metre          ${fmt(r.p05)} ${fmt(r.p25)} ${fmt(r.p50)} ${fmt(r.p75)} ${fmt(r.p95)}`,
);
console.log(
  `floor for this profile  ${fmt(1 / Number(process.env.BUDGET ?? 2.5))}  (the rate an ideal way would reach; real ways sit above it, since\n                        no way is ideal on every signal, and lacking an avoided defect is\n                        credited at REWARD_SHARE)`,
);
