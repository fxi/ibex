/** Inspect selected ways and grade costs on a local release, merged as the app merges cells. */
import fs from "node:fs/promises";
import { dirname } from "node:path";
import { eligible } from "../src/routing/eligibility";
import { route, scoreEdge, snapAnchors, total } from "../src/routing/engine";
import type { Point } from "../src/routing/types";
import { DEFAULT_CELLS, loadReleaseGraph } from "./local_cells";
import { loadProfile } from "./profile";

const directory = process.argv[2] ?? DEFAULT_CELLS;
const prefix = process.argv[3] ?? ".cache/derived/routing-audit/current";
await fs.mkdir(dirname(prefix), { recursive: true });
const anchors: Point[] = process.argv[4]
  ? JSON.parse(process.argv[4])
  : [
      [6.151, 46.201],
      [6.37, 46.22],
    ];
const graph = await loadReleaseGraph(directory, anchors);
const tags: Record<string, Record<string, string>> = Object.fromEntries(
  graph.edges.map((e) => [
    e.way,
    { highway: e.highway, surface: e.surface, ...e.tags },
  ]),
);
for (const id of ["road_28", "gravel_40"]) {
  const profile = await loadProfile(id);
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
      `${prefix}-${id}-${mode}.json`,
      JSON.stringify({ anchors, result, highways, edges: detail }, null, 2),
    );
    console.log(
      JSON.stringify({
        profile: id,
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
