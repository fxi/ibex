/**
 * A quiet lane along a motorway is not quiet: the share of a way beside a major road, and
 * how it lifts traffic stress.
 */
import { describe, expect, it } from "vitest";
import { NodeIndex, type CellSource } from "../src/build/osm/source";
import { isMajorRoad, majorRoadProximity } from "../src/build/proximity";
import { riddenStress, roadStress } from "../src/build/stress";
import { trafficLevel } from "../src/map/routeStats";
import type { OsmTags } from "../src/build/osm/pbf";
import type { Point } from "../src/routing/types";

/** One major road running east along 46° N for about 7.7 km. */
function sourceWith(tags: OsmTags): CellSource {
  const way = { id: 1, refs: [1, 2], tags };
  return {
    nodes: [],
    ways: [way],
    relations: [],
    positions: NodeIndex.from([1, 2], [6.0, 6.1], [46.0, 46.0]),
    wayById: new Map([[1, way]]),
  };
}

/** Metres north of 46° N, in degrees. */
const north = (m: number) => 46 + m / 111_319.49;

describe("isMajorRoad", () => {
  it("takes motorways, trunks and main roads with two lanes each way", () => {
    expect(isMajorRoad({ highway: "motorway" })).toBe(true);
    expect(isMajorRoad({ highway: "trunk_link" })).toBe(true);
    expect(isMajorRoad({ highway: "primary", lanes: "4" })).toBe(true);
    expect(isMajorRoad({ highway: "primary", lanes: "2", oneway: "yes" })).toBe(true);
    expect(isMajorRoad({ highway: "primary", lanes: "2" })).toBe(false);
    expect(isMajorRoad({ highway: "tertiary", lanes: "4" })).toBe(false);
  });
});

describe("majorRoadProximity", () => {
  const beside = majorRoadProximity(sourceWith({ highway: "motorway", bicycle: "no" }));

  it("reads a lane running alongside as wholly beside it", () => {
    const lane: Point[] = [[6.02, north(25)], [6.06, north(25)]];
    expect(beside(lane)).toBe(1);
  });

  it("reads a lane a field away as not beside it", () => {
    expect(beside([[6.02, north(200)], [6.06, north(200)]])).toBe(0);
  });

  it("reads a road crossing over it by the share that is close", () => {
    const crossing: Point[] = [[6.05, north(-500)], [6.05, north(500)]];
    const share = beside(crossing);
    expect(share).toBeGreaterThan(0.05);
    expect(share).toBeLessThan(0.1);
  });

  it("finds nothing where there is no major road", () => {
    const none = majorRoadProximity(sourceWith({ highway: "tertiary" }));
    expect(none([[6.02, north(10)], [6.06, north(10)]])).toBe(0);
  });
});

describe("stress beside a major road", () => {
  const level = (highway: string, share: number) =>
    trafficLevel(riddenStress(roadStress(highway, {}, { urban: 0, country: "FR", beside: share }), undefined));

  it("lifts a frontage lane to some traffic, and no further", () => {
    expect(level("residential", 0)).toBe(0);
    expect(level("residential", 1)).toBe(1);
    expect(level("unclassified", 0.5)).toBe(0);
    expect(level("cycleway", 1)).toBe(0);
  });
});
