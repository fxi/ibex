import { eligible } from "../src/routing/eligibility";
/** Inspect selected ways and grade costs against the cached OSM snapshot. */
import fs from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { route, scoreEdge, snapAnchors, total } from "../src/routing/engine";
import type { Graph, Point, Profile } from "../src/routing/types";
const directory = process.argv[2] ?? "public/packs/geneva";
const prefix = process.argv[3] ?? "data/derived/routing-audit/current";
await fs.mkdir(dirname(prefix), { recursive: true });
const index = JSON.parse(
  gunzipSync(await fs.readFile(`${directory}/index.bin`)).toString(),
);
const graph: Graph = {
  schemaVersion: 1,
  bbox: index.bbox,
  nodes: [],
  edges: [],
  restrictions: index.restrictions,
};
const nodes = new Map<number, Graph["nodes"][number]>();
for (const chunk of index.chunks) {
  const g = JSON.parse(
    gunzipSync(await fs.readFile(`${directory}/${chunk.path}`)).toString(),
  );
  for (const n of g.nodes) nodes.set(n.id, n);
  graph.edges.push(...g.edges);
}
graph.nodes = [...nodes.values()];
const tags: Record<string, Record<string, string>> = Object.fromEntries(
  graph.edges.map((e) => [
    e.way,
    { highway: e.highway, surface: e.surface, ...e.tags },
  ]),
);
const anchors: Point[] = process.argv[4]
  ? JSON.parse(process.argv[4])
  : [
      [6.151, 46.201],
      [6.37, 46.22],
    ];
for (const profile of ["road", "gravel"] as Profile[]) {
  const snapped = snapAnchors(
    { ...graph, edges: graph.edges.filter((e) => eligible(e, profile)) },
    anchors,
  )!;
  const edges = new Map((snapped?.graph.edges ?? []).map((e) => [e.id, e]));
  for (const mode of ["reference", "corridor"] as const) {
    const result = route(graph, { profile, anchors }, mode);
    const selected = result.edgeIds.map((id) => edges.get(id)!);
    const highways: Record<string, number> = {};
    for (const e of selected) {
      const h = tags[e.way]?.highway ?? "unknown";
      highways[h] = (highways[h] ?? 0) + e.length;
    }
    const detail = selected.map((e) => ({
      id: e.id,
      way: e.way,
      from: e.geometry[0],
      to: e.geometry.at(-1),
      length: e.length,
      tags: tags[e.way],
      grades: e.grades,
      cost: scoreEdge(e, profile),
      ratio: total(scoreEdge(e, profile)) / e.length,
    }));
    await fs.writeFile(
      `${prefix}-${profile}-${mode}.json`,
      JSON.stringify({ anchors, result, highways, edges: detail }, null, 2),
    );
    console.log(
      JSON.stringify({
        profile,
        mode,
        status: result.status,
        meters: result.distanceM,
        ascent: result.ascentM,
        cost: result.cost,
        components: result.components,
        highways,
        metrics: result.metrics,
        endpoint: result.anchors.at(-1),
      }),
    );
  }
}
