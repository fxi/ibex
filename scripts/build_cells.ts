/**
 * Build routing cells for any box on Earth, straight from OpenStreetMap.
 *
 * The grid is global and the cells are independent, so this takes a bounding box, works out
 * which Geofabrik downloads cover it, and builds every cell that has roads under it. There
 * is no region, no release and no pre-pass: a cell is a pure function of its own ground
 * plus a 5 km halo, and cells built months apart route together as long as they carry the
 * same generation (`src/offline/version.ts`).
 *
 *   node --import tsx scripts/build_cells.ts --bbox 5,45.8,7.2,46.6
 *   node --import tsx scripts/build_cells.ts --bbox -11,35,32,72 --dry-run
 *   node --import tsx scripts/build_cells.ts --cells 9-264-181,9-265-181
 *
 * Work is grouped by download, not by cell: an extract is parsed once and every cell it
 * touches is cut from it, because parsing a country costs far more than building a cell.
 * A cell on a border is cut from each of its countries and the pieces merged.
 *
 * Output is `<out>/<cell id>/{index.ibx,graph.ibx}` plus `catalogue.json`, which is what
 * `npm run data:stage` serves and what the publisher uploads.
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildGraph, sourceBBox } from "../src/build/graph";
import { inflate } from "../src/build/platform/node";
import { sampleTerrain, TERRAIN_ZOOM } from "../src/build/platform/terrainCache";
import {
  mergeSources,
  readSource,
  subsetSource,
  WayBounds,
  type CellSource,
} from "../src/build/osm/source";
import {
  extractsFor,
  readExtractIndex,
  type Extract,
} from "../src/build/osm/extracts";
import { cellBBox, cellId, cellsInBBox, parseCellId, type Cell } from "../src/geo/grid";
import { packCell, BLOCK_ZOOM, FIELD_ZOOM } from "../src/offline/ibex/pack";
import { DATA_VERSION, GENERATION } from "../src/offline/version";
import { COST_MODEL_VERSION } from "../src/routing/types";

const GEOFABRIK_INDEX = "https://download.geofabrik.de/index-v1.json";
const USER_AGENT = "ibex-builder/0.1 (+https://fxi.io/ibex)";
/** Below this a cell is sea, moorland or desert: nothing to route on, so nothing to publish. */
const MIN_EDGES = 1;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const out = option("out") ?? "data/cells";
const cacheDir = option("extracts") ?? "data/extracts";
const terrainCache = option("terrain-cache") ?? "data/terrain";
const zoom = Number(option("zoom") ?? 9);
const dryRun = flag("dry-run");
const withTerrain = !flag("no-terrain");
const limit = Number(option("limit") ?? Infinity);
const keepExtracts = flag("keep-extracts");

function usage(message: string): never {
  console.error(`${message}

usage: build_cells.ts (--bbox W,S,E,N | --cells id,id,…) [options]
  --out <dir>            where packs are written      (default data/cells)
  --extracts <dir>       where downloads are cached   (default data/extracts)
  --terrain-cache <dir>  DEM tile cache               (default data/terrain)
  --zoom <n>             grid zoom                    (default 9)
  --dry-run              print the plan and stop
  --no-terrain           skip the DEM
  --keep-extracts        do not delete a download once its cells are built
  --limit <n>            build at most n cells`);
  process.exit(2);
}

/** The cells to build, from a box or named outright. */
function targetCells(): Cell[] {
  const named = option("cells");
  if (named) return named.split(",").map((id) => parseCellId(id.trim()));
  const box = option("bbox");
  if (!box) usage("Give either --bbox or --cells.");
  const parts = box.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)))
    usage(`--bbox wants four numbers, W,S,E,N — got "${box}"`);
  const [west, south, east, north] = parts;
  if (west >= east || south >= north) usage(`--bbox is empty: ${box}`);
  return cellsInBBox([west, south, east, north], zoom);
}

async function extractIndex(): Promise<Extract[]> {
  const cached = `${cacheDir}/index-v1.json`;
  let text: string;
  try {
    const stat = await fs.stat(cached);
    // A week old is fine: extracts are added rarely and their outlines move even more so.
    if (Date.now() - stat.mtimeMs > 7 * 24 * 3600_000) throw new Error("stale");
    text = await fs.readFile(cached, "utf8");
  } catch {
    console.log(`fetching ${GEOFABRIK_INDEX}`);
    const response = await fetch(GEOFABRIK_INDEX, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) throw new Error(`Extract index: HTTP ${response.status}`);
    text = await response.text();
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cached, text);
  }
  return readExtractIndex(JSON.parse(text));
}

/**
 * Download an extract if it is not already here.
 *
 * Geofabrik publishes an md5 beside each file, but it has been wrong before — the Swiss
 * one did not match its own download for days — and a hard failure there is what once left
 * a cell with half a city missing. So the size is checked and a mismatch is reported, not
 * enforced: a short file fails loudly at parse time anyway.
 */
