/**
 * Regenerate the small, explicitly synthetic cell used by network-independent CI.
 *
 * It is laid out exactly like a published data tree (see docs/data-format.md): one
 * `catalog.json` and one cell whose files are named after its hash, so browser tests
 * exercise the same catalogue and cell resolution as the deployed app. It encodes a known
 * synthetic road so routes run over fixed geometry.
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { encodeBlock, stringTable } from "../src/offline/ibex/block";
import { encodeIndex } from "../src/offline/ibex/index";
import { crc32 } from "../src/offline/ibex/varint";
import { releaseTag, type BlockRef } from "../src/offline/ibex/spec";
import { DATA_VERSION, GENERATION } from "../src/offline/version";
import { cellBBox, cellId, parseCellId, tileOf } from "../src/geo/grid";
import { distance } from "../src/routing/engine";
import {
  type Edge,
  type Node,
  type Point,
} from "../src/routing/types";

const ROOT = "tests/fixtures/data";
const directory = ROOT;
const tag = releaseTag(GENERATION);
/** Four points inside cell 9-264-181. */
const points: Point[] = [
  [6.146, 46.189],
  [6.17, 46.183],
  [6.2, 46.181],
  [6.235, 46.177],
];
const nodes: Node[] = points.map((p, id) => ({
  id: 1000 + id,
  p,
  elevation: 400 + id * 10,
}));

/**
 * Deliberately mixed surfaces: browser tests assert that a route renders as more than
 * one rideability class, which a uniformly paved fixture could never show.
 */
const surfaces = [
  { surface: "paved", highway: "cycleway" },
  { surface: "gravel", highway: "track" },
  { surface: "paved", highway: "cycleway" },
];

const edges: Edge[] = [];
for (let i = 1; i < points.length; i++)
  for (const [from, to] of [
    [i - 1, i],
    [i, i - 1],
  ]) {
    const length = distance(points[from], points[to]);
    edges.push({
      // Deterministic within the release, and distinct per direction.
      id: (i * 4096 + from) * 2 + (from > to ? 1 : 0),
      from: nodes[from].id,
      to: nodes[to].id,
      way: String(i),
      length,
      geometry: [points[from], points[to]],
      grades: [[length, ((to - from) * 10) / length]],
      surface: surfaces[i - 1].surface,
      highway: surfaces[i - 1].highway,
      tags: {},
      stress: 0.1,
      uncertainty: 0.1,
      utility: 0.7,
      urban: 0.2,
      cyclingNetwork: 1,
      quality: 0.8,
      forest: 0,
      reward: 0,
      junction: 0,
      bridge: false,
      tunnel: false,
      name: "Synthetic test connection",
      tile: "",
    });
  }

const cell = parseCellId(cellId({ zoom: 9, x: 264, y: 181 }));
const id = cellId(cell);
const strings = stringTable();

