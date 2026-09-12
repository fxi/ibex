/** Reproduce the short Thônex → Saint-Cergues → Voirons route search. */
import fs from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { route, snapAnchors } from "../src/routing/engine";
import { eligible } from "../src/routing/eligibility";
import type { Graph, Point } from "../src/routing/types";
import { parseProfile } from "../src/routing/profiles";
import { loadProfile } from "./profile";
const profile = process.argv[2]?.endsWith(".json")
  ? parseProfile(JSON.parse(await fs.readFile(process.argv[2], "utf8")))
  : await loadProfile(process.argv[2] ?? "gravel_40");
const directory = "public/packs/geneva";
const index = JSON.parse(
  gunzipSync(await fs.readFile(`${directory}/index.bin`)).toString(),
);
const graph: Graph = {
  schemaVersion: 1,
  bbox: index.bbox,
  restrictions: index.restrictions,
  nodes: [],
  edges: [],
};
const nodes = new Map<number, Graph["nodes"][number]>();
for (const chunk of index.chunks) {
  const g = JSON.parse(
    gunzipSync(await fs.readFile(`${directory}/${chunk.path}`)).toString(),
  );
  graph.edges.push(...g.edges);
  for (const n of g.nodes) nodes.set(n.id, n);
}
graph.nodes = [...nodes.values()];
const anchors: Point[] = [
  [6.2, 46.192],
  [6.313, 46.237],
  [6.3549317, 46.2298694],
];
const filtered = {
  ...graph,
  edges: graph.edges.filter((e) => eligible(e, profile)),
};
const snapped = snapAnchors(filtered, anchors);
if (snapped) {
  const reverse = new Map<number, number[]>();
  for (const e of snapped.graph.edges) {
    const a = reverse.get(e.to) ?? [];
    a.push(e.from);
    reverse.set(e.to, a);
  }
  const connectivity = snapped.nodes.slice(1).map((target, i) => {
    const seen = new Set([target]),
      queue = [target];
    for (let j = 0; j < queue.length; j++)
      for (const n of reverse.get(queue[j]) ?? [])
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
    return {
      leg: i + 1,
      reachableNodes: seen.size,
      connected: seen.has(snapped.nodes[i]),
    };
  });
  console.log(
    JSON.stringify({ profile, anchors, snapped: snapped.points, connectivity }),
  );
}
const result = route(graph, { profile, anchors }, "reference");
const report = {
  profile,
  anchors,
  status: result.status,
  failedLeg: result.failedLeg,
  metrics: result.metrics,
  distanceM: result.distanceM,
  cost: result.cost,
};
console.log(JSON.stringify(report));
if (process.argv[3])
  await fs.writeFile(process.argv[3], JSON.stringify(report, null, 2));
