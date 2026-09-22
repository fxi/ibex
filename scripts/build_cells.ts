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
 *   node --import tsx scripts/build_cells.ts --regions switzerland,rhone-alpes --publish
 *
 * Work is grouped by download, not by cell: an extract is parsed once and every cell it
 * touches is cut from it, because parsing a country costs far more than building a cell.
 * A cell on a border is cut from each of its countries and the pieces merged.
 *
 * Output is `<out>/<cell id>/{index.ibx,graph.ibx}` plus `catalogue.json`, which is what
 * `npm run dev` serves and what the publisher uploads. With `--publish` each cell goes to
 * the bucket as it is packed and leaves the disk again, because a run covering a country
 * is several gigabytes and the disk is the scarce resource, not the bucket. The catalogue
 * is written and uploaded after every download rather than at the end, so an interrupted
 * run leaves a tree that is complete as far as it got — and `--skip-built` resumes it.
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildGraph, sourceBBox } from "../src/build/graph";
import { inflate } from "../src/build/platform/node";
import { pruneCache, sampleTerrain } from "../src/build/platform/terrainCache";
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
import { DEFAULT_CELLS } from "./local_cells";
import { packCell, BLOCK_ZOOM, FIELD_ZOOM } from "../src/offline/ibex/pack";
import { DATA_VERSION, GENERATION } from "../src/offline/version";
import { catalogueSchema, type CatalogueCell } from "../src/offline/catalogue";
import { client, putCatalogue, putCellFile, type Bucket } from "./s3";

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

const out = option("out") ?? DEFAULT_CELLS;
const cacheDir = option("extracts") ?? ".cache/extracts";
const terrainCache = option("terrain-cache") ?? ".cache/terrain";
const zoom = Number(option("zoom") ?? 9);
const dryRun = flag("dry-run");
const withTerrain = !flag("no-terrain");
const limit = Number(option("limit") ?? Infinity);
const keepExtracts = flag("keep-extracts");
const publishing = flag("publish");
const keepLocal = flag("keep-local");
const skipBuilt = flag("skip-built");
const terrainBudget = Number(option("terrain-budget") ?? 0) * 1e6;

function usage(message: string): never {
  console.error(`${message}

usage: build_cells.ts (--bbox W,S,E,N | --regions id,id,… | --cells id,id,…) [options]
  --out <dir>            where cells are written      (default .cache/cells)
  --extracts <dir>       where downloads are cached   (default .cache/extracts)
  --terrain-cache <dir>  DEM tile cache               (default .cache/terrain)
  --zoom <n>             grid zoom                    (default 9)
  --dry-run              print the plan and stop
  --no-terrain           skip the DEM
  --keep-extracts        do not delete a download once its cells are built
  --limit <n>            build at most n cells
  --publish              send each cell to the bucket as it is built
  --keep-local           with --publish, also keep the pack in --out
  --skip-built           leave alone the cells the catalogue already has
  --terrain-budget <MB>  cap the DEM cache, dropping the least recently used`);
  process.exit(2);
}

/**
 * The cells a set of Geofabrik regions covers.
 *
 * A country is not a rectangle, and the box around one is mostly somebody else's ground:
 * asking for Switzerland, Auvergne, Rhône-Alpes and PACA as a box is 156 cells, where the
 * regions themselves are 92. The outlines are already in the index and `extractsFor`
 * already answers "which downloads claim this cell", so the selection is that answer
 * filtered to the regions asked for.
 */
