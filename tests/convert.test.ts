import { describe, expect, it } from "vitest";
import {
  along,
  offset,
  refineIndices,
  seedIndices,
  OFFSET_TOLERANCE_M,
} from "../src/routing/convert";
import { defaultProfile } from "../src/models";
import { convertedTrack, importedTrack } from "../src/tracks";
import type { Point, RouteResult } from "../src/routing/types";
import type { Profile } from "../src/routing/profiles";
import {
  goldPath,
  loadGold,
  loadGoldGraph,
  overlap,
  routeAsApp,
} from "../scripts/gold_route";
import { loadProfile } from "./helpers";

/** `n` vertices due east from Geneva's latitude, `step` degrees apart (~77 m at 0.001). */
const east = (n: number, step = 0.001): Point[] =>
  Array.from({ length: n }, (_, i): Point => [6 + i * step, 46]);

/** Just what refinement reads: a route through `anchors` along `geometry`. */
const routeAlong = (geometry: Point[], anchors: Point[]) =>
  ({ status: "ok", geometry, anchors }) as RouteResult;

describe("seedIndices", () => {
  it("pins both ends and one waypoint per spacing", () => {
    const recording = east(200); // ~15.3 km
    const indices = seedIndices(recording, 5000);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(199);
    expect(indices).toHaveLength(5);
    const at = along(recording);
    for (let k = 1; k < indices.length; k++)
      expect(at[indices[k]] - at[indices[k - 1]]).toBeLessThan(5000);
  });

  it("splits a short loop so no leg starts and ends at one place", () => {
    const out = east(11);
    const loop = [...out, ...out.slice(0, -1).reverse()];
    const indices = seedIndices(loop, 5000);
    expect(indices).toHaveLength(3);
    expect(indices[1]).toBeGreaterThan(0);
    expect(indices[1]).toBeLessThan(loop.length - 1);
  });

  it("needs two points", () => {
    expect(seedIndices(east(1))).toEqual([]);
  });
});

describe("refineIndices", () => {
  const recording = east(41);
  const indices = [0, 20, 40];
  const anchors = indices.map((i) => recording[i]);

  it("adds nothing when the route follows the recording", () => {
    const refined = refineIndices(
      recording,
      indices,
      routeAlong(recording, anchors),
    );
    expect(refined).toEqual({ indices, deviating: 0, changed: false });
  });

  it("pins where the route parts from the recording", () => {
    // The first leg takes a parallel road ~330 m north between vertices 8 and 12.
    const detour = recording.map((p, i): Point =>
      i >= 8 && i <= 12 ? [p[0], p[1] + 0.003] : p,
    );
    const refined = refineIndices(
      recording,
      indices,
      routeAlong(detour, anchors),
    );
    expect(refined).toEqual({
      indices: [0, 10, 20, 40],
      deviating: 1,
      changed: true,
    });
  });

  it("pins a leg that is the wrong length though never far away", () => {
    // Out 10 vertices and back again inside the first leg: close, but twice as long.
    const doubled = [
      ...recording.slice(0, 15),
      ...recording.slice(5, 15).reverse(),
      ...recording.slice(5),
    ];
    const refined = refineIndices(
      recording,
      indices,
      routeAlong(doubled, anchors),
    );
    expect(refined?.deviating).toBe(1);
    expect(refined?.indices).toEqual([0, 10, 20, 40]);
  });

  it("counts a deviation it cannot pin once the waypoint cap is reached", () => {
    const detour = recording.map((p, i): Point =>
      i >= 8 && i <= 12 ? [p[0], p[1] + 0.003] : p,
    );
    const refined = refineIndices(
      recording,
      indices,
      routeAlong(detour, anchors),
      indices.length,
    );
    expect(refined).toEqual({ indices, deviating: 1, changed: false });
  });

  it("gives up on a route that does not match its waypoints", () => {
    expect(
      refineIndices(recording, indices, routeAlong(recording, [])),
    ).toBeUndefined();
  });
});

describe("offset", () => {
  it("measures to the line, not to its vertices", () => {
    const line: Point[] = [
      [6, 46],
      [6.01, 46],
    ];
    expect(offset([[6.005, 46]], line).max).toBeLessThan(1);
    expect(offset([[6.005, 46.001]], line).max).toBeGreaterThan(
      OFFSET_TOLERANCE_M,
    );
  });
});

describe("convertedTrack", () => {
  it("is a planned track beside the import, which it leaves alone", () => {
    const source = importedTrack(0, {
      name: "Sunday loop",
      geometry: east(3),
      elevationProfile: [],
      distanceM: 154,
      ascentM: null,
      descentM: null,
    });
    const before = structuredClone(source);
    const profile = defaultProfile();
    const track = convertedTrack(source, 1, profile, east(3));
    expect(track.kind).toBe("planned");
    expect(track.id).not.toBe(source.id);
    expect(track.name).toBe("Sunday loop (ibex)");
    expect(track.anchors).toEqual(east(3));
    expect(track.profile.id).toBe(profile.id);
    expect(track.result).toBeUndefined();
    expect(source).toEqual(before);
  });
});

describe("converting a recorded tour", () => {
  const gold = loadGold(goldPath("voirons-tour"));
  const graph = loadGoldGraph("voirons-tour");
  const recording = gold.line;

  /** What the app does (`useConvert`): route, pin where the route parts, route again. */
  const convert = (profile: Profile) => {
    let indices = seedIndices(recording);
    for (let pass = 1; ; pass++) {
      const route = routeAsApp(
        graph,
        profile,
        indices.map((i) => recording[i]),
      );
      expect(route.status).toBe("ok");
      const next = refineIndices(recording, indices, route, 500);
      if (!next?.changed || pass >= 5) {
        const o = overlap(route.geometry, recording);
        return {
          shared: o.sharedM / o.goldM,
          indices,
          deviating: next?.deviating,
        };
      }
      indices = next.indices;
    }
  };

  // Measured 2026-09-23: 19 waypoints, 0.989 shared, nothing left parting from the line.
  it("follows it with the profile it was ridden with", () => {
    const { shared, indices, deviating } = convert(loadProfile(gold.profile));
    expect(shared).toBeGreaterThan(0.98);
    expect(deviating).toBe(0);
    expect(indices.length).toBeLessThan(25);
  }, 120_000);

  // Measured 2026-09-23: 35 waypoints, 0.981 shared. Road disagrees with a gravel tour the
  // most, so this is where the pinning has to do its work.
  it("follows it with a profile that would ride elsewhere", () => {
    const { shared, indices } = convert(loadProfile("road_28"));
    expect(shared).toBeGreaterThan(0.97);
    expect(indices.length).toBeLessThan(45);
  }, 120_000);
});
