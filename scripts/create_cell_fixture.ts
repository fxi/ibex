/**
 * Regenerate the small, explicitly synthetic cell release used by network-independent CI.
 *
 * It is laid out exactly like a published data tree (see docs/data-format.md): a
 * `latest.json` pointer and one release directory, so browser tests exercise the same
 * pointer, catalogue and cell resolution as the deployed app. It encodes a known synthetic
 * road so routes run over fixed geometry.
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { encodeBlock, stringTable } from "../src/offline/ibex/block";
import { encodeIndex } from "../src/offline/ibex/index";
import { crc32 } from "../src/offline/ibex/varint";
import { releaseTag, type BlockRef } from "../src/offline/ibex/spec";
import { DATA_VERSION } from "../src/offline/version";
import { cellBBox, cellId, parseCellId, tileOf } from "../src/geo/grid";
import { distance } from "../src/routing/engine";
import {
  type Edge,
  type Node,
  type Point,
} from "../src/routing/types";

const ROOT = "tests/fixtures/data";
const RELEASE = "fixture";
const directory = `${ROOT}/v${DATA_VERSION}/releases/${RELEASE}`;
const tag = releaseTag(RELEASE);
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
  release: RELEASE,
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
await fs.mkdir(`${directory}/${id}`, { recursive: true });
const files: { path: string; bytes: number; sha256: string }[] = [];
for (const [path, bytes] of [
  ["index.ibx", index],
  ["graph.ibx", graph],
] as const) {
  await fs.writeFile(`${directory}/${id}/${path}`, bytes);
  files.push({
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

const version = createHash("sha256")
  .update(RELEASE + files.map((f) => f.sha256).join(""))
  .digest("hex")
  .slice(0, 8);
const bbox = cellBBox(cell).map((v) => Number(v.toFixed(7))) as [
  number,
  number,
  number,
  number,
];
await fs.writeFile(
  `${directory}/${id}/manifest.json`,
  JSON.stringify(
    {
      dataVersion: DATA_VERSION,
      id,
      name: `${cell.zoom}/${cell.x}/${cell.y}`,
      version,
      release: RELEASE,
      cell,
      blockZoom: 13,
      blocks: blocks.length,
      bbox,
      osmTimestamp: "synthetic",
      terrainCoverage: 1,
      attribution: "Synthetic test data — not a real cycling network",
      files,
    },
    null,
    2,
  ) + "\n",
);

await fs.writeFile(
  `${directory}/catalogue.json`,
  JSON.stringify(
    {
      dataVersion: DATA_VERSION,
      release: RELEASE,
      grid: { scheme: "xyz", zoom: 9, blockZoom: 13, fieldZoom: 15 },
      osmTimestamp: "synthetic",
      generated: "1970-01-01T00:00:00.000Z",
      attribution: "Synthetic test data — not a real cycling network",
      cells: [
        {
          id,
          x: cell.x,
          y: cell.y,
          bbox,
          manifest: `${id}/manifest.json`,
          version,
          bytes: files.reduce((sum, f) => sum + f.bytes, 0),
          available: true,
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

await fs.writeFile(
  `${ROOT}/v${DATA_VERSION}/latest.json`,
  JSON.stringify(
    {
      dataVersion: DATA_VERSION,
      release: RELEASE,
      catalogue: `releases/${RELEASE}/catalogue.json`,
      published: "1970-01-01T00:00:00.000Z",
    },
    null,
    2,
  ) + "\n",
);
