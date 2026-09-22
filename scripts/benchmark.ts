import fs from "node:fs/promises";
import { route } from "../src/routing/engine";
import type { Point } from "../src/routing/types";
import { DEFAULT_CELLS, loadReleaseGraph } from "./local_cells";
import { loadProfile } from "./profile";
const scenarios: { name: string; anchors: Point[] }[] = [
  {
    name: "geneva-saleve",
    anchors: [
      [6.151, 46.201],
      [6.171, 46.119],
    ],
  },
  {
    name: "geneva-voirons",
    anchors: [
      [6.151, 46.201],
      [6.37, 46.22],
    ],
  },
  {
    name: "arve",
    anchors: [
      [6.146, 46.189],
      [6.235, 46.177],
    ],
  },
];
// Scenarios span two cells; merge the release's packs around all of them.
const graph = await loadReleaseGraph(
  process.argv[2] ?? DEFAULT_CELLS,
  scenarios.flatMap((s) => s.anchors),
);
const report = [];
for (const scenario of scenarios)
  for (const id of ["gravel_40", "road_28", "touring_45"]) {
    const profile = await loadProfile(id);
    const request = { anchors: scenario.anchors, profile };
    const reference = route(graph, request, "reference");
    const corridor = route(graph, request, "corridor");
    const row = {
      scenario: scenario.name,
      profile: id,
      reference: {
        status: reference.status,
        cost: reference.cost,
        distanceM: reference.distanceM,
        ...reference.metrics,
      },
      corridor: {
        status: corridor.status,
        cost: corridor.cost,
        distanceM: corridor.distanceM,
        ...corridor.metrics,
      },
      relativeCost: reference.cost ? corridor.cost / reference.cost - 1 : null,
    };
    report.push(row);
    console.log(JSON.stringify(row));
    if (reference.status !== "ok" || corridor.status !== "ok")
      process.exitCode = 1;
  }
await fs.mkdir(".cache/derived", { recursive: true });
await fs.writeFile(
  ".cache/derived/benchmark.json",
  JSON.stringify(
    {
      runtime: process.version,
      kind: "desktop-resident-graph-search",
      scenarios: report,
    },
    null,
    2,
  ),
);