async function fetchExtract(extract: Extract): Promise<string> {
  const path = `${cacheDir}/${extract.id}.osm.pbf`;
  const existing = await fs.stat(path).catch(() => undefined);
  if (existing?.isFile()) return path;
  await fs.mkdir(cacheDir, { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  console.log(`  downloading ${extract.id} …`);
  const started = Date.now();
  const response = await fetch(extract.url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok || !response.body)
    throw new Error(`${extract.id}: HTTP ${response.status} from ${extract.url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await fs.writeFile(partial, bytes);
  await fs.rename(partial, path);
  const seconds = (Date.now() - started) / 1000;
  console.log(
    `  ${extract.id}: ${(bytes.length / 1e6).toFixed(0)} MB in ${seconds.toFixed(0)} s ` +
      `(${(bytes.length / 1e6 / seconds).toFixed(1)} MB/s)`,
  );
  return path;
}

type Pending = {
  cell: Cell;
  /** Ids of the downloads this cell needs; it is buildable when every one has been read. */
  needs: Set<string>;
  parts: CellSource[];
};

async function main() {
  const wanted = targetCells();
  const index = await extractIndex();

  // Which downloads each cell needs, and which cells each download serves. Work runs
  // download-major: parsing a country takes about as long as building forty cells out of
  // it, so each file is read exactly once and every cell waiting on it is cut as it passes.
  const pending = new Map<string, Pending>();
  const serves = new Map<string, { extract: Extract; cells: string[] }>();
  for (const cell of wanted) {
    const extracts = extractsFor(index, sourceBBox(cell));
    if (!extracts.length) continue; // open sea: no download claims it
    const id = cellId(cell);
    pending.set(id, { cell, needs: new Set(extracts.map((e) => e.id)), parts: [] });
    for (const extract of extracts) {
      const entry = serves.get(extract.id);
      if (entry) entry.cells.push(id);
      else serves.set(extract.id, { extract, cells: [id] });
    }
  }

  // Biggest first: a cell deep inside a country is complete as soon as that country is
  // read, so the queue of half-built cells stays short.
  const order = [...serves.values()].sort((a, b) => b.extract.area - a.extract.area);
  console.log(
    `${wanted.length} cells in range, ${pending.size} with OSM coverage, ` +
      `${order.length} downloads, generation ${GENERATION}`,
  );
  if (dryRun) {
    for (const { extract, cells } of order.slice(0, 25))
      console.log(`  ${String(cells.length).padStart(5)} cells  ${extract.id}`);
    if (order.length > 25) console.log(`  … and ${order.length - 25} more downloads`);
    return;
  }

  await fs.mkdir(out, { recursive: true });
  const built: Built[] = [];
  let skipped = 0;

  for (const { extract, cells } of order) {
    if (built.length >= limit) break;
    const live = cells.filter((id) => pending.has(id));
    if (!live.length) continue;
    const path = await fetchExtract(extract);
    const started = Date.now();
    const source = await readSource(new Uint8Array(await fs.readFile(path)), inflate, {
      filter: true,
    });
    const bounds = WayBounds.of(source);
    console.log(
      `\n${extract.id}: ${source.ways.length} ways, ${source.positions.size} nodes ` +
        `in ${((Date.now() - started) / 1000).toFixed(0)} s — ${live.length} cell(s)`,
    );
    const ready: Pending[] = [];
    for (const id of live) {
      const entry = pending.get(id)!;
      const slice = subsetSource(source, sourceBBox(entry.cell), bounds);
      if (slice.ways.length) entry.parts.push(slice);
      entry.needs.delete(extract.id);
      if (!entry.needs.size) ready.push(entry);
    }
    if (!keepExtracts) await fs.rm(path, { force: true }).catch(() => undefined);

    for (const entry of ready) {
      if (built.length >= limit) break;
      const id = cellId(entry.cell);
      pending.delete(id);
      if (!entry.parts.length) {
        skipped++;
        continue;
      }
      const result = await buildOne(entry.cell, mergeSources(entry.parts));
      entry.parts.length = 0;
      if (!result) {
        skipped++;
        continue;
      }
      built.push(result);
      console.log(
        `  ${id}: ${result.meta.edges} edges, ${(result.bytes / 1e6).toFixed(1)} MB` +
          (withTerrain ? `, terrain ${(result.meta.terrainCoverage * 100).toFixed(0)}%` : ""),
      );
    }
  }

  await writeCatalogue(built);
  console.log(`\nbuilt ${built.length} cells, skipped ${skipped} with nothing to route on`);
  console.log(`serve it with: npm run data:stage -- ${out}`);
}

type Built = { id: string; cell: Cell; bytes: number; hash: string; meta: Meta };

type Meta = {
  edges: number;
  nodes: number;
  terrainCoverage: number;
  osmTimestamp: string;
};

async function buildOne(cell: Cell, source: CellSource) {
  const id = cellId(cell);
  let elevations = new Map<number, number>();
  let coverage = 0;
  if (withTerrain) {
    // Only nodes a road uses need a height, which is a fraction of what the cell holds.
    const wanted = new Map<number, [number, number]>();
    for (const way of source.ways) {
      if (!("highway" in way.tags) && way.tags.route !== "ferry") continue;
      for (const ref of way.refs) {
        const at = source.positions.locate(ref);
        if (at >= 0) wanted.set(ref, [source.positions.lonAt(at), source.positions.latAt(at)]);
      }
    }
    elevations = await sampleTerrain(wanted, terrainCache);
    coverage = wanted.size ? elevations.size / wanted.size : 0;
  }

  const { graph } = buildGraph(source, { cell, elevations });
  if (graph.edges.length < MIN_EDGES) return undefined;

  const meta: Meta = {
    edges: graph.edges.length,
    nodes: graph.nodes.length,
    terrainCoverage: Number(coverage.toFixed(3)),
    osmTimestamp: new Date().toISOString(),
  };
  const packed = packCell(graph, cell, GENERATION, {
    terrainCoverage: meta.terrainCoverage,
    osmTimestamp: meta.osmTimestamp,
  });
  const directory = `${out}/${id}`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(`${directory}/index.ibx`, packed.index);
  await fs.writeFile(`${directory}/graph.ibx`, packed.graph);

  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const files = [
    { path: "index.ibx", bytes: packed.index.length, sha256: sha(packed.index) },
    { path: "graph.ibx", bytes: packed.graph.length, sha256: sha(packed.graph) },
  ];
  const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
  const hash = createHash("sha256")
    .update(files.map((f) => f.sha256).join(""))
    .digest("hex")
    .slice(0, 16);
  await fs.writeFile(
    `${directory}/manifest.json`,
    JSON.stringify(
      {
        dataVersion: DATA_VERSION,
        id,
        name: id,
        version: hash,
        release: GENERATION,
        cell: { zoom: cell.zoom, x: cell.x, y: cell.y },
        bbox: cellBBox(cell),
        osmTimestamp: meta.osmTimestamp,
        terrainCoverage: meta.terrainCoverage,
        blockZoom: BLOCK_ZOOM,
        blocks: packed.blocks,
        attribution:
          "© OpenStreetMap contributors · ODbL 1.0 | Terrain: Mapterhorn (see source attribution)",
        files,
      },
      null,
      2,
    ),
  );
  return { id, cell, bytes, hash, meta };
}

async function writeCatalogue(built: Built[]) {
  // Whatever was already here stays: cells arrive one at a time and a later run must not
  // erase an earlier one's work. The catalogue is rebuilt from what is on disk.
  const entries = await fs.readdir(out, { withFileTypes: true }).catch(() => []);
  const onDisk = entries
    .filter((e) => e.isDirectory() && /^\d{1,2}-\d{1,8}-\d{1,8}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  const fresh = new Map(built.map((b) => [b.id, b]));
  const cells = [];
  let oldest = "";
  for (const id of onDisk) {
    const made = fresh.get(id);
    let record = made;
    if (!record) {
      const manifest = await fs
        .readFile(`${out}/${id}/manifest.json`, "utf8")
        .then((t) => JSON.parse(t))
        .catch(() => undefined);
      if (!manifest || manifest.release !== GENERATION) continue;
      record = {
        id,
        cell: parseCellId(id),
        bytes: (manifest.files as { bytes: number }[]).reduce((s, f) => s + f.bytes, 0),
        hash: manifest.version,
        meta: {
          edges: 0,
          nodes: 0,
          terrainCoverage: manifest.terrainCoverage ?? 0,
          osmTimestamp: manifest.osmTimestamp,
        },
      };
    }
    if (!oldest || record.meta.osmTimestamp < oldest) oldest = record.meta.osmTimestamp;
    cells.push({
      id,
      x: record.cell.x,
      y: record.cell.y,
      bbox: cellBBox(record.cell),
      manifest: `${id}/manifest.json`,
      version: record.hash,
      bytes: record.bytes,
      available: true,
      nodes: record.meta.nodes || undefined,
      edges: record.meta.edges || undefined,
    });
  }
  await fs.writeFile(
    `${out}/catalogue.json`,
    JSON.stringify(
      {
        dataVersion: DATA_VERSION,
        release: GENERATION,
        grid: { scheme: "xyz", zoom, blockZoom: BLOCK_ZOOM, fieldZoom: FIELD_ZOOM },
        osmTimestamp: oldest || "unknown",
        generated: new Date().toISOString(),
        costModelVersion: COST_MODEL_VERSION,
        terrainSource: withTerrain ? `Mapterhorn Terrarium z${TERRAIN_ZOOM}` : null,
        attribution:
          "© OpenStreetMap contributors · ODbL 1.0 | Terrain: Mapterhorn (see source attribution)",
        cells,
      },
      null,
      2,
    ),
  );
  console.log(`catalogue: ${cells.length} cells at ${out}/catalogue.json`);
}

await main();