// Edges belong to the z13 block containing their first point, matching the pipeline.
const grouped = new Map<string, Edge[]>();
for (const e of edges) {
  const tile = tileOf(e.geometry[0], 13);
  const key = `${tile.x}/${tile.y}`;
  (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(e);
}

const blocks: BlockRef[] = [];
const chunks: Uint8Array[] = [];
let offset = 0;
for (const [key, list] of grouped) {
  const [x, y] = key.split("/").map(Number);
  const used = new Set(list.flatMap((e) => [e.from, e.to]));
  const table = nodes.filter((n) => used.has(n.id));
  const raw = encodeBlock({ x, y }, table, list, strings, tag);
  const stored = deflateRawSync(raw, { level: 9 });
  blocks.push({
    x,
    y,
    offset,
    length: stored.length,
    rawLength: raw.length,
    crc: crc32(raw),
    nodes: table.length,
    edges: list.length,
    bbox: [
      Math.min(...list.flatMap((e) => e.geometry.map((p) => p[0]))),
      Math.min(...list.flatMap((e) => e.geometry.map((p) => p[1]))),
      Math.max(...list.flatMap((e) => e.geometry.map((p) => p[0]))),
      Math.max(...list.flatMap((e) => e.geometry.map((p) => p[1]))),
    ],
  });
  chunks.push(stored);
  offset += stored.length;
}

const graph = new Uint8Array(offset);
let at = 0;
for (const c of chunks) {
  graph.set(c, at);
  at += c.length;
}
const index = encodeIndex({
  release: GENERATION,
  cell,
  blockZoom: 13,
  fieldZoom: 15,
  bbox: cellBBox(cell),
  strings: strings.values(),
  blocks,
  restrictions: [],
  fields: {},
  meta: {},
});

await fs.rm(ROOT, { recursive: true, force: true });
await fs.mkdir(`${directory}/cells/${id}`, { recursive: true });
const files = (["index.ibx", "graph.ibx"] as const).map((path) => {
  const bytes = path === "index.ibx" ? index : graph;
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});
// The cell is named after its own bytes, exactly as the builder names a real one.
const hash = createHash("sha256")
  .update(files.map((f) => f.sha256).join(""))
  .digest("hex")
  .slice(0, 16);
for (const [path, bytes] of [
  ["index.ibx", index],
  ["graph.ibx", graph],
] as const)
  await fs.writeFile(`${directory}/cells/${id}/${hash}.${path}`, bytes);
const bbox = cellBBox(cell).map((v) => Number(v.toFixed(7))) as [
  number,
  number,
  number,
  number,
];
await fs.writeFile(
  `${directory}/catalog.json`,
  JSON.stringify(
    {
      dataVersion: DATA_VERSION,
      generated: "1970-01-01T00:00:00.000Z",
      grid: { scheme: "xyz", zoom: 9, blockZoom: 13, fieldZoom: 15 },
      attribution: "Synthetic test data — not a real cycling network",
      cells: [
        {
          id,
          x: cell.x,
          y: cell.y,
          bbox,
          hash,
          builtAt: "1970-01-01T00:00:00.000Z",
          osm: "1970-01-01T00:00:00.000Z",
          bytes: files.reduce((sum, f) => sum + f.bytes, 0),
          blocks: blocks.length,
          terrainCoverage: 1,
          files,
          nodes: nodes.length,
          edges: edges.length,
        },
      ],
    },
    null,
    2,
  ) + "\n",
);

console.log(
  `wrote ${directory}: cell ${id}, ${blocks.length} block(s), ${files.reduce((s, f) => s + f.bytes, 0)} bytes`,
);

/**
 * A basemap and cycle-route archive over the same road, with the glyphs and sprite they
 * name, so the map loads every file from the fixture itself. They have to be real files:
 * WebKit does not route requests made by the service worker or a web worker, so a mock the
 * page never sees makes a test pass or fail by who fetched first. Relief is the one input
 * no fixture file can stand in for, so it is off. Needs `tippecanoe`; all of it is a few
 * kilobytes and committed.
 */
const line = (properties: Record<string, string>) =>
  JSON.stringify({
    type: "Feature",
    properties,
    geometry: { type: "LineString", coordinates: points },
  }) + "\n";
await fs.mkdir(`${directory}/map`, { recursive: true });
for (const [name, layer, properties] of [
  ["basemap", "roads", { kind: "minor_road", kind_detail: "residential" }],
  ["cycle-routes", "cycle_routes", { route: "bicycle", network: "rcn", ref: "1" }],
] as const) {
  const source = `${directory}/map/${name}.geojsonl`;
  await fs.writeFile(source, line(properties));
  const tippecanoe = spawnSync(
    "tippecanoe",
    ["-o", `${directory}/map/${name}.pmtiles`, "--force", "--quiet", "-l", layer, "-Z0", "-z14", source],
    { stdio: "inherit" },
  );
  await fs.rm(source);
  if (tippecanoe.status !== 0) throw new Error(`tippecanoe exited ${tippecanoe.status}`);
}
/** A transparent 1×1 PNG: an empty sprite sheet. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
  "base64",
);
await fs.mkdir(`${directory}/map/sprites`, { recursive: true });
for (const scale of ["", "@2x"]) {
  await fs.writeFile(`${directory}/map/sprites/light${scale}.json`, "{}\n");
  await fs.writeFile(`${directory}/map/sprites/light${scale}.png`, PIXEL);
}
// The fixture's only label is a route ref: one range per font, and an empty glyph set is
// a valid one.
for (const font of ["Noto Sans Regular", "Noto Sans Medium"]) {
  await fs.mkdir(`${directory}/map/fonts/${font}`, { recursive: true });
  await fs.writeFile(`${directory}/map/fonts/${font}/0-255.pbf`, new Uint8Array());
}
/**
 * Map packs, as `scripts/map_cells.ts` publishes them: the cell's own tiles from z7, and a
 * world pack to z6 with the fonts and sprite, so the browser test can reload offline and
 * still draw the road. The tiles carry `source: "pack"`, which the online archive's do not,
 * so a test can tell where a drawn tile came from.
 */
const packFile = async (prefix: string, path: string, bytes: Uint8Array) => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const url = `${prefix}/${sha256.slice(0, 16)}.${path}`;
  await fs.mkdir(`${directory}/${prefix}`, { recursive: true });
  await fs.writeFile(`${directory}/${url}`, bytes);
  return { path, url, bytes: bytes.length, sha256 };
};
const packHash = (files: { path: string; sha256: string }[]) =>
  createHash("sha256")
    .update(files.map((e) => `${e.path}:${e.sha256}`).join("\n"))
    .digest("hex")
    .slice(0, 16);
