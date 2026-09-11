import { describe, expect, it } from "vitest";
import {
  MAX_LATITUDE,
  cellBBox,
  cellId,
  cellLabel,
  cellSizeM,
  cellsInBBox,
  childCells,
  latOfMercator,
  lonOfMercator,
  mercatorX,
  mercatorY,
  neighbours,
  parentCell,
  parseCellId,
  tileOf,
  unionBBox,
  type Cell,
} from "../src/geo/grid";
import type { Point } from "../src/routing/types";
import vectors from "./fixtures/grid-vectors.json";

const geneva: Point = [6.15, 46.2];
/** The published release: a 4x4 block of zoom-9 cells centred on Geneva. */
const release = { zoom: 9, x0: 263, y0: 180, x1: 266, y1: 183 };

describe("cell identity", () => {
  it("round-trips every id through parse and format", () => {
    const cells: Cell[] = [
      { zoom: 0, x: 0, y: 0 },
      { zoom: 9, x: 264, y: 181 },
      { zoom: 13, x: 4235, y: 2907 },
      { zoom: 15, x: 32767, y: 1 },
    ];
    for (const c of cells) expect(parseCellId(cellId(c))).toEqual(c);
  });
  it("uses hyphens so ids satisfy the pack manifest id pattern", () => {
    const id = cellId({ zoom: 9, x: 264, y: 181 });
    expect(id).toBe("9-264-181");
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(cellLabel({ zoom: 9, x: 264, y: 181 })).toBe("9/264/181");
  });
  it("rejects malformed and out-of-range ids", () => {
    for (const id of [
      "",
      "9/264/181",
      "9-264",
      "a-b-c",
      "9-264-181-2",
      "-1-0-0",
    ])
      expect(() => parseCellId(id)).toThrow();
    expect(() => parseCellId("2-4-0")).toThrow(/outside zoom/);
    expect(() => parseCellId("2-0-4")).toThrow(/outside zoom/);
    expect(() => cellId({ zoom: 99, x: 0, y: 0 })).toThrow(/Invalid grid zoom/);
  });
});

describe("tile lookup", () => {
  it("places Geneva in the centre cell of the release", () => {
    expect(cellId(tileOf(geneva, 9))).toBe("9-264-181");
    expect(cellId(tileOf(geneva, 13))).toBe("13-4235-2907");
  });
  it("agrees with the terrain tile maths already used by the build scripts", () => {
    // scripts/build_region.py tile_coord(p, z=12) for the same point.
    expect(tileOf(geneva, 12)).toEqual({ zoom: 12, x: 2117, y: 1453 });
  });
  it("clamps latitude at the Mercator cut-off instead of returning NaN", () => {
    const n = 2 ** 9;
    expect(tileOf([0, 89.9], 9).y).toBe(0);
    expect(tileOf([0, -89.9], 9).y).toBe(n - 1);
    expect(Number.isFinite(mercatorY(90))).toBe(true);
    expect(mercatorY(MAX_LATITUDE)).toBeCloseTo(0, 12);
  });
  it("wraps longitude across the antimeridian", () => {
    const n = 2 ** 9;
    expect(tileOf([180, 0], 9).x).toBe(0);
    expect(tileOf([-180, 0], 9).x).toBe(0);
    expect(tileOf([179.999, 0], 9).x).toBe(n - 1);
  });
});

describe("cell bounds", () => {
  it("returns [west, south, east, north] matching the release window", () => {
    const nw = cellBBox({ zoom: 9, x: release.x0, y: release.y0 });
    const se = cellBBox({ zoom: 9, x: release.x1, y: release.y1 });
    const bbox = unionBBox([nw, se]);
    expect(bbox[0]).toBeCloseTo(4.921875, 6);
    expect(bbox[2]).toBeCloseTo(7.734375, 6);
    expect(bbox[1]).toBeCloseTo(45.089036, 5);
    expect(bbox[3]).toBeCloseTo(47.040182, 5);
    expect(bbox[0]).toBeLessThan(bbox[2]);
    expect(bbox[1]).toBeLessThan(bbox[3]);
  });
  it("tiles the plane without gaps or overlaps", () => {
    const a = cellBBox({ zoom: 9, x: 264, y: 181 });
    const east = cellBBox({ zoom: 9, x: 265, y: 181 });
    const south = cellBBox({ zoom: 9, x: 264, y: 182 });
    expect(a[2]).toBeCloseTo(east[0], 12);
    expect(a[1]).toBeCloseTo(south[3], 12);
  });
  it("round-trips mercator projection", () => {
    for (const lon of [-180, -6.5, 0, 6.15, 179.9])
      expect(lonOfMercator(mercatorX(lon))).toBeCloseTo(lon, 10);
    for (const lat of [-84, -46.2, 0, 46.2, 84])
      expect(latOfMercator(mercatorY(lat))).toBeCloseTo(lat, 10);
  });
  it("reports a plausible ground size", () => {
    expect(cellSizeM({ zoom: 9, x: 264, y: 181 }) / 1000).toBeCloseTo(54.2, 0);
    expect(cellSizeM({ zoom: 13, x: 4235, y: 2907 }) / 1000).toBeCloseTo(
      3.4,
      0,
    );
  });
});

