/**
 * Attractor clustering against `scripts/build_region.py`.
 *
 * The corpus expectations were produced by running the Python `attractor_clusters`,
 * `attractor_index`, `attractor_strength` and `interpolate_polyline` over the same
 * extracts. Cluster centroids are digested to nine decimals, which is what makes this a
 * real check: single-linkage grouping and a mean are both sensitive to the order members
 * are visited in, so a centroid agreeing to that many places says the port walks the points
 * in the same order, not merely that it found the same clusters.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { geometry, readSource } from "../src/build/osm/source";
import { inflate } from "../src/build/platform/node";
import {
  attractorClusters,
  attractorIndex,
  attractorKind,
  attractorStrength,
  clusterStrength,
  interpolatePolyline,
  type AttractorPoint,
} from "../src/build/attractors";
import { distance } from "../src/geo/distance";

const CELLS = "data/pbf/geneva-toulon-v7/cells";

const EXPECTED = {
  "9-266-187": {
    amenities: 61,
    clusters: 38,
    waysWithAttractor: 319,
    fold: {
      clusters: "b8d3471cc78544c2",
      strength: "21233dbfb10ef0fa",
      interpolate: "ad67c7a09f555a9c",
    },
  },
  "9-262-187": {
    amenities: 45,
    clusters: 36,
    waysWithAttractor: 227,
    fold: {
      clusters: "794072e7f56f4bf",
      strength: "fe46bf6833c557f5",
      interpolate: "4e8c2a7e256b0d5c",
    },
  },
  "9-264-181": {
    amenities: 956,
    clusters: 702,
    waysWithAttractor: 2650,
    fold: {
      clusters: "661e38bdaad6e77c",
      strength: "457ab393be27ab28",
      interpolate: "6642bd5a0cbe1469",
    },
  },
};

const digest = (text: string) =>
  BigInt("0x" + createHash("sha256").update(text).digest("hex").slice(0, 16));

async function summarise(path: string) {
  const source = await readSource(new Uint8Array(fs.readFileSync(path)), inflate);
  const amenities: AttractorPoint[] = [];
  for (const node of source.nodes) {
    const kind = attractorKind(node.tags);
    if (kind) amenities.push([node.lon, node.lat, kind]);
  }
  const clusters = attractorClusters(amenities);
  const index = attractorIndex(clusters);
  const fold = { clusters: 0n, strength: 0n, interpolate: 0n };
  for (const [lon, lat, strength] of clusters)
    fold.clusters ^= digest(`${lon.toFixed(9)}|${lat.toFixed(9)}|${strength.toFixed(3)}`);
  let waysWithAttractor = 0;
  for (const way of source.ways) {
    const coords = geometry(way, source.positions);
    if (!coords || coords.length === 0) continue;
    const strength = attractorStrength(coords, index);
    if (strength > 0) waysWithAttractor++;
    fold.strength ^= digest(`${way.id}|${strength.toFixed(3)}`);
    let total = 0;
    for (let i = 0; i + 1 < coords.length; i++) total += distance(coords[i], coords[i + 1]);
    const mid = interpolatePolyline(coords, 0.5, total);
    fold.interpolate ^= digest(`${way.id}|${mid[0].toFixed(9)}|${mid[1].toFixed(9)}`);
  }
  return {
    amenities: amenities.length,
    clusters: clusters.length,
    waysWithAttractor,
    fold: {
      clusters: fold.clusters.toString(16),
      strength: fold.strength.toString(16),
      interpolate: fold.interpolate.toString(16),
    },
  };
}

describe("attractors", () => {
  for (const [cell, expected] of Object.entries(EXPECTED)) {
    const path = `${CELLS}/${cell}.osm.pbf`;
    const present = fs.existsSync(path);
    it.skipIf(!present)(
      `matches build_region.py on ${cell}`,
      async () => {
        expect(await summarise(path)).toEqual(expected);
      },
      120_000,
    );
  }

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

  describe("interpolatePolyline", () => {
    it("returns the first point for a degenerate line", () => {
      expect(interpolatePolyline([[6, 46]], 0.5, 0)).toEqual([6, 46]);
      expect(interpolatePolyline([[6, 46], [6.1, 46]], 0.5, 0)).toEqual([6, 46]);
    });

    it("walks by arc length, not by vertex count", () => {
      // Two segments, the first nine times as long: the midpoint falls inside it.
      const coords: [number, number][] = [[6, 46], [6.09, 46], [6.1, 46]];
      let total = 0;
      for (let i = 0; i + 1 < coords.length; i++) total += distance(coords[i], coords[i + 1]);
      const mid = interpolatePolyline(coords, 0.5, total);
      expect(mid[0]).toBeGreaterThan(6.049);
      expect(mid[0]).toBeLessThan(6.051);
    });
  });
});
