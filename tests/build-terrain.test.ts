/**
 * Way profiles and grades.
 *
 * Unlike the cost surfaces, this is arithmetic with a right answer: a grade decides whether
 * an edge is rideable at all, and the smoothing window exists because getting it wrong once
 * closed a real pass. So these check the rules exactly, and the incline cases are the ones
 * where JavaScript and Python disagree about what a number is if you let them.
 */
import { describe, expect, it } from "vitest";
import {
  bilinearHeight,
  numericIncline,
  sliceProfile,
  structureGrade,
  terrariumHeight,
  wayProfile,
  type HeightTile,
} from "../src/build/terrain";
import type { Point } from "../src/routing/types";

describe("numericIncline", () => {
  it("reads percentages, with or without the sign or the unit", () => {
    expect(numericIncline("5")).toBe(0.05);
    expect(numericIncline("5%")).toBe(0.05);
    expect(numericIncline("-7.5%")).toBe(-0.075);
    expect(numericIncline(" 12 % ")).toBe(0.12);
  });

  it("reads degrees as a tangent", () => {
    expect(numericIncline("10°")).toBeCloseTo(0.17632698070846498, 15);
    // Scaled by a single pi/180 constant, as Python's math.radians is; dividing after
    // multiplying disagrees in the last bit.
    expect(numericIncline("-3°")).toBe(-0.05240777928304121);
  });

  it("clamps what it reads", () => {
    expect(numericIncline("100%")).toBe(0.45);
    expect(numericIncline("-100%")).toBe(-0.45);
    expect(numericIncline("45°")).toBe(0.45);
  });

  it("returns nothing for a value it cannot read", () => {
    for (const value of ["up", "down", "", "  ", "abc", "nan", "inf", undefined])
      expect(numericIncline(value)).toBeUndefined();
  });

  it("refuses a unit with no number, which Number() would read as zero", () => {
    // The distinction that matters: "%" is missing information, not flat ground.
    expect(numericIncline("%")).toBeUndefined();
    expect(numericIncline("°")).toBeUndefined();
    expect(numericIncline("0")).toBe(0);
  });
});

describe("structureGrade", () => {
  it("is flat unless the incline says otherwise", () => {
    expect(structureGrade()).toBe(0);
    expect(structureGrade("up")).toBe(0);
    expect(structureGrade("-7.5%")).toBe(-0.075);
  });
});

describe("wayProfile", () => {
  const ids = Array.from({ length: 10 }, (_, i) => i);
  const positions = new Map<number, Point>(ids.map((i) => [i, [6.0 + i * 0.001, 46.0]]));
  const climbing = new Map<number, number>(ids.map((i) => [i, 400 + i * i * 1.5]));

  it("cuts the way into runs and measures each against the smoothing window", () => {
    const { offsets, samples } = wayProfile(ids, positions, climbing);
    expect(offsets).toHaveLength(ids.length);
    expect(offsets[0]).toBe(0);
    expect(offsets[9]).toBeCloseTo(695.182379, 5);
    expect(samples).toBeDefined();
    // 20 m runs across ~695 m.
    expect(samples!).toHaveLength(35);
    expect(samples!.every(([, , grade]) => grade > 0)).toBe(true);
    // A rising profile gets steeper along its length.
    expect(samples![34][2]).toBeGreaterThan(samples![0][2]);
  });

  it("gives a way shorter than a tenth of a metre no profile at all", () => {
    const short = wayProfile(
      [0, 1],
      new Map<number, Point>([
        [0, [6.0, 46.0]],
        [1, [6.0000001, 46.0]],
      ]),
      new Map([
        [0, 400],
        [1, 400],
      ]),
    );
    expect(short.samples).toBeUndefined();
  });

  it("falls back to the tag when the DEM is missing a node, and to nothing without one", () => {
    const partial = new Map(ids.slice(0, -1).map((i) => [i, 400]));
    // One run spanning the whole way at the tagged grade, however long the way turns out.
    const tagged = wayProfile(ids, positions, partial, "8%");
    expect(tagged.samples).toEqual([[0, tagged.offsets[tagged.offsets.length - 1], 0.08]]);
    expect(wayProfile(ids, positions, new Map()).samples).toBeUndefined();
  });

  it("never reports a grade past the clamp", () => {
    const cliff = new Map<number, number>(ids.map((i) => [i, 400 + i * 1000]));
    const { samples } = wayProfile(ids, positions, cliff);
    expect(samples!.every(([, , grade]) => grade <= 0.45)).toBe(true);
  });
});

describe("sliceProfile", () => {
  const ids = Array.from({ length: 10 }, (_, i) => i);
  const positions = new Map<number, Point>(ids.map((i) => [i, [6.0 + i * 0.001, 46.0]]));
  const elevations = new Map<number, number>(ids.map((i) => [i, 400 + i * i * 1.5]));
  const { samples } = wayProfile(ids, positions, elevations);

  it("covers exactly the span asked for", () => {
    const slice = sliceProfile(samples, 0, 100)!;
    expect(slice.reduce((sum, [metres]) => sum + metres, 0)).toBeCloseTo(100, 6);
  });

  it("clips partial runs at both ends", () => {
    const slice = sliceProfile(samples, 50, 150)!;
    expect(slice[0][0]).toBe(10);
    expect(slice[slice.length - 1][0]).toBe(10);
    expect(slice.reduce((sum, [metres]) => sum + metres, 0)).toBeCloseTo(100, 6);
  });

  it("returns nothing rather than an empty run", () => {
    expect(sliceProfile(samples, 1e8, 1e9)).toBeUndefined();
    expect(sliceProfile(undefined, 0, 100)).toBeUndefined();
  });
});

describe("terrain tiles", () => {
  it("decodes Terrarium's height encoding", () => {
    expect(terrariumHeight(128, 0, 0)).toBe(0);
    expect(terrariumHeight(128, 100, 128)).toBe(100.5);
    expect(terrariumHeight(0, 0, 0)).toBe(-32768);
  });

  it("interpolates heights, clamping at the tile edge rather than reading across it", () => {
    // 2x2 tile rising to the east.
    const tile: HeightTile = { width: 2, height: 2, data: Float32Array.from([0, 100, 0, 100]) };
    expect(bilinearHeight(tile, 0.5, 0.5)).toBeCloseTo(0, 6);
    expect(bilinearHeight(tile, 1.5, 0.5)).toBeCloseTo(100, 6);
    expect(bilinearHeight(tile, 1.0, 0.5)).toBeCloseTo(50, 6);
    // Outside the tile clamps to its own pixels.
    expect(bilinearHeight(tile, -5, 0.5)).toBeCloseTo(0, 6);
    expect(bilinearHeight(tile, 99, 0.5)).toBeCloseTo(100, 6);
  });
});
