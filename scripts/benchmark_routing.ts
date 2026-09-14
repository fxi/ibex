/**
 * End-to-end local pack loading plus cold/warm routing. Optional baseline module must
 * export compareOn (e.g. an isolated checkout's src/routing/legs.ts).
 * node --import tsx scripts/benchmark_routing.ts public/packs/geneva-grid [baseline-module]
 */
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { compareOn } from "../src/routing/legs";
import { loadReleaseGraph } from "./local_release";
import { loadProfile, SHIPPED_IDS } from "./profile";
import type { Point } from "../src/routing/types";

const packs = process.argv[2] ?? "public/packs/geneva-grid";
const baseline: typeof compareOn | undefined = process.argv[3]
  ? (await import(pathToFileURL(resolve(process.argv[3])).href)).compareOn
  : undefined;
const scenarios: { name: string; anchors: Point[] }[] = [
  {
    name: "geneva-voirons",
    anchors: [
      [6.151, 46.201],
      [6.37, 46.22],
    ],
  },
  {
    name: "geneva-saleve",
    anchors: [
      [6.151, 46.201],
      [6.171, 46.119],
    ],
  },
];
const report: unknown[] = [];
for (const scenario of scenarios) {
  const started = performance.now();
  const graph = await loadReleaseGraph(packs, scenario.anchors);
  const loadMs = performance.now() - started;
  const runs = [];
  if (baseline)
    for (const [name, run] of [
      ["baseline", baseline],
      ["current-legacy", compareOn],
    ] as const) {
      const start = performance.now();
      const value = run(
        graph,
        { anchors: scenario.anchors, profile: await loadProfile("gravel_50") },
        graph.bbox,
      );
      runs.push({
        name,
        ms: performance.now() - start,
        status: value.reference.status,
        distanceM: value.reference.distanceM,
        cost: value.reference.cost,
        metrics: value.reference.metrics,
      });
    }
  for (const ride of SHIPPED_IDS) {
    const profile = await loadProfile(ride);
    for (const temperature of ["cold", "warm"]) {
      const start = performance.now();
      const value = compareOn(
        graph,
        { anchors: scenario.anchors, profile },
        graph.bbox,
      ).reference;
      if (value.status !== "ok") process.exitCode = 1;
      runs.push({
        name: `${ride}-${temperature}`,
        ms: performance.now() - start,
        status: value.status,
        distanceM: value.distanceM,
        cost: value.cost,
        metrics: value.metrics,
      });
    }
  }
  const row = {
    ...scenario,
    loadMs,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    runs,
  };
  report.push(row);
  console.log(JSON.stringify(row));
}
await fs.mkdir("data/derived", { recursive: true });
await fs.writeFile(
  "data/derived/routing-refactor.json",
  JSON.stringify(
    {
      runtime: process.version,
      packs,
      kind: "desktop-local-packs-not-mobile",
      scenarios: report,
    },
    null,
    2,
  ) + "\n",
);
