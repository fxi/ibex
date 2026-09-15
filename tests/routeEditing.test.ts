import { describe, expect, it } from "vitest";
import {
  insertionIndex,
  nearestPosition,
  snapToLines,
} from "../src/map/routeEditing";
import type { Point } from "../src/routing/types";

describe("route editing", () => {
  it("projects onto the line rather than the nearest vertex", () => {
    expect(
      nearestPosition(
        [
          [0, 0],
          [100, 0],
        ],
        [40, 5],
      ),
    ).toEqual({
      distance: 5,
      position: 0.4,
      point: [40, 0],
    });
  });
  it("inserts into the affected leg while preserving endpoints", () => {
    const line: Point[] = [
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
    ];
    const anchors: Point[] = [
      [0, 0],
      [20, 0],
      [30, 0],
    ];
    expect(insertionIndex(line, anchors, 1.5)).toBe(1);
    expect(insertionIndex(line, anchors, 2.5)).toBe(2);
    expect(insertionIndex(line, anchors, 0)).toBe(1);
    expect(insertionIndex(line, anchors, 3)).toBe(2);
  });
  it("follows waypoint order on a returning route", () => {
    const line: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    expect(insertionIndex(line, [line[0], line[2], line[4]], 3.5)).toBe(2);
  });
  it("handles repeated vertices without NaN", () => {
    expect(
      nearestPosition(
        [
          [0, 0],
          [0, 0],
          [10, 0],
        ],
        [5, 2],
      ).position,
    ).toBe(1.5);
  });
  it("snaps to the nearest line within reach and to nothing beyond it", () => {
    const lines: Point[][] = [
      [
        [0, 0],
        [100, 0],
      ],
      [
        [0, 10],
        [100, 10],
      ],
    ];
    expect(snapToLines(lines, [50, 7], 16)).toEqual([50, 10]);
    expect(snapToLines(lines, [50, 40], 16)).toBeUndefined();
    expect(snapToLines([[[5, 5]]], [5, 5], 16)).toBeUndefined();
  });
});
