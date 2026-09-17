/** Regenerate the public OSM/terrain Coudry regression fixture; no personal GPX is included. */
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { CellGraphProvider, type PackReader } from "../src/routing/provider";
import type { Installed } from "../src/offline/store";
import type { BBox } from "../src/geo/grid";
import type { Graph, Point } from "../src/routing/types";
import { DEFAULT_RELEASE } from "./local_release";

const DIR = process.argv[2] ?? DEFAULT_RELEASE;
const OUT = process.argv[3] ?? "tests/fixtures/coudry-graph.json.gz";
const BBOX: BBox = [6.225, 46.15, 6.36, 46.195];
/** Both the preferred gravel corridor and the reported bad shortcut must survive. */
const REQUIRED_WAYS = ["182450223", "47394162", "109843020"];

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
// Complete geometry only: a half-clipped edge would be a road that stops in mid-air.
const edges = loaded.edges.filter((e) => e.geometry.every(inside));
const endpoints = new Set(edges.flatMap((e) => [e.from, e.to]));
const nodes = loaded.nodes.filter((n) => endpoints.has(n.id));
const ways = new Set(edges.map((e) => e.way));
const restrictions = loaded.restrictions.filter((r) =>
  r.ways.every((w) => ways.has(w)),
);

const missing = REQUIRED_WAYS.filter((w) => !ways.has(w));
if (missing.length)
  throw new Error(
    `Clip dropped ways the regression depends on: ${missing.join(", ")}. ` +
      `Widen BBOX or update REQUIRED_WAYS alongside tests/voirons.test.ts.`,
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