const tiles = async (layer: string, properties: Record<string, string>, zooms: string[]) => {
  const source = `${directory}/pack.geojsonl`;
  const target = `${directory}/pack.pmtiles`;
  await fs.writeFile(source, line({ ...properties, source: "pack" }));
  const tippecanoe = spawnSync(
    "tippecanoe",
    ["-o", target, "--force", "--quiet", "-l", layer, ...zooms, source],
    { stdio: "inherit" },
  );
  if (tippecanoe.status !== 0) throw new Error(`tippecanoe exited ${tippecanoe.status}`);
  const bytes = new Uint8Array(await fs.readFile(target));
  await fs.rm(source);
  await fs.rm(target);
  return bytes;
};
await fs.rm(`${directory}/map-cells`, { recursive: true, force: true });
await fs.rm(`${directory}/map-world`, { recursive: true, force: true });
const road = { kind: "minor_road", kind_detail: "residential" };
const cellFiles = [
  await packFile(`map-cells/${id}`, "basemap.pmtiles", await tiles("roads", road, ["-Z7", "-z14"])),
  await packFile(
    `map-cells/${id}`,
    "routes.pmtiles",
    await tiles("cycle_routes", { route: "bicycle", network: "rcn", ref: "1" }, ["-Z7", "-z14"]),
  ),
];
const assets: Record<string, string> = {};
for (const font of ["Noto Sans Regular", "Noto Sans Medium"]) assets[`glyphs/${font}/0-255.pbf`] = "";
for (const scale of ["", "@2x"]) {
  assets[`sprite/light${scale}.json`] = Buffer.from("{}\n").toString("base64");
  assets[`sprite/light${scale}.png`] = PIXEL.toString("base64");
}
const worldFiles = [
  await packFile("map-world", "basemap.pmtiles", await tiles("roads", road, ["-Z0", "-z6"])),
  await packFile("map-world", "assets.json", new TextEncoder().encode(JSON.stringify(assets))),
];
await fs.writeFile(
  `${directory}/map.json`,
  JSON.stringify(
    {
      basemap: "map/basemap.pmtiles",
      cycleRoutes: "map/cycle-routes.pmtiles",
      glyphs: "map/fonts/{fontstack}/{range}.pbf",
      sprite: "map/sprites/light",
      terrain: null,
      world: { hash: packHash(worldFiles), files: worldFiles },
      cells: { [id]: { hash: packHash(cellFiles), files: cellFiles } },
    },
    null,
    2,
  ) + "\n",
);
