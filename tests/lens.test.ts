import { describe, expect, it } from "vitest";
import { lensFeatures, vertexLookup } from "../src/map/lens";
import { LEVEL_COLORS } from "../src/map/rideStyle";
import { compileProfile } from "../src/routing/compile";
import type { Point, RouteResult, RouteSegment } from "../src/routing/types";
import { ROAD } from "./helpers";

const CAPABILITY = compileProfile(ROAD).capability;
const meta = {
  trackId: "t",
  trackColor: "#2f7df6",
  active: true,
  stale: false,
};

/** Eleven vertices 100 m apart, as a route of `segments`. */
function route(
  segments: [number, number, number][],
  elevationProfile: [number, number | null][] = [],
): RouteResult {
  const geometry: Point[] = Array.from({ length: 11 }, (_, i) => [
    6 + i * 0.0013,
    46,
  ]);
  return {
    geometry,
    distanceM: 1000,
    elevationProfile,
    segments: segments.map(([start, end, stress]): RouteSegment => ({
      start,
      end,
      ride: "paved",
      surface: "asphalt",
      highway: "residential",
      grade: 0,
      roughness: 0,
      stress,
      lengthM: (end - start) * 100,
    })),
  } as unknown as RouteResult;
}

describe("lens centre line", () => {
  it("draws traffic only where it is busy, one line per level", () => {
    const features = lensFeatures(
      route([
        [0, 3, 0.2],
        [3, 5, 0.8],
        [5, 7, 0.8],
        [7, 10, 0.95],
      ]),
      "traffic",
      CAPABILITY,
      meta,
    );
    expect(features.map((f) => f.properties.level)).toEqual([2, 3]);
    expect(features[0].properties.color).toBe(LEVEL_COLORS[2]);
    // Two busy segments join into one line from vertex 3 to vertex 7.
    expect(features[0].geometry.coordinates).toHaveLength(5);
    expect(features[0].properties.trackColor).toBe(meta.trackColor);
  });

  it("draws a steep stretch where the chart puts it, in metres", () => {
    const t = CAPABILITY.uphill_grade;
    const features = lensFeatures(
      route(
        [[0, 10, 0.2]],
        [
          [0, 100],
          [250, 100],
          [750, 100 + t.high_cost_at * 1.05 * 500],
          [1000, 100 + t.high_cost_at * 1.05 * 500],
        ],
      ),
      "steep",
      CAPABILITY,
      meta,
    );
    expect(features).toHaveLength(1);
    expect(features[0].properties.level).toBe(3);
    const [first] = features[0].geometry.coordinates;
    // 250 m in is halfway between the third and fourth vertices.
    expect(first[0]).toBeCloseTo(6 + 2.5 * 0.0013, 6);
  });

  it("draws nothing under the surface lens, which has its own centre lines", () => {
    expect(
      lensFeatures(route([[0, 10, 0.95]]), "surface", CAPABILITY, meta),
    ).toEqual([]);
  });

  it("measures an imported recording along its own geometry", () => {
    const imported = { ...route([]), segments: [] } as RouteResult;
    const at = vertexLookup(imported);
    expect(at(0)).toBe(0);
    expect(at(500)).toBeCloseTo(5, 1);
    expect(at(1000)).toBeCloseTo(10, 6);
  });
});
