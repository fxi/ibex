/**
 * Build one cell's graph from its extract, in TypeScript.
 *
 * The counterpart of `scripts/build_region.py`, and the thing an on-demand builder runs.
 * Terrain is fetched here rather than in `src/build/` so the graph code stays free of I/O
 * and can run unchanged in a worker.
 *
 *   node --import tsx scripts/build_cell.ts <cell.osm.pbf> <output dir> --cell 9-264-181
 *
 * `--no-terrain` skips the DEM entirely, which is what a parity run against the Python
 * builder uses; `--terrain-cache` points at the shared tile cache (default `data/terrain`).
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { readSource } from "../src/build/osm/source";
import { inflate } from "../src/build/platform/node";
import { buildGraph } from "../src/build/graph";
import { parseCellId } from "../src/geo/grid";
import { sampleTerrain, TERRAIN_ZOOM } from "../src/build/platform/terrainCache";
import { COST_MODEL_VERSION } from "../src/routing/types";

/** Mirrors `region_config.PREPROCESSOR_VERSION`; raised when the edge data changes. */
const PREPROCESSOR_VERSION = 9;

/** `foo.osm.pbf` is written beside `foo.osm.source.json` by clip_region.py. */
async function osmTimestamp(pbf: string): Promise<string> {
  try {
    const meta = JSON.parse(await fs.readFile(pbf.replace(/\.pbf$/, ".source.json"), "utf8"));
    return meta.osmTimestamp ?? "unknown";
  } catch {
    return "unknown";
  }
}

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const [input, output] = positional;
if (!input || !output) {
  console.error("usage: build_cell.ts <cell.osm.pbf> <output dir> [--cell z-x-y] [--no-terrain]");
  process.exit(2);
}
const cellId = option("cell");
const cell = cellId ? parseCellId(cellId) : undefined;

const started = Date.now();
const bytes = new Uint8Array(await fs.readFile(input));
const source = await readSource(bytes, inflate);
console.log(
  `read ${source.ways.length} ways, ${source.relations.length} relations, ` +
    `${source.positions.size} nodes in ${Date.now() - started} ms`,
);

let elevations = new Map<number, number>();
if (!flag("no-terrain")) {
  // Only the nodes that road ways use need a height, which is a fraction of the extract.
  const wanted = new Map<number, [number, number]>();
  for (const way of source.ways) {
    if (!("highway" in way.tags) && way.tags.route !== "ferry") continue;
    for (const ref of way.refs) {
      const p = source.positions.get(ref);
      if (p) wanted.set(ref, p);
    }
  }
  elevations = await sampleTerrain(wanted, option("terrain-cache") ?? "data/terrain");
  console.log(`sampled terrain for ${elevations.size} of ${wanted.size} positions`);
}

const { graph, counts } = buildGraph(source, { cell, elevations });
console.log(`built ${counts.edges} edges, ${counts.nodes} nodes in ${Date.now() - started} ms`);

await fs.mkdir(output, { recursive: true });
const blob = Buffer.from(JSON.stringify(graph));
await fs.writeFile(`${output}/graph.json`, blob);

// The manifest `package_cells.ts` reads: same shape build_region.py writes, so a cell built
// here packages through the existing pipeline unchanged.
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const files = [{ path: "graph.json", bytes: blob.length, sha256: sha256(blob) }];
const coverage =
  graph.edges.length === 0
    ? 0
    : Number((graph.edges.filter((e) => e.grades !== null).length / graph.edges.length).toFixed(3));
const name = cellId ?? "region";
await fs.writeFile(
  `${output}/manifest.json`,
  JSON.stringify(
    {
      schemaVersion: 1,
      id: name,
      name,
      version: createHash("sha256")
        .update(files.map((f) => f.sha256).join(""))
        .digest("hex")
        .slice(0, 16),
      bbox: graph.bbox,
      osmTimestamp: await osmTimestamp(input),
      costModelVersion: COST_MODEL_VERSION,
      source: {
        osmSha256: sha256(Buffer.from(bytes)),
        osmFile: input.split("/").pop(),
        preprocessorVersion: PREPROCESSOR_VERSION,
      },
      terrainSource: flag("no-terrain") ? null : `Mapterhorn Terrarium z${TERRAIN_ZOOM}`,
      terrainCoverage: coverage,
      attribution:
        "© OpenStreetMap contributors · ODbL 1.0 | Terrain: Mapterhorn (see source attribution)",
      files,
      build: counts,
    },
    null,
    2,
  ),
);
console.log(`wrote ${output}/graph.json (${(blob.length / 1e6).toFixed(1)} MB)`);
console.log(JSON.stringify(counts, null, 2));