function cellsInRegions(index: Extract[], names: string[]): Cell[] {
  const wanted = new Set(names);
  const chosen = index.filter((extract) => wanted.has(extract.id));
  const missing = names.filter((name) => !chosen.some((extract) => extract.id === name));
  if (missing.length)
    usage(
      `no such extract: ${missing.join(", ")}\n` +
        `  (Geofabrik has no 'auvergne-rhone-alpes'; it is 'auvergne' and 'rhone-alpes')`,
    );
  const union = chosen.reduce(
    (box, extract) => [
      Math.min(box[0], extract.bbox[0]),
      Math.min(box[1], extract.bbox[1]),
      Math.max(box[2], extract.bbox[2]),
      Math.max(box[3], extract.bbox[3]),
    ],
    [180, 90, -180, -90],
  );
  return cellsInBBox(union as [number, number, number, number], zoom).filter((cell) =>
    extractsFor(index, sourceBBox(cell)).some((extract) => wanted.has(extract.id)),
  );
}

/** The cells to build, from a box, a set of regions, or named outright. */
function targetCells(index: Extract[]): Cell[] {
  const named = option("cells");
  if (named) return named.split(",").map((id) => parseCellId(id.trim()));
  const regions = option("regions");
  if (regions) return cellsInRegions(index, regions.split(",").map((name) => name.trim()));
  const box = option("bbox");
  if (!box) usage("Give one of --bbox, --regions or --cells.");
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
  const index = await extractIndex();
  const wanted = targetCells(index);
  // Named after its own bytes, so a cell already in the catalogue is already right; this is
  // what lets a run of several hundred cells be resumed after an interruption.
  const already = skipBuilt ? new Set((await readCatalogue())?.cells.map((c) => c.id)) : undefined;
  const bucket = publishing ? client() : undefined;

  // Which downloads each cell needs, and which cells each download serves. Work runs
  // download-major: parsing a country takes about as long as building forty cells out of
  // it, so each file is read exactly once and every cell waiting on it is cut as it passes.
  const pending = new Map<string, Pending>();
  const serves = new Map<string, { extract: Extract; cells: string[] }>();
  let resumed = 0;
  for (const cell of wanted) {
    const extracts = extractsFor(index, sourceBBox(cell));
    if (!extracts.length) continue; // open sea: no download claims it
    const id = cellId(cell);
    if (already?.has(id)) {
      resumed++;
      continue;
    }
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
    `${wanted.length} cells in range, ${pending.size} to build, ` +
      `${order.length} downloads, generation ${GENERATION}` +
      (resumed ? `, ${resumed} already built` : "") +
      (publishing ? ", publishing as they come" : ""),
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
      const result = await buildOne(entry.cell, mergeSources(entry.parts), bucket);
      entry.parts.length = 0;
      if (!result) {
        skipped++;
        continue;
      }
      // A flat cell is a silently broken one: `sharp` is a hoisted dependency, and without
      // it every tile fails to decode and the whole build comes out without heights.
      if (withTerrain && !built.length && result.entry.terrainCoverage === 0)
        throw new Error(
          `${id} built with no terrain at all — check that 'sharp' resolves, ` +
            `or pass --no-terrain if that is what you meant`,
        );
      built.push(result);
      console.log(
        `  ${id}: ${result.entry.edges} edges, ${(result.entry.bytes / 1e6).toFixed(1)} MB` +
          (withTerrain
            ? `, terrain ${(result.entry.terrainCoverage * 100).toFixed(0)}%`
            : ""),
      );
    }

    // Per download rather than per run: an interrupted wide build then leaves a catalogue —
    // and a bucket — that is complete and readable up to the last download it finished.
    if (ready.length) await writeCatalogue(built, bucket);
    if (terrainBudget > 0) {
      const dropped = await pruneCache(terrainCache, terrainBudget);
      if (dropped) console.log(`  terrain cache: dropped ${(dropped / 1e6).toFixed(0)} MB`);
    }
  }

  await writeCatalogue(built, bucket);
  console.log(`\nbuilt ${built.length} cells, skipped ${skipped} with nothing to route on`);
  console.log(
    publishing && !keepLocal
      ? `they are in the bucket; ${out} holds only catalog.json`
      : `serve it with: npm run dev   (it reads ${out})`,
  );
}