describe("cells covering a bbox", () => {
  it("covers the release window with exactly sixteen zoom-9 cells", () => {
    const bbox = unionBBox([
      cellBBox({ zoom: 9, x: release.x0, y: release.y0 }),
      cellBBox({ zoom: 9, x: release.x1, y: release.y1 }),
    ]);
    const cells = cellsInBBox(bbox, 9);
    expect(cells).toHaveLength(16);
    expect(cells.map(cellId)).toContain("9-263-180");
    expect(cells.map(cellId)).toContain("9-266-183");
    expect(new Set(cells.map(cellId)).size).toBe(16);
  });
  it("does not add a spurious row or column for an exact tile boundary", () => {
    const cell = { zoom: 9, x: 264, y: 181 };
    expect(cellsInBBox(cellBBox(cell), 9).map(cellId)).toEqual([cellId(cell)]);
    expect(cellsInBBox(cellBBox(cell), 13)).toHaveLength(256);
  });
  it("returns one cell for a degenerate bbox", () => {
    const point: [number, number] = [6.15, 46.2];
    const cells = cellsInBBox([...point, ...point] as never, 9);
    expect(cells.map(cellId)).toEqual(["9-264-181"]);
  });
  it("covers a bbox that straddles two cells", () => {
    const west = cellBBox({ zoom: 9, x: 264, y: 181 });
    const bbox: [number, number, number, number] = [
      west[2] - 0.01,
      west[1] + 0.01,
      west[2] + 0.01,
      west[3] - 0.01,
    ];
    expect(cellsInBBox(bbox, 9).map(cellId)).toEqual([
      "9-264-181",
      "9-265-181",
    ]);
  });
});

describe("cell hierarchy", () => {
  it("subdivides a download cell into 256 graph blocks", () => {
    const cell = { zoom: 9, x: 264, y: 181 };
    const blocks = childCells(cell, 13);
    expect(blocks).toHaveLength(256);
    expect(new Set(blocks.map(cellId)).size).toBe(256);
    for (const block of blocks) expect(parentCell(block, 9)).toEqual(cell);
  });
  it("returns itself at its own zoom", () => {
    const cell = { zoom: 9, x: 264, y: 181 };
    expect(childCells(cell, 9)).toEqual([cell]);
    expect(parentCell(cell, 9)).toEqual(cell);
  });
  it("refuses an inverted hierarchy", () => {
    expect(() => childCells({ zoom: 13, x: 0, y: 0 }, 9)).toThrow(/coarser/);
    expect(() => parentCell({ zoom: 9, x: 0, y: 0 }, 13)).toThrow(/finer/);
  });
  it("keeps every block inside its parent's bounds", () => {
    const parent = cellBBox({ zoom: 9, x: 264, y: 181 });
    for (const block of childCells({ zoom: 9, x: 264, y: 181 }, 13)) {
      const b = cellBBox(block);
      expect(b[0]).toBeGreaterThanOrEqual(parent[0] - 1e-9);
      expect(b[2]).toBeLessThanOrEqual(parent[2] + 1e-9);
      expect(b[1]).toBeGreaterThanOrEqual(parent[1] - 1e-9);
      expect(b[3]).toBeLessThanOrEqual(parent[3] + 1e-9);
    }
  });
});

describe("neighbours", () => {
  it("returns eight cells inside the grid", () => {
    expect(neighbours({ zoom: 9, x: 264, y: 181 })).toHaveLength(8);
  });
  it("wraps in x and drops rows beyond the poles", () => {
    const top = neighbours({ zoom: 2, x: 0, y: 0 });
    expect(top).toHaveLength(5);
    expect(top.every((c) => c.y >= 0)).toBe(true);
    expect(top.map(cellId)).toContain("2-3-0");
    const bottom = neighbours({ zoom: 2, x: 3, y: 3 });
    expect(bottom).toHaveLength(5);
    expect(bottom.map(cellId)).toContain("2-0-3");
  });
});

describe("shared vectors", () => {
  // Generated from this module by scripts/gen_grid_vectors.ts and also asserted by
  // scripts/test_grid.py, so the TypeScript and Python grids cannot drift apart.
  it("matches the fixture the Python mirror is tested against", () => {
    for (const c of vectors.mercator) {
      expect(mercatorX(c.point[0])).toBeCloseTo(c.x, 12);
      expect(mercatorY(c.point[1])).toBeCloseTo(c.y, 12);
      expect(lonOfMercator(mercatorX(c.point[0]))).toBeCloseTo(c.lon, 10);
      expect(latOfMercator(mercatorY(c.point[1]))).toBeCloseTo(c.lat, 10);
    }
    for (const c of vectors.tileOf)
      expect(cellId(tileOf(c.point as Point, c.zoom))).toBe(c.id);
    for (const c of vectors.bounds) {
      const cell = parseCellId(c.id);
      cellBBox(cell).forEach((v, i) => expect(v).toBeCloseTo(c.bbox[i], 10));
      expect(cellSizeM(cell)).toBeCloseTo(c.sizeM, 3);
    }
    for (const c of vectors.cellsInBBox) {
      const cells = cellsInBBox(c.bbox as never, c.zoom);
      if (c.ids) expect(cells.map(cellId)).toEqual(c.ids);
      else expect(cells).toHaveLength(c.count as number);
    }
    for (const c of vectors.neighbours)
      expect(neighbours(parseCellId(c.id)).map(cellId)).toEqual(c.ids);
    for (const c of vectors.hierarchy) {
      const blocks = childCells(parseCellId(c.id), c.blockZoom);
      expect(blocks).toHaveLength(c.blockCount);
      expect(cellId(blocks[0])).toBe(c.firstBlock);
      expect(cellId(blocks[blocks.length - 1])).toBe(c.lastBlock);
      expect(cellId(parentCell(blocks[0], c.parentZoom))).toBe(
        c.parentOfFirstBlock,
      );
    }
  });
  it("still describes the sixteen published release cells", () => {
    expect(vectors.release.ids).toHaveLength(16);
    expect(vectors.release.ids[0]).toBe("9-263-180");
    expect(vectors.release.ids.at(-1)).toBe("9-266-183");
  });
});
