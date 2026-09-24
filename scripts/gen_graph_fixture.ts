/**
 * Regenerate a real-data routing fixture from the installed release.
 *
 * Clips the real graph to a region's bbox and writes it as gzipped JSON, so tests exercise
 * real OSM tags, terrain and topology in Node without the packs. A region is either one
 * of `REGIONS` or a gold standard, `gold/<name>`: its graph is the corridor around the
 * gold line, which keeps every local alternative to it and none of the city beyond. Cases
 * that name the same `graph` share one, the corridor around all of their lines.
 *
 *   node --import tsx scripts/gen_graph_fixture.ts <region | gold/name> [packs dir]
 */
import { readdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { BBox } from "../src/geo/grid";
import type { Graph, Point } from "../src/routing/types";
import { distance } from "../src/geo/distance";
import { DEFAULT_CELLS, openLocalProvider } from "./local_cells";
import { goldGraphName, goldGraphPath, goldPath, loadGold } from "./gold_route";

type Region = {
  bbox: BBox;
  required: string[];
  /** Keep only edges within `radiusM` of these lines: their alternatives, not a whole city. */
  corridor?: { lines: Point[][]; radiusM: number };
  /** Where to write it, when not `tests/fixtures/<name>-graph.json.gz`. */
  out?: string;
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

/**
 * The corridor must hold every alternative the app would weigh, or the fixture hides the
 * router's mistakes. At 1 km the Voirons tour scored 91.8% on its fixture and 63.2% in
 * the app: the climb the router prefers, through Machilly, lies 1.5-2 km off the line.
 * 2.5 km is where the fixture first agrees with the full packs; `gold_route.ts audit`
 * with a packs directory checks that it still does.
 */
const GOLD_RADIUS_M = 2500;

/** Every case that shares `name`'s graph, and the file they share. */
function goldRegion(name: string): Region {
  const graph = goldGraphName(name);
  const lines = readdirSync("tests/fixtures/gold")
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((other) => goldGraphName(other) === graph)
    .map((other) => loadGold(goldPath(other)).line);
  const line = lines.flat();
  // Wide enough that the bbox never clips the corridor.
  const lat = line[0][1];
  const padLat = GOLD_RADIUS_M / 111_320;
  const padLon = padLat / Math.cos((lat * Math.PI) / 180);
  return {
    bbox: [
      Math.min(...line.map((p) => p[0])) - padLon,
      Math.min(...line.map((p) => p[1])) - padLat,
      Math.max(...line.map((p) => p[0])) + padLon,
      Math.max(...line.map((p) => p[1])) + padLat,
    ],
    required: [],
    corridor: { lines, radiusM: GOLD_RADIUS_M },
    out: goldGraphPath(name),
  };
}

const name = process.argv[2] ?? "";
const region = name.startsWith("gold/")
  ? goldRegion(name.slice("gold/".length))
  : REGIONS[name];
if (!region)
  throw new Error(
    `Unknown region "${name}": ${Object.keys(REGIONS).join(", ")}, or gold/<name>`,
  );
const DIR = process.argv[3] ?? DEFAULT_CELLS;
const OUT = region.out ?? `tests/fixtures/${name}-graph.json.gz`;
const BBOX = region.bbox;

/** Within `radiusM` of the lines' vertices, which are dense enough to stand for them. */
function corridorTest(corridor: Region["corridor"]): (p: Point) => boolean {
  if (!corridor) return () => true;
  const cell = 0.01;
  const index = new Map<string, Point[]>();
  const key = (x: number, y: number) => `${x},${y}`;
  for (const p of corridor.lines.flat()) {
    const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell));
    index.set(k, [...(index.get(k) ?? []), p]);
  }
  // A cell is at least 770 m wide here, so search as many rings as the radius spans.
  const rings = Math.ceil(corridor.radiusM / 770);
  return (p) => {
    const cx = Math.floor(p[0] / cell),
      cy = Math.floor(p[1] / cell);
    for (let dx = -rings; dx <= rings; dx++)
      for (let dy = -rings; dy <= rings; dy++)
        for (const q of index.get(key(cx + dx, cy + dy)) ?? [])
          if (distance(p, q) <= corridor.radiusM) return true;
    return false;
  };
}

const provider = await openLocalProvider(DIR);
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
    `(${DIR})`,
);
