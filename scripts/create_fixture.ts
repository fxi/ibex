/** Regenerate the small, explicitly synthetic pack used by network-independent CI. */
import fs from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildField, distance } from "../src/routing/engine";
import type { Graph, Point, Profile } from "../src/routing/types";
const directory = "public/packs/test";
await fs.mkdir(directory, { recursive: true });
const points: Point[] = [
  [6.146, 46.189],
  [6.17, 46.183],
  [6.2, 46.181],
  [6.235, 46.177],
];
const graph: Graph = {
  schemaVersion: 1,
  bbox: [5.8, 45.95, 6.55, 46.45],
  nodes: points.map((p, id) => ({ id, p, elevation: 400 + id * 10 })),
  restrictions: [],
  edges: [],
};
for (let i = 1; i < points.length; i++)
  for (const [from, to] of [
    [i - 1, i],
    [i, i - 1],
  ]) {
    const length = distance(points[from], points[to]);
    graph.edges.push({
      id: graph.edges.length,
      from,
      to,
      way: String(i),
      length,
      geometry: [points[from], points[to]],
      grades: [[length, ((to - from) * 10) / length]],
      surface: "paved",
      stress: 0.1,
      uncertainty: 0.1,
      utility: 0.7,
      bridge: false,
      tunnel: false,
      name: "Synthetic test connection",
      tile: "test",
    });
  }
const files: { path: string; bytes: number; sha256: string }[] = [];
async function record(path: string, bytes: Uint8Array) {
  await fs.writeFile(`${directory}/${path}`, bytes);
  files.push({
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await record(
  "graph-test.bin",
  gzipSync(JSON.stringify({ nodes: graph.nodes, edges: graph.edges })),
);
const fields = Object.fromEntries(
  (["gravel", "road", "touring"] as Profile[]).map((profile) => [
    profile,
    buildField(graph, { anchors: [], profile }),
  ]),
);
await record(
  "index.bin",
  gzipSync(
    JSON.stringify({
      schemaVersion: 1,
      bbox: graph.bbox,
      restrictions: [],
      chunks: [{ path: "graph-test.bin", bbox: graph.bbox }],
      fields,
    }),
  ),
);
const map = {
  type: "FeatureCollection",
  features: graph.edges.map((e) => ({
    type: "Feature",
    properties: { kind: "road", class: "cycleway" },
    geometry: { type: "LineString", coordinates: e.geometry },
  })),
};
await fs.mkdir("data/fixtures", { recursive: true });
await fs.writeFile("data/fixtures/map.json", JSON.stringify(map));
execFileSync(
  "tippecanoe",
  [
    "-o",
    `${directory}/basemap.pmtiles`,
    "-l",
    "basemap",
    "-Z",
    "0",
    "-z",
    "14",
    "--force",
    "data/fixtures/map.json",
  ],
  { stdio: "ignore" },
);
await record(
  "basemap.pmtiles",
  await fs.readFile(`${directory}/basemap.pmtiles`),
);
await fs.writeFile(
  `${directory}/manifest.json`,
  JSON.stringify(
    {
      schemaVersion: 1,
      id: "synthetic",
      name: "Synthetic CI fixture",
      version: createHash("sha256")
        .update(JSON.stringify(files))
        .digest("hex")
        .slice(0, 16),
      bbox: graph.bbox,
      osmTimestamp: "synthetic",
      costModelVersion: 1,
      terrainCoverage: 1,
      attribution: "Synthetic test data — not a real cycling network",
      files,
    },
    null,
    2,
  ),
);
