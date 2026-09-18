/**
 * Regenerate a real-data routing fixture from the installed release.
 *
 * Clips the real graph to a region's bbox and writes it as gzipped JSON, so tests exercise
 * real OSM tags, terrain and topology in Node without the packs. A region is either one
 * of `REGIONS` or a gold standard, `gold/<name>`: its graph is the corridor around the
 * gold line, which keeps every local alternative to it and none of the city beyond.
 *
 *   node --import tsx scripts/gen_graph_fixture.ts <region | gold/name> [packs dir]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { CellGraphProvider, type PackReader } from "../src/routing/provider";
import type { Installed } from "../src/offline/store";
import type { BBox } from "../src/geo/grid";
import type { Graph, Point } from "../src/routing/types";
import { distance } from "../src/geo/distance";
import { DEFAULT_RELEASE } from "./local_release";

type Region = {
  bbox: BBox;
  required: string[];
  /** Keep only edges within `radiusM` of this line: its alternatives, not a whole city. */
  corridor?: { line: string; radiusM: number };
};
const REGIONS: Record<string, Region> = {
  /**
   * The Sentier du Sauget, reaching west to the small road bridges over the Menoge. They
   * are cut vertices between the Geneva plain and the massif and must never take a grade
   * from the terrain below; losing them would lose the regression they guard.
   */
  voirons: {
    bbox: [6.3, 46.2, 6.38, 46.25],
    required: ["252371604", "894021116", "590804167"],
  },
  /** Both the preferred gravel corridor and the reported bad shortcut must survive. */
  coudry: {
    bbox: [6.225, 46.15, 6.36, 46.195],
    required: ["182450223", "47394162", "109843020"],
  },
};

/** A kilometre either side of a gold line holds its alternatives: see `scripts/gold_route.ts`. */
const GOLD_RADIUS_M = 1000;

function goldRegion(path: string): Region {
  const line: Point[] = JSON.parse(readFileSync(path, "utf8")).line;
  // 0.015 degrees is more than the corridor radius at these latitudes.
  const pad = 0.015;
  return {
    bbox: [
      Math.min(...line.map((p) => p[0])) - pad,
      Math.min(...line.map((p) => p[1])) - pad,
      Math.max(...line.map((p) => p[0])) + pad,
      Math.max(...line.map((p) => p[1])) + pad,
    ],
    required: [],
    corridor: { line: path, radiusM: GOLD_RADIUS_M },
  };
}

const name = process.argv[2] ?? "";
const region = name.startsWith("gold/")
  ? goldRegion(`tests/fixtures/${name}.json`)
  : REGIONS[name];
if (!region)
  throw new Error(
    `Unknown region "${name}": ${Object.keys(REGIONS).join(", ")}, or gold/<name>`,
  );
const DIR = process.argv[3] ?? DEFAULT_RELEASE;
const OUT = `tests/fixtures/${name}-graph.json.gz`;
const BBOX = region.bbox;

/** Within `radiusM` of the line's vertices, which are dense enough to stand for it. */
function corridorTest(corridor: Region["corridor"]): (p: Point) => boolean {
  if (!corridor) return () => true;
  const line: Point[] = JSON.parse(readFileSync(corridor.line, "utf8")).line;
  const cell = 0.01;
  const index = new Map<string, Point[]>();
  const key = (x: number, y: number) => `${x},${y}`;
  for (const p of line) {
    const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell));
    index.set(k, [...(index.get(k) ?? []), p]);
  }
  return (p) => {
    const cx = Math.floor(p[0] / cell),
      cy = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const q of index.get(key(cx + dx, cy + dy)) ?? [])
          if (distance(p, q) <= corridor.radiusM) return true;
    return false;
  };
}

const read = (path: string) => new Uint8Array(readFileSync(path));
const catalogue = JSON.parse(readFileSync(`${DIR}/catalogue.json`, "utf8"));
const packs: Installed[] = catalogue.cells.map(
  (cell: { id: string }) =>
    ({
      manifest: JSON.parse(
        readFileSync(`${DIR}/${cell.id}/manifest.json`, "utf8"),
      ),
      installedAt: "1970-01-01T00:00:00.000Z",
      directory: cell.id,
      backend: "idb",
    }) as Installed,
);
const reader: PackReader = {
  async readFile(pack, path) {
    return read(`${DIR}/${pack.manifest.id}/${path}`).buffer.slice(
      0,
    ) as ArrayBuffer;
  },
  async readRange(pack, path, offset, length) {
    const bytes = read(`${DIR}/${pack.manifest.id}/${path}`);
    return bytes.slice(offset, offset + length).buffer as ArrayBuffer;
  },
};

const provider = new CellGraphProvider(
  packs,
  catalogue.release,
  catalogue.cells,
  reader,
);
await provider.open();
const loaded = await provider.load(BBOX);

const inside = (p: Point) =>
  p[0] >= BBOX[0] && p[0] <= BBOX[2] && p[1] >= BBOX[1] && p[1] <= BBOX[3];
const near = corridorTest(region.corridor);
// Complete geometry only: a half-clipped edge would be a road that stops in mid-air.
const edges = loaded.edges.filter(
  (e) => e.geometry.every(inside) && e.geometry.every(near),
);
const endpoints = new Set(edges.flatMap((e) => [e.from, e.to]));
const nodes = loaded.nodes.filter((n) => endpoints.has(n.id));
const ways = new Set(edges.map((e) => e.way));
const restrictions = loaded.restrictions.filter((r) =>
  r.ways.every((w) => ways.has(w)),
);

const missing = region.required.filter((w) => !ways.has(w));
if (missing.length)
  throw new Error(
    `Clip dropped ways the regression depends on: ${missing.join(", ")}. ` +
      `Widen the "${name}" bbox or update its required ways alongside its tests.`,
  );

const graph: Graph = {
  schemaVersion: 1,
  bbox: BBOX,
  nodes,
  edges,
  restrictions,
};
const bytes = gzipSync(JSON.stringify(graph), { level: 9 });
writeFileSync(OUT, bytes);
console.log(
  `${OUT}: ${edges.length} edges, ${nodes.length} nodes, ` +
    `${restrictions.length} restrictions, ${(bytes.length / 1024).toFixed(0)} KB gzipped ` +
    `(release ${catalogue.release})`,
);
