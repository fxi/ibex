/** Generate the two-cell development catalogue used by unit and browser tests. */
import { mkdirSync, writeFileSync } from "node:fs";
import { cellBBox, cellId } from "../src/geo/grid";
import { DATA_VERSION } from "../src/offline/version";

const directory = "tests/fixtures/grid-fixture";
const zoom = 9;
// Two horizontally adjacent cells, so the shared meridian carries the cross-boundary edge.
const cells = [
  { zoom, x: 264, y: 181 },
  { zoom, x: 265, y: 181 },
];
mkdirSync(directory, { recursive: true });
const catalogue = {
  dataVersion: DATA_VERSION,
  grid: { scheme: "xyz", zoom, blockZoom: 13, fieldZoom: 15 },
  generated: "1970-01-01T00:00:00.000Z",
  attribution: "Synthetic test data — not a real cycling network",
  cells: cells.map((cell) => ({
    id: cellId(cell),
    x: cell.x,
    y: cell.y,
    bbox: cellBBox(cell).map((v) => Number(v.toFixed(7))),
    hash: `f1x7ade0000000${cell.x.toString(16)}`.replace(/[^a-f0-9]/g, "0"),
    builtAt: "1970-01-01T00:00:00.000Z",
    osm: "1970-01-01T00:00:00.000Z",
    bytes: 4096,
    blocks: 1,
    terrainCoverage: 1,
    files: [
      { path: "index.ibx" as const, bytes: 96, sha256: "0".repeat(64) },
      { path: "graph.ibx" as const, bytes: 4000, sha256: "1".repeat(64) },
    ],
  })),
};
writeFileSync(
  `${directory}/catalog.json`,
  JSON.stringify(catalogue, null, 2) + "\n",
);
console.log(
  `wrote ${directory}/catalog.json with ${catalogue.cells.length} cells:`,
  catalogue.cells.map((c) => c.id).join(", "),
);
