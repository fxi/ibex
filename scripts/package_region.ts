/** Partition graph and precompute profile fields using the runtime cost function. */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { buildField } from "../src/routing/engine";
import type { Graph, Profile } from "../src/routing/types";
const input = process.argv[2] ?? "data/build/geneva";
const directory = process.argv[3] ?? "public/packs/geneva";
await fs.mkdir(directory, { recursive: true });
const graph: Graph = JSON.parse(
  await fs.readFile(`${input}/graph.json`, "utf8"),
);
const manifest = JSON.parse(
  await fs.readFile(`${input}/manifest.json`, "utf8"),
);
const previousFiles = await fs
  .readFile(`${directory}/manifest.json`, "utf8")
  .then((s) => JSON.parse(s).files as { path: string }[])
  .catch(() => []);
const files: { path: string; bytes: number; sha256: string }[] = [];
async function record(path: string, bytes: Uint8Array) {
  await fs.writeFile(`${directory}/${path}`, bytes);
  files.push({
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
async function json(path: string, value: unknown) {
  await record(path, gzipSync(JSON.stringify(value), { level: 6 }));
}
const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
const groups = new Map<string, Graph["edges"]>();
for (const edge of graph.edges) {
  const group = groups.get(edge.tile) ?? [];
  group.push(edge);
  groups.set(edge.tile, group);
}
const chunks = [];
for (const [tile, edges] of [...groups].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const ids = new Set(edges.flatMap((e) => [e.from, e.to]));
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const edge of edges)
    for (const p of edge.geometry) {
      bbox[0] = Math.min(bbox[0], p[0]);
      bbox[1] = Math.min(bbox[1], p[1]);
      bbox[2] = Math.max(bbox[2], p[0]);
      bbox[3] = Math.max(bbox[3], p[1]);
    }
  const path = `graph-${tile}.bin`;
  await json(path, { nodes: [...ids].map((id) => nodes.get(id)), edges });
  chunks.push({ path, bbox });
}
const fields = {} as Record<Profile, ReturnType<typeof buildField>>;
for (const profile of ["gravel", "road", "touring", "scenic"] as Profile[])
  fields[profile] = buildField(graph, { profile, anchors: [] });
await json("index.bin", {
  schemaVersion: 1,
  bbox: graph.bbox,
  restrictions: graph.restrictions,
  chunks,
  fields,
});
await record(
  "attribution.json",
  Buffer.from(
    JSON.stringify({
      osm: {
        copyright: "© OpenStreetMap contributors",
        license: "ODbL-1.0",
        url: "https://opendatacommons.org/licenses/odbl/1-0/",
      },
      terrain: JSON.parse(
        await fs.readFile("data/terrain/attribution.json", "utf8"),
      ),
    }),
  ),
);
const basemap = JSON.parse(await fs.readFile(`${input}/basemap.json`, "utf8"));
const water = JSON.parse(await fs.readFile("data/water.geojson", "utf8"));
basemap.features.push(...water.features);
await fs.writeFile(`${input}/basemap-combined.json`, JSON.stringify(basemap));
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
    "--drop-densest-as-needed",
    "--no-tile-size-limit",
    "--force",
    `${input}/basemap-combined.json`,
  ],
  { stdio: ["ignore", "ignore", "ignore"] },
);
await record(
  "basemap.pmtiles",
  await fs.readFile(`${directory}/basemap.pmtiles`),
);
manifest.files = files;
manifest.version = createHash("sha256")
  .update(JSON.stringify(files))
  .digest("hex")
  .slice(0, 16);
manifest.source = {
  waterSha256: createHash("sha256")
    .update(await fs.readFile("data/osm-water.json"))
    .digest("hex"),
  osmSha256: createHash("sha256")
    .update(await fs.readFile("data/osm.json"))
    .digest("hex"),
  preprocessorVersion: 2,
};
await fs.writeFile(
  `${directory}/manifest.json`,
  JSON.stringify(manifest, null, 2),
);
for (const file of previousFiles)
  if (
    /^[a-zA-Z0-9_.-]+$/.test(file.path) &&
    !files.some((f) => f.path === file.path)
  )
    await fs.unlink(`${directory}/${file.path}`).catch(() => {});
console.log(
  JSON.stringify(
    {
      version: manifest.version,
      chunks: chunks.length,
      bytes: files.reduce((s, f) => s + f.bytes, 0),
    },
    null,
    2,
  ),
);