type Built = { id: string; cell: Cell; entry: CatalogueCell };

async function buildOne(
  cell: Cell,
  source: CellSource,
  bucket?: Bucket,
): Promise<Built | undefined> {
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

  // What OpenStreetMap said, from the download's own header — not when this ran, so a
  // cell's age is something a refresh policy can trust (issues.md B6).
  const osm = new Date((source.osm ?? Date.now() / 1000) * 1000).toISOString();
  const packed = packCell(graph, cell, GENERATION, { osm });
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const digests = { index: sha(packed.index), graph: sha(packed.graph) };
  // The cell's identity, and the name its files are published under: derived from the
  // bytes, so a rebuild that changes nothing publishes nothing new.
  const hash = createHash("sha256")
    .update(`${digests.index}${digests.graph}`)
    .digest("hex")
    .slice(0, 16);

  // Straight to the bucket where there is one: a run covering a country is several
  // gigabytes of packs, and the disk it would sit on is the scarcest thing here.
  if (bucket) {
    await putCellFile(bucket, `cells/${id}/${hash}.index.ibx`, packed.index);
    await putCellFile(bucket, `cells/${id}/${hash}.graph.ibx`, packed.graph);
  }
  if (bucket && !keepLocal) {
    await fs.rm(`${out}/cells/${id}`, { recursive: true, force: true }).catch(() => undefined);
  } else {
    const directory = `${out}/cells/${id}`;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(`${directory}/${hash}.index.ibx`, packed.index);
    await fs.writeFile(`${directory}/${hash}.graph.ibx`, packed.graph);
  }

  return {
    id,
    cell,
    entry: {
      id,
      x: cell.x,
      y: cell.y,
      bbox: cellBBox(cell),
      hash,
      builtAt: new Date().toISOString(),
      osm,
      bytes: packed.index.length + packed.graph.length,
      blocks: packed.blocks,
      terrainCoverage: Number(coverage.toFixed(3)),
      files: [
        { path: "index.ibx" as const, bytes: packed.index.length, sha256: digests.index },
        { path: "graph.ibx" as const, bytes: packed.graph.length, sha256: digests.graph },
      ],
      nodes: graph.nodes.length,
      edges: graph.edges.length,
    },
  };
}

/**
 * Rewrite the catalogue with what this run built, keeping everything it did not touch.
 *
 * Cells arrive one at a time and a run covering the Alps must not erase Scotland, so the
 * previous catalogue is the starting point rather than the directory listing: it is the
 * only record of a cell's identity once the per-cell manifest went away.
 */
async function writeCatalogue(built: Built[], bucket?: Bucket) {
  const path = `${out}/catalog.json`;
  const existing = await readCatalogue();
  const cells = new Map<string, CatalogueCell>(
    (existing?.cells ?? []).map((cell) => [cell.id, cell]),
  );
  for (const item of built) cells.set(item.id, item.entry);

  const catalogue = {
    dataVersion: DATA_VERSION,
    generated: new Date().toISOString(),
    grid: { scheme: "xyz" as const, zoom, blockZoom: BLOCK_ZOOM, fieldZoom: FIELD_ZOOM },
    attribution:
      "© OpenStreetMap contributors · ODbL 1.0 | Terrain: Mapterhorn (see source attribution)",
    cells: [...cells.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  catalogueSchema.parse(catalogue);
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path, JSON.stringify(catalogue, null, 2));
  // Last, so it never names a file that is not up yet.
  if (bucket) await putCatalogue(bucket, catalogue);
  console.log(
    `catalogue: ${catalogue.cells.length} cells at ${path}${bucket ? " and in the bucket" : ""}`,
  );
}

/** The catalogue this build is adding to, if there is one. */
async function readCatalogue() {
  return fs
    .readFile(`${out}/catalog.json`, "utf8")
    .then((text) => catalogueSchema.parse(JSON.parse(text)))
    .catch(() => undefined);
}

await main();
