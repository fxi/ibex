/** Verify model-4 pack integrity and exercise its new options on real geometry. */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { route } from "../src/routing/engine";
import { eligible } from "../src/routing/eligibility";
import {
  COST_MODEL_VERSION,
  type Graph,
  type Point,
} from "../src/routing/types";
import type { UserProfile } from "../src/routing/profiles";
const directory = process.argv[2] ?? "public/packs/geneva";
const manifest = JSON.parse(
  await fs.readFile(`${directory}/manifest.json`, "utf8"),
);
assert.equal(manifest.costModelVersion, COST_MODEL_VERSION);
for (const file of manifest.files) {
  const bytes = await fs.readFile(`${directory}/${file.path}`);
  assert.equal(bytes.length, file.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
}
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
assert(
  graph.edges.every(
    (e) =>
      typeof e.urban === "number" &&
      e.urban >= 0 &&
      e.urban <= 1 &&
      (e.cyclingNetwork === 0 || e.cyclingNetwork === 1),
  ),
);
const base: UserProfile = { version: 1, name: "Review", bike: "gravel" };
const cases: unknown[] = [];
function run(name: string, anchors: Point[], profile: UserProfile) {
  const r = route(graph, { anchors, profile }, "reference");
  const record = {
    name,
    anchors,
    status: r.status,
    distanceM: r.distanceM,
    hikeABikeM: r.hikeABikeM,
    ferryM: r.ferryM,
    components: r.components,
    durationMs: r.metrics.durationMs,
  };
  cases.push(record);
  console.log(JSON.stringify(record));
  assert.equal(r.status, "ok", name);
  return r;
}
const arve: Point[] = [
  [6.146, 46.189],
  [6.235, 46.177],
];
run("Arve baseline", arve, base);
run("Arve countryside", arve, { ...base, attraction: { countryside: 100 } });
run("Arve cycling network", arve, {
  ...base,
  attraction: { cycling_network: 100 },
});
const stair = graph.edges.find(
  (e) =>
    e.highway === "steps" &&
    e.length > 15 &&
    eligible(e, { ...base, access: { steps: true, hike_a_bike: true } }),
)!;
assert(stair, "A usable stair connection exists");
assert(!eligible(stair, base));
run("Mapped stairs enabled", [stair.geometry[0], stair.geometry.at(-1)!], {
  ...base,
  access: { steps: true, hike_a_bike: true },
});
const ferry =
  graph.edges.find((e) => e.way === "23927374") ??
  graph.edges.find((e) => e.highway === "ferry");
assert(ferry, "A bicycle-accessible ferry exists");
assert(!eligible(ferry, base));
const crossing = run(
  "Nyon–Yvoire ferry enabled",
  [ferry.geometry[0], ferry.geometry.at(-1)!],
  { ...base, access: { ferry: true } },
);
assert(crossing.ferryM > 0, "Ferry-enabled crossing uses the ferry");
const report = {
  version: manifest.version,
  verifiedFiles: manifest.files.length,
  bytes: manifest.files.reduce(
    (sum: number, f: { bytes: number }) => sum + f.bytes,
    0,
  ),
  sources: manifest.source,
  build: manifest.build,
  cases,
};
await fs.mkdir("data/derived", { recursive: true });
await fs.writeFile(
  "data/derived/profile-options-audit.json",
  JSON.stringify(report, null, 2),
);
console.log(
  `Verified ${manifest.files.length} pack files and ${cases.length} real routing cases.`,
);
