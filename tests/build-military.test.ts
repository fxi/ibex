/**
 * A firing range closes the tracks inside it, which carry no access tag of their own.
 */
import { describe, expect, it } from "vitest";
import {
  mergeSources,
  NodeIndex,
  subsetSource,
  type CellSource,
} from "../src/build/osm/source";
import { militaryClosure } from "../src/build/military";
import { keepRelation, keepWay } from "../src/build/osm/filter";
import type { OsmTags } from "../src/build/osm/pbf";
import type { Point } from "../src/routing/types";

/** A square range from 6.0 to 6.1 E and 43.7 to 43.8 N, tagged as given. */
function range(tags: OsmTags): CellSource {
  const way = { id: 1, refs: [1, 2, 3, 4, 1], tags };
  return {
    nodes: [],
    ways: [way],
    relations: [],
    positions: NodeIndex.from(
      [1, 2, 3, 4],
      [6.0, 6.1, 6.1, 6.0],
      [43.7, 43.7, 43.8, 43.8],
    ),
    wayById: new Map([[1, way]]),
  };
}

const across: Point[] = [
  [6.02, 43.75],
  [6.08, 43.75],
];
/** From well outside to just inside the western edge: mostly outside. */
const clipping: Point[] = [
  [5.9, 43.75],
  [6.01, 43.75],
];

describe("militaryClosure", () => {
  const closed = militaryClosure(range({ military: "danger_area" }));

  it("closes an untagged track across a range", () => {
    expect(closed("track", { highway: "track" }, across)).toBe(true);
    expect(closed("path", { highway: "path" }, across)).toBe(true);
  });

  it("leaves a way that says bicycles may use it", () => {
    expect(closed("track", { highway: "track", bicycle: "yes" }, across)).toBe(
      false,
    );
    expect(
      closed("track", { highway: "track", access: "permissive" }, across),
    ).toBe(false);
  });

  it("leaves public roads that cross the range", () => {
    expect(closed("unclassified", { highway: "unclassified" }, across)).toBe(
      false,
    );
    expect(closed("tertiary", { highway: "tertiary" }, across)).toBe(false);
  });

  it("leaves a track that only clips the edge", () => {
    expect(closed("track", { highway: "track" }, clipping)).toBe(false);
  });

  it("reads landuse=military the same way, and nothing without a range", () => {
    expect(
      militaryClosure(range({ landuse: "military" }))("track", {}, across),
    ).toBe(true);
    expect(
      militaryClosure(range({ landuse: "forest" }))("track", {}, across),
    ).toBe(false);
  });
});

describe("the extract filter", () => {
  it("keeps military areas, as ways and as multipolygons", () => {
    expect(keepWay({ landuse: "military" })).toBe(true);
    expect(keepWay({ military: "range" })).toBe(true);
    expect(
      keepRelation({ type: "multipolygon", military: "danger_area" }),
    ).toBe(true);
    expect(keepWay({ military: "bunker" })).toBe(false);
  });
});

describe("an area larger than the cell", () => {
  /**
   * A range from 6.0 to 6.3 E and 43.6 to 43.9 N whose outline is two ways: its western
   * edge, with one node inside the box, and the rest, with none. Only the first touches
   * the box, so a subset by way alone cannot close the ring.
   */
  function wide(): CellSource {
    const near = { id: 10, refs: [1, 2, 3], tags: {} };
    const far = { id: 11, refs: [3, 4, 5, 1], tags: {} };
    const relation = {
      id: 100,
      tags: { type: "multipolygon", military: "training_area" },
      members: [
        { type: "way" as const, ref: 10, role: "outer" },
        { type: "way" as const, ref: 11, role: "outer" },
      ],
    };
    return {
      nodes: [],
      ways: [near, far],
      relations: [relation],
      positions: NodeIndex.from(
        [1, 2, 3, 4, 5],
        [6.0, 6.0, 6.0, 6.3, 6.3],
        [43.6, 43.75, 43.9, 43.9, 43.6],
      ),
      wayById: new Map([
        [10, near],
        [11, far],
      ]),
    };
  }
  // Around the western edge, clear of every other node.
  const box: [number, number, number, number] = [5.95, 43.65, 6.15, 43.8];

  it("keeps the outline beyond the box, so the area still closes its tracks", () => {
    const slice = subsetSource(wide(), box);
    expect(slice.wayById.has(11)).toBe(true);
    expect(militaryClosure(slice)("track", {}, across)).toBe(true);
  });

  it("carries that outline for its shape only, never as a way to route on", () => {
    const slice = subsetSource(wide(), box);
    expect(slice.ways.map((w) => w.id)).toEqual([10]);
    expect(mergeSources([slice, slice]).ways.map((w) => w.id)).toEqual([10]);
  });
});
