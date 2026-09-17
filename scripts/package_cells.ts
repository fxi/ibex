/**
 * Turn built cells into binary packs plus a catalogue.
 *
 * Each cell becomes two files: index.ibx (a 64-byte identifying header plus the block
 * directory) and graph.ibx (the z13 blocks, deflated and concatenated, each addressable by
 * the byte range recorded in the directory). The catalogue sits at the release root and
 * resolves cell manifests relative to itself, so the same tree serves locally and from
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
import { DATA_VERSION } from "../src/offline/version";
import { DEFAULT_RELEASE_ROOT } from "./local_release";
import {
  COST_MODEL_VERSION,
  type Edge,
  type Graph,
  type Node,
} from "../src/routing/types";

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const input = positional[0] ?? `${DEFAULT_RELEASE_ROOT}/cells`;
const output = positional[1] ?? `${DEFAULT_RELEASE_ROOT}/packs`;
/** Package what is there, for a deliberate subset build. Never for a release. */
const partial = flags.has("--partial");
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
// A release is the whole window or it is nothing. A cell that was skipped still produces a
// well-formed catalogue with its own valid release id, which then publishes — and verifies —
// as if it were complete, leaving holes a rider only finds when a route fails.
const expected: string[] | undefined = await fs
  .readFile(`${input}/window.json`, "utf8")
  .then((text) => JSON.parse(text).cellIds as string[])
  .catch(() => undefined);
const incomplete: string[] = [];

const cells: CellBuild[] = [];
for (const id of entries) {
  const manifestPath = `${input}/${id}/manifest.json`;
  try {
    await fs.access(manifestPath);
  } catch {
    incomplete.push(id);
    continue;
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.costModelVersion !== COST_MODEL_VERSION)
    throw new Error(
      `${id} was built with cost model ${manifest.costModelVersion}`,
    );
  cells.push({ id, manifest });
}

const missing = expected
  ? expected.filter((id) => !cells.some((cell) => cell.id === id))
  : [];
const gaps = [...new Set([...incomplete, ...missing])].sort();
if (gaps.length && !partial)
  throw new Error(
    `Build is incomplete: ${gaps.length} cell(s) missing a manifest — ${gaps.join(" ")}. ` +
      `Finish the build (scripts/build_cells.py), or pass --partial for a deliberate subset.`,
  );
if (gaps.length) console.warn(`--partial: packaging without ${gaps.join(" ")}`);
if (!expected && !partial)
  console.warn(
    `No window.json in ${input}: packaging ${cells.length} cells as found, completeness unverified.`,
  );

// Repack older builds honestly: adding cached signals does not retroactively extract
// the mountain-pass sources introduced by preprocessor 7.
const preprocessors = new Set(cells.map((cell) => cell.manifest.source?.preprocessorVersion));
if (preprocessors.size !== 1 || !Number.isInteger([...preprocessors][0]))
  throw new Error("Cells must declare one consistent source.preprocessorVersion; rebuild mixed or unversioned inputs.");
const preprocessorVersion = [...preprocessors][0];

// One generation id for the whole release. Packs from different generations cannot route
// together, and the id is derived so it changes whenever the inputs do.
// Terrain rides in the digest as well as OSM: a build whose DEM tiles partly failed carries
// different grades, and without this it would claim the same id — and the same permanently
// cached S3 prefix — as a later, complete rebuild of the same OSM input.
const sources = cells
  .map(
    (c) =>
      `${c.id}:${c.manifest.source?.osmSha256 ?? ""}:${c.manifest.osmTimestamp}` +
      `:${c.manifest.terrainSource ?? "none"}:${c.manifest.terrainCoverage ?? 0}`,
  )
  .sort()
  .join("|");
// Prefer the cells' provenance; a custom build must not inherit the date of an
// unrelated release clip at the default path. Older builds need the fallback.
const cellTimestamps = cells
  .map((c) => c.manifest.osmTimestamp as string | undefined)
  .filter((date): date is string => !!date && date !== "unknown")
  .sort();
let releaseStamp = "";
try {
  releaseStamp =
    JSON.parse(await fs.readFile("data/pbf/release.osm.source.json", "utf8"))
      .osmTimestamp ?? "";
} catch {
  releaseStamp = "";
}
const osmTimestamp = cellTimestamps[0] || releaseStamp || "unknown";
const edition = osmTimestamp.slice(0, 10).replace(/-/g, "");
// Cost model, preprocessor and data version change what a cell means, so they are part
// of the hash: a rebuild under any of them is a new release, never a silent overwrite.
const release = `${edition}-${shortHash(
  `v${DATA_VERSION}|c${COST_MODEL_VERSION}|p${preprocessorVersion}|${sources}`,
)}`;
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
    release,
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
    dataVersion: DATA_VERSION,
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
  dataVersion: DATA_VERSION,
  release,
  grid: {
    scheme: "xyz",
    zoom: parseCellId(cells[0].id).zoom,
    blockZoom: BLOCK_ZOOM,
    fieldZoom: FIELD_ZOOM,
  },
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
