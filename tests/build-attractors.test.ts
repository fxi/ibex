/**
 * Attractor reading and clustering.
 *
 * `attractorKind` and `clusterStrength` encode product decisions — which tags count as a
 * place worth riding to, and how weakly-evidenced ones add up — so those are asserted
 * exactly. The clustering itself feeds an attraction *surface*, which is an approximation
 * by construction, so it is checked for the properties that matter (things close together
 * group, things far apart do not) rather than pinned to a digest. Whether the signal is
 * right is settled by the gold routes in `tests/fixtures/gold/`.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { readSource } from "../src/build/osm/source";
import { inflate } from "../src/build/platform/node";
import {
  attractorClusters,
  attractorKind,
  attractorPoints,
  clusterStrength,
  interpolatePolyline,
  type AttractorPoint,
} from "../src/build/attractors";
import { attractionSurface } from "../src/build/layers";
import { distance } from "../src/geo/distance";
import type { BBox } from "../src/build/surface";

const CELL = "data/pbf/geneva-toulon-v7/cells/9-266-187.osm.pbf";

describe("attractorKind", () => {
  it("reads the summit kinds", () => {
    expect(attractorKind({ tourism: "viewpoint" })).toBe("viewpoint");
    expect(attractorKind({ natural: "peak" })).toBe("peak");
    expect(attractorKind({ natural: "saddle" })).toBe("pass");
    expect(attractorKind({ mountain_pass: "yes" })).toBe("pass");
  });

  it("only counts the information boards it understands", () => {
    expect(attractorKind({ tourism: "information", information: "guidepost" })).toBe("guidepost");
    expect(attractorKind({ tourism: "information", information: "office" })).toBeUndefined();
  });

  it("ignores anything untagged as an attractor", () => {
    expect(attractorKind({ amenity: "parking" })).toBeUndefined();
    expect(attractorKind({})).toBeUndefined();
  });
});

describe("clusterStrength", () => {
  it("treats a summit as a source on its own", () => {
    expect(clusterStrength(["viewpoint"])).toBe(1);
    expect(clusterStrength(["peak"])).toBe(1);
  });

  it("needs two kinds to agree before small amenities count", () => {
    // One bench on a village square says nothing.
    expect(clusterStrength(["bench"])).toBe(0);
    expect(clusterStrength(["bench", "bench"])).toBe(0);
    // A bench beside a fountain is somewhere someone stops.
    expect(clusterStrength(["bench", "water"])).toBe(0.6);
  });

  it("stops counting benches after the second", () => {
    expect(clusterStrength(["bench", "bench", "water"])).toBe(0.9);
    expect(clusterStrength(["bench", "bench", "bench", "bench", "water"])).toBe(0.9);
  });

  it("caps at a viewpoint's strength", () => {
    expect(clusterStrength(["viewpoint", "bench", "water", "picnic", "shelter"])).toBe(1);
  });
});

describe("attractorClusters", () => {
  /** Roughly metres east of a Geneva-ish origin, so the radii are realistic. */
  const at = (eastM: number, kind: AttractorPoint[2]): AttractorPoint => [
    6 + eastM / 77000,
    46,
    kind,
  ];

  it("groups points within the radius and separates those beyond it", () => {
    const near = attractorClusters([at(0, "bench"), at(50, "water")]);
    expect(near).toHaveLength(1);
    expect(near[0][2]).toBe(0.6);

    const far = attractorClusters([at(0, "bench"), at(400, "water")]);
    // Each is alone, and a lone bench or fountain does not draw.
    expect(far).toHaveLength(0);
  });

  it("chains through intermediate points, as single linkage does", () => {
    // 0 - 90 - 180 m: the ends are further apart than the radius but the chain joins them.
    const chained = attractorClusters([at(0, "bench"), at(90, "bench"), at(180, "water")]);
    expect(chained).toHaveLength(1);
    expect(chained[0][2]).toBe(0.9);
  });

  it("places a cluster at the centroid of its members", () => {
    const [cluster] = attractorClusters([at(0, "bench"), at(60, "water")]);
    expect(cluster[0]).toBeCloseTo((6 + 6 + 60 / 77000) / 2, 9);
    expect(cluster[1]).toBeCloseTo(46, 9);
  });
});

describe("attraction surface", () => {
  const BOX: BBox = [6.0, 46.0, 6.1, 46.1];

  it("draws a way that passes a cluster and ignores one that does not", () => {
    const surface = attractionSurface([[6.05, 46.05, 0.8]], BOX, 10);
    expect(surface.sampleMax([[6.05, 46.05]])).toBeCloseTo(0.8, 5);
    expect(surface.sampleMax([[6.02, 46.02]])).toBe(0);
  });

  it("keeps the strongest where clusters overlap", () => {
    const surface = attractionSurface(
      [
        [6.05, 46.05, 0.3],
        [6.0501, 46.05, 1.0],
      ],
      BOX,
      10,
    );
    expect(surface.sampleMax([[6.05, 46.05]])).toBeCloseTo(1.0, 5);
  });

  it("does not dilute a long way that passes one viewpoint", () => {
    const surface = attractionSurface([[6.05, 46.05, 1.0]], BOX, 10);
    const long = surface.sampleMax([
      [6.01, 46.05],
      [6.09, 46.05],
    ]);
    expect(long).toBeCloseTo(1.0, 5);
  });
});

describe("interpolatePolyline", () => {
  it("returns the first point for a degenerate line", () => {
    expect(interpolatePolyline([[6, 46]], 0.5, 0)).toEqual([6, 46]);
    expect(
      interpolatePolyline(
        [
          [6, 46],
          [6.1, 46],
        ],
        0.5,
        0,
      ),
    ).toEqual([6, 46]);
  });

  it("walks by arc length, not by vertex count", () => {
    const coords: [number, number][] = [
      [6, 46],
      [6.09, 46],
      [6.1, 46],
    ];
    let total = 0;
    for (let i = 0; i + 1 < coords.length; i++) total += distance(coords[i], coords[i + 1]);
    const mid = interpolatePolyline(coords, 0.5, total);
    expect(mid[0]).toBeGreaterThan(6.049);
    expect(mid[0]).toBeLessThan(6.051);
  });
});

describe("on a real extract", () => {
  const present = fs.existsSync(CELL);

  it.skipIf(!present)("finds attractors and clusters no more than it found", async () => {
    const source = await readSource(new Uint8Array(fs.readFileSync(CELL)), inflate);
    const points = attractorPoints(source.nodes);
    const clusters = attractorClusters(points);
    expect(points.length).toBeGreaterThan(0);
    // Clustering can only ever merge, and only clusters that draw survive.
    expect(clusters.length).toBeLessThanOrEqual(points.length);
    expect(clusters.every(([, , strength]) => strength > 0 && strength <= 1)).toBe(true);
  }, 60_000);
});
