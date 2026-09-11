/** Generate the two-cell development catalogue used by unit and browser tests. */
import { mkdirSync, writeFileSync } from "node:fs";
import { cellBBox, cellId } from "../src/geo/grid";
import { COST_MODEL_VERSION } from "../src/routing/types";

const directory = "public/packs/grid-fixture";
const zoom = 9;
// Two horizontally adjacent cells, so the shared meridian carries the cross-boundary edge.
const cells = [
  { zoom, x: 264, y: 181 },
  { zoom, x: 265, y: 181 },
];
mkdirSync(directory, { recursive: true });
const catalogue = {
  schemaVersion: 1,
  release: "fixture-g4-0000",
  grid: { scheme: "xyz", zoom, blockZoom: 13, fieldZoom: 15 },
  costModelVersion: COST_MODEL_VERSION,
  formatVersion: 1,
  osmTimestamp: "synthetic",
  generated: "1970-01-01T00:00:00.000Z",
  attribution: "Synthetic test data — not a real cycling network",
  cells: cells.map((cell) => ({
    id: cellId(cell),
    x: cell.x,
    y: cell.y,
    bbox: cellBBox(cell).map((v) => Number(v.toFixed(7))),
    manifest: `${cellId(cell)}/manifest.json`,
    version: "fixture0000",
    bytes: 4096,
    available: true,
  })),
};
writeFileSync(
  `${directory}/catalogue.json`,
  JSON.stringify(catalogue, null, 2) + "\n",
);
console.log(
  `wrote ${directory}/catalogue.json with ${catalogue.cells.length} cells:`,
  catalogue.cells.map((c) => c.id).join(", "),
);
