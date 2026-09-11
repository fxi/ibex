/**
 * Turn built cells into binary packs plus a catalogue.
 *
 * Each cell becomes two files: index.ibx (a 64-byte identifying header plus the block
 * directory) and graph.ibx (the z13 blocks, deflated and concatenated, each addressable by
 * the byte range recorded in the directory). The catalogue sits at the release root and
 * resolves cell manifests relative to itself, so the same tree serves from public/ and from
 * an S3 prefix unchanged.
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { cellBBox, parseCellId, tileOf } from "../src/geo/grid";
import { encodeBlock, stringTable } from "../src/offline/ibex/block";
import { encodeIndex } from "../src/offline/ibex/index";
import { crc32 } from "../src/offline/ibex/varint";
import { releaseTag, type BlockRef } from "../src/offline/ibex/spec";
import {
  COST_MODEL_VERSION,
  type Edge,
  type Graph,
  type Node,
} from "../src/routing/types";

const input = process.argv[2] ?? "data/build/cells";
const output = process.argv[3] ?? "public/packs/geneva-grid";
const BLOCK_ZOOM = 13;
const FIELD_ZOOM = 15;
const CELL_BYTE_LIMIT = 50_000_000;

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const shortHash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 8);

type CellBuild = { id: string; manifest: Record<string, any> };

const entries = (await fs.readdir(input, { withFileTypes: true }))
  .filter((e) => e.isDirectory() && /^\d{1,2}-\d{1,8}-\d{1,8}$/.test(e.name))
  .map((e) => e.name)
  .sort();
if (!entries.length) throw new Error(`No built cells under ${input}`);

// Manifests only: a cell's graph.json is hundreds of megabytes, so they are read and
// released one at a time below rather than all held at once.
const cells: CellBuild[] = [];
for (const id of entries) {
  const manifestPath = `${input}/${id}/manifest.json`;
  try {
    await fs.access(manifestPath);
  } catch {
    console.warn(`skipping ${id}: no manifest, build incomplete`);
    continue;
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.costModelVersion !== COST_MODEL_VERSION)
    throw new Error(
      `${id} was built with cost model ${manifest.costModelVersion}`,
    );
  cells.push({ id, manifest });
}

// One generation id for the whole release. Packs from different generations cannot route
// together, and the id is derived so it changes whenever the inputs do.
const sources = cells
  .map(
    (c) =>
      `${c.id}:${c.manifest.source?.osmSha256 ?? ""}:${c.manifest.osmTimestamp}`,
  )
  .sort()
  .join("|");
// Cell extracts carry no provenance of their own, so fall back to the release clip.
let releaseStamp = "";
try {
  releaseStamp =
    JSON.parse(await fs.readFile("data/pbf/release.osm.source.json", "utf8"))
      .osmTimestamp ?? "";
} catch {
  releaseStamp = "";
}
const osmTimestamp =
  releaseStamp ||
  (cells[0].manifest.osmTimestamp &&
  cells[0].manifest.osmTimestamp !== "unknown"
    ? cells[0].manifest.osmTimestamp
    : "") ||
  "unknown";
const edition = osmTimestamp.slice(0, 10).replace(/-/g, "");
const release = `g${COST_MODEL_VERSION}-${edition}-p5-${shortHash(sources)}`;
const tag = releaseTag(release);
console.log(`release ${release}\n`);

await fs.mkdir(output, { recursive: true });
const catalogueCells = [];
let releaseBytes = 0;

for (const { id, manifest } of cells) {
  const graph: Graph = JSON.parse(
    await fs.readFile(`${input}/${id}/graph.json`, "utf8"),
  );
  const cell = parseCellId(id);
  const directory = `${output}/${id}`;
  await fs.mkdir(directory, { recursive: true });

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // A block owns the edges whose first geometry point falls in it — the same rule the cell
  // itself uses, one zoom finer, so ownership is consistent at both levels.
  const grouped = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    const tile = tileOf(edge.geometry[0], BLOCK_ZOOM);
    const key = `${tile.x}/${tile.y}`;
    const list = grouped.get(key);
    if (list) list.push(edge);
    else grouped.set(key, [edge]);
  }

  const strings = stringTable();
  const blocks: BlockRef[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const key of [...grouped.keys()].sort()) {
    const edges = grouped.get(key)!;
    const [x, y] = key.split("/").map(Number);
    const nodes: Node[] = [];
    const seen = new Set<number>();
    for (const edge of edges)
      for (const nodeId of [edge.from, edge.to])
        if (!seen.has(nodeId)) {
          seen.add(nodeId);
          const node = byId.get(nodeId);
          if (!node)
            throw new Error(
              `${id}: edge ${edge.id} references missing node ${nodeId}`,
            );
          nodes.push(node);
        }
    const raw = encodeBlock({ x, y }, nodes, edges, strings, tag);
    const stored = deflateRawSync(raw, { level: 9 });
    const bbox: [number, number, number, number] = [
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
    ];
    for (const edge of edges)
      for (const p of edge.geometry) {
        bbox[0] = Math.min(bbox[0], p[0]);
        bbox[1] = Math.min(bbox[1], p[1]);
        bbox[2] = Math.max(bbox[2], p[0]);
        bbox[3] = Math.max(bbox[3], p[1]);
      }
    blocks.push({
      x,
      y,
      offset,
      length: stored.length,
      rawLength: raw.length,
      crc: crc32(raw),
      nodes: nodes.length,
      edges: edges.length,
      bbox,
    });
    chunks.push(stored);
    offset += stored.length;
  }

  const graphBytes = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    graphBytes.set(chunk, at);
    at += chunk.length;
  }
  const indexBytes = encodeIndex({
    formatVersion: 1,
    release,
    costModelVersion: COST_MODEL_VERSION,
    cell,
    blockZoom: BLOCK_ZOOM,
    fieldZoom: FIELD_ZOOM,
    bbox: cellBBox(cell),
    strings: strings.values(),
    blocks,
    restrictions: graph.restrictions,
    fields: {},
    meta: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      restrictions: graph.restrictions.length,
      terrainCoverage: manifest.terrainCoverage,
      osmTimestamp: manifest.osmTimestamp,
      build: manifest.build,
    },
  });

  await fs.writeFile(`${directory}/index.ibx`, indexBytes);
  await fs.writeFile(`${directory}/graph.ibx`, graphBytes);
  const files = [
    { path: "index.ibx", bytes: indexBytes.length, sha256: sha256(indexBytes) },
    { path: "graph.ibx", bytes: graphBytes.length, sha256: sha256(graphBytes) },
  ];
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  if (total > CELL_BYTE_LIMIT)
    throw new Error(
      `${id} is ${(total / 1e6).toFixed(1)} MB, above the ${CELL_BYTE_LIMIT / 1e6} MB cell limit; ` +
        `re-partition at a finer grid zoom`,
    );

  const cellManifest = {
    schemaVersion: 2,
    format: "ibex-1",
    id,
    name: `${cell.zoom}/${cell.x}/${cell.y}`,
    version: shortHash(release + files.map((f) => f.sha256).join("")),
    release,
    cell,
    bbox: cellBBox(cell),
    osmTimestamp:
      manifest.osmTimestamp && manifest.osmTimestamp !== "unknown"
        ? manifest.osmTimestamp
        : osmTimestamp,
    costModelVersion: COST_MODEL_VERSION,
    terrainCoverage: manifest.terrainCoverage ?? 0,
    attribution: manifest.attribution ?? "© OpenStreetMap contributors",
    blockZoom: BLOCK_ZOOM,
    blocks: blocks.length,
    files,
    build: manifest.build ?? {},
  };
  await fs.writeFile(
    `${directory}/manifest.json`,
    JSON.stringify(cellManifest, null, 2) + "\n",
  );

  releaseBytes += total;
  catalogueCells.push({
    id,
    x: cell.x,
    y: cell.y,
    bbox: cellBBox(cell).map((v) => Number(v.toFixed(7))),
    manifest: `${id}/manifest.json`,
    version: cellManifest.version,
    bytes: total,
    available: true,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
  });
  console.log(
    `${id}  ${(total / 1e6).toFixed(2).padStart(6)} MB  ` +
      `${blocks.length.toString().padStart(4)} blocks  ` +
      `${graph.edges.length.toLocaleString().padStart(9)} edges  ` +
      `${(total / graph.edges.length).toFixed(1)} B/edge`,
  );
}

const catalogue = {
  schemaVersion: 1,
  release,
  grid: {
    scheme: "xyz",
    zoom: parseCellId(cells[0].id).zoom,
    blockZoom: BLOCK_ZOOM,
    fieldZoom: FIELD_ZOOM,
  },
  costModelVersion: COST_MODEL_VERSION,
  formatVersion: 1,
  osmTimestamp,
  generated: new Date().toISOString(),
  attribution: cells[0].manifest.attribution ?? "© OpenStreetMap contributors",
  cells: catalogueCells,
};
await fs.writeFile(
  `${output}/catalogue.json`,
  JSON.stringify(catalogue, null, 2) + "\n",
);

const largest = Math.max(...catalogueCells.map((c) => c.bytes));
console.log(
  `\n${catalogueCells.length} cells, ${(releaseBytes / 1e6).toFixed(1)} MB total, ` +
    `largest ${(largest / 1e6).toFixed(2)} MB (limit ${CELL_BYTE_LIMIT / 1e6} MB)`,
);
console.log(`catalogue: ${output}/catalogue.json`);
