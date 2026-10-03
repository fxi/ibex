/**
 * Traffic estimated by routing trips between places on the car network.
 */
import { describe, expect, it } from "vitest";
import { NodeIndex, type CellSource } from "../src/build/osm/source";
import { trafficFlow, wayVolume } from "../src/build/flow";
import { riddenStress, roadStress } from "../src/build/stress";
import { trafficLevel } from "../src/map/routeStats";
import type { OsmTags } from "../src/build/osm/pbf";

/**
 * Two towns 10 km apart joined by a fast main road and, a little north, a slow lane that
 * runs the same way. A village sits at the end of its own dead-end road off the lane.
 */
function country(): CellSource {
  const ids = [1, 2, 3, 4, 5, 6];
  const lon = [6.0, 6.13, 6.0, 6.13, 6.065, 6.065];
  const lat = [46.0, 46.0, 46.02, 46.02, 46.02, 46.05];
  const way = (id: number, refs: number[], tags: OsmTags) => ({ id, refs, tags });
  const ways = [
    way(10, [1, 2], { highway: "primary" }),
    way(11, [1, 3], { highway: "unclassified" }),
    way(12, [3, 5, 4], { highway: "unclassified" }),
    way(13, [4, 2], { highway: "unclassified" }),
    way(14, [5, 6], { highway: "unclassified" }),
    way(15, [1, 2], { highway: "track" }),
  ];
  const place = (id: number, at: number, kind: string, population: string) => ({
    id,
    lon: lon[at],
    lat: lat[at],
    tags: { place: kind, population },
  });
  return {
    nodes: [place(100, 0, "town", "5000"), place(101, 1, "town", "5000"), place(102, 5, "village", "300")],
    ways,
    relations: [],
    positions: NodeIndex.from(ids, lon, lat),
    wayById: new Map(ways.map((w) => [w.id, w])),
  };
}

const area: [number, number, number, number] = [5.9, 45.9, 6.3, 46.2];

describe("trafficFlow", () => {
  const { byWay } = trafficFlow(country(), area);

  it("sends the trips between towns down the fast road, not the lane beside it", () => {
    expect(byWay.get(10)!).toBeGreaterThan(10 * (byWay.get(13) ?? 0));
  });

  it("loads a village's only road with the village's trips", () => {
    expect(byWay.get(14)!).toBeGreaterThan(0);
  });

  it("routes no trips over ways cars cannot use", () => {
    expect(byWay.has(15)).toBe(false);
  });

  it("reads volume only for driveable ways, and only with an estimate", () => {
    expect(wayVolume(byWay, 10, { highway: "primary" })).toBeGreaterThan(0);
    expect(wayVolume(byWay, 15, { highway: "track" })).toBeUndefined();
    expect(wayVolume(undefined, 10, { highway: "primary" })).toBeUndefined();
  });
});

describe("stress with volume", () => {
  const level = (highway: string, tags: OsmTags, volume?: number) =>
    trafficLevel(riddenStress(roadStress(highway, tags, { urban: 0, country: "FR", volume }), undefined));

  it("calms a quiet departmental road whose only stress was its legal speed", () => {
    expect(level("secondary", { maxspeed: "80" })).toBe(2);
    expect(level("secondary", { maxspeed: "80" }, 0.5)).toBe(0);
  });

  it("keeps a road fast enough to be hard, however empty", () => {
    expect(level("primary", { maxspeed: "90" }, 0.5)).toBe(3);
  });

  it("does not make a road busy for carrying many trips", () => {
    expect(level("tertiary", { maxspeed: "50" }, 3.5)).toBe(0);
  });

  it("changes nothing above the threshold, or off the car network", () => {
    expect(level("secondary", { maxspeed: "80" }, 2)).toBe(2);
    expect(level("cycleway", {}, 4)).toBe(0);
  });
});
