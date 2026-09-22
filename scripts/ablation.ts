import fs from "node:fs/promises";
import { route } from "../src/routing/engine";
import type { Point, RouteRequest } from "../src/routing/types";
import { DEFAULT_CELLS, loadReleaseGraph } from "./local_release";
import { loadProfile } from "./profile";
const wanderer = await loadProfile("wanderer");
const anchors: Point[] = [
  [6.151, 46.201],
  [6.171, 46.119],
];
const graph = await loadReleaseGraph(
  process.argv[2] ?? DEFAULT_CELLS,
  anchors,
);
const request: RouteRequest = {
  anchors,
  profile: await loadProfile("gravel_40"),
};
const experiments = [
  { name: "baseline", graph, request },
  {
    name: "network-utility-disabled",
    graph: { ...graph, edges: graph.edges.map((e) => ({ ...e, utility: 1 })) },
    request,
  },
  {
    name: "slope-disabled",
    graph: {
      ...graph,
      edges: graph.edges.map((e) => ({ ...e, grades: null })),
    },
    request,
  },
  {
    name: "soft-attraction",
    graph,
    request: {
      ...request,
      attraction: {
        point: [6.205, 46.16] as [number, number],
        radiusM: 3000,
        strength: 0.35,
      },
    },
  },
  {
    name: "scenic-baseline",
    graph,
    request: { ...request, profile: wanderer },
  },
  {
    name: "scenic-reward-disabled",
    graph: { ...graph, edges: graph.edges.map((e) => ({ ...e, reward: 0 })) },
    request: { ...request, profile: wanderer },
  },
  {
    name: "scenic-junction-disabled",
    graph: { ...graph, edges: graph.edges.map((e) => ({ ...e, junction: 0 })) },
    request: { ...request, profile: wanderer },
  },
  {
    name: "scenic-technical-tags-stripped",
    graph: {
      ...graph,
      edges: graph.edges.map((e) => {
        if (!e.tags) return e;
        const rest = { ...e.tags };
        delete rest["mtb:scale"];
        delete rest["mtb:scale:uphill"];
        delete rest["mtb:scale:downhill"];
        return { ...e, tags: rest };
      }),
    },
    request: { ...request, profile: wanderer },
  },
];
const rows = [];
for (const experiment of experiments) {
  const reference = route(experiment.graph, experiment.request, "reference");
  const corridor = route(experiment.graph, experiment.request, "corridor");
  const row = {
    name: experiment.name,
    reference: {
      status: reference.status,
      distanceM: reference.distanceM,
      cost: reference.cost,
      components: reference.components,
      ...reference.metrics,
    },
    corridor: {
      status: corridor.status,
      distanceM: corridor.distanceM,
      cost: corridor.cost,
      components: corridor.components,
      ...corridor.metrics,
    },
    relativeCost: reference.cost ? corridor.cost / reference.cost - 1 : null,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  if (reference.status !== "ok" || corridor.status !== "ok")
    process.exitCode = 1;
}
await fs.writeFile(
  "data/derived/ablations.json",
  JSON.stringify(
    { scenario: "geneva-saleve", profile: "gravel", rows },
    null,
    2,
  ),
);
