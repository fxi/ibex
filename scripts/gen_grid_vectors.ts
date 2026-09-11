import { writeFileSync } from "node:fs";
import {
  cellBBox, cellId, cellSizeM, cellsInBBox, childCells, latOfMercator,
  lonOfMercator, mercatorX, mercatorY, neighbours, parentCell, tileOf,
} from "../src/geo/grid";

const points: [number, number][] = [
  [6.15, 46.2], [0, 0], [-180, 0], [179.999, 0], [180, 0],
  [6.15, 85.5], [6.15, -85.5], [-6.5, 46.2], [7.734375, 45.089036],
];
const cells = [
  { zoom: 0, x: 0, y: 0 }, { zoom: 2, x: 0, y: 0 }, { zoom: 2, x: 3, y: 3 },
  { zoom: 9, x: 263, y: 180 }, { zoom: 9, x: 264, y: 181 }, { zoom: 9, x: 266, y: 183 },
  { zoom: 12, x: 2117, y: 1453 }, { zoom: 13, x: 4235, y: 2907 },
];
const release = cellsInBBox(
  [
    cellBBox({ zoom: 9, x: 263, y: 180 })[0], cellBBox({ zoom: 9, x: 266, y: 183 })[1],
    cellBBox({ zoom: 9, x: 266, y: 183 })[2], cellBBox({ zoom: 9, x: 263, y: 180 })[3],
  ],
  9,
);
writeFileSync(
  "tests/fixtures/grid-vectors.json",
  JSON.stringify(
    {
      comment:
        "Generated from src/geo/grid.ts. Shared by tests/grid.test.ts and scripts/test_grid.py so the two implementations cannot drift. Regenerate with scripts/gen_grid_vectors.ts.",
      mercator: points.map((p) => ({
        point: p, x: mercatorX(p[0]), y: mercatorY(p[1]),
        lon: lonOfMercator(mercatorX(p[0])), lat: latOfMercator(mercatorY(p[1])),
      })),
      tileOf: points.flatMap((p) =>
        [9, 12, 13].map((zoom) => ({ point: p, zoom, id: cellId(tileOf(p, zoom)) })),
      ),
      bounds: cells.map((c) => ({ id: cellId(c), bbox: cellBBox(c), sizeM: cellSizeM(c) })),
      cellsInBBox: [
        { bbox: cellBBox({ zoom: 9, x: 264, y: 181 }), zoom: 9, ids: cellsInBBox(cellBBox({ zoom: 9, x: 264, y: 181 }), 9).map(cellId) },
        { bbox: cellBBox({ zoom: 9, x: 264, y: 181 }), zoom: 13, count: 256 },
        { bbox: [6.15, 46.2, 6.15, 46.2], zoom: 9, ids: cellsInBBox([6.15, 46.2, 6.15, 46.2], 9).map(cellId) },
      ],
      release: { window: "9/263/180..9/266/183", ids: release.map(cellId) },
      hierarchy: cells
        .filter((c) => c.zoom === 9)
        .map((c) => ({
          id: cellId(c),
          blockZoom: 13,
          blockCount: childCells(c, 13).length,
          firstBlock: cellId(childCells(c, 13)[0]),
          lastBlock: cellId(childCells(c, 13)[childCells(c, 13).length - 1]),
          parentZoom: 9,
          parentOfFirstBlock: cellId(parentCell(childCells(c, 13)[0], 9)),
        })),
      neighbours: cells.map((c) => ({ id: cellId(c), ids: neighbours(c).map(cellId) })),
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote tests/fixtures/grid-vectors.json");
