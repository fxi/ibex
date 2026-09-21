import { describe, expect, it } from "vitest";
import { corridorCells } from "../src/routing/field";
import type { Field } from "../src/routing/types";

/** A bare field with one path cell, enough to exercise the disk `corridorCells` draws. */
const field = (width: number, height: number, x: number, y: number): Field => ({
  width,
  height,
  cellM: 700,
  bbox: [0, 0, 1, 1],
  costs: [],
  paths: [[y * width + x]],
});

describe("corridorCells", () => {
  // `detour: "avoid"` has corridor_cells 3, and the engine's second expansion is 2.5x it.
  // Fractional offsets used to produce ids no cell could match, so the corridor rejected
  // every edge and the search fell through to the whole graph for no reason.
  it.each([
    ["even width", 20],
    ["odd width", 21],
  ])("keeps ids on the grid at a fractional radius (%s)", (_name, width) => {
    const ids = corridorCells(field(width, 20, 10, 10), 7.5);
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) expect(Number.isInteger(id)).toBe(true);
    expect(ids.has(10 * width + 10)).toBe(true);
  });

  it("keeps the circle, so a wider radius only adds", () => {
    const f = field(40, 40, 20, 20);
    const small = corridorCells(f, 3);
    const large = corridorCells(f, 7.5);
    for (const id of small) expect(large.has(id)).toBe(true);
    expect(large.size).toBeGreaterThan(small.size);
    // Still a disk, not the bounding square of ceil(7.5).
    expect(large.size).toBeLessThan(15 * 15);
  });

  it("stays inside the field", () => {
    const ids = corridorCells(field(8, 8, 0, 0), 7.5);
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(8 * 8);
      expect(id % 8).toBeLessThanOrEqual(7);
    }
  });
});
