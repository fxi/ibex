import fs from "node:fs/promises";
import { route } from "../src/routing/engine";
import type { Graph, RouteRequest } from "../src/routing/types";
const graph: Graph = JSON.parse(
  await fs.readFile("data/build/geneva/graph.json", "utf8"),
);
const request: RouteRequest = {
  anchors: [
    [6.151, 46.201],
    [6.171, 46.119],
  ],
  profile: "gravel",
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
    request: { ...request, profile: "scenic" as const },
  },
  {
    name: "scenic-reward-disabled",
    graph: { ...graph, edges: graph.edges.map((e) => ({ ...e, reward: 0 })) },
    request: { ...request, profile: "scenic" as const },
  },
  {
    name: "scenic-junction-disabled",
    graph: { ...graph, edges: graph.edges.map((e) => ({ ...e, junction: 0 })) },
    request: { ...request, profile: "scenic" as const },
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
    request: { ...request, profile: "scenic" as const },
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
