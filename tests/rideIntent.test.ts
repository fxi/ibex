import { describe, expect, it } from "vitest";
import { distance, route, scoreEdge, total } from "../src/routing/engine";
import { parseProfile, serializeProfile } from "../src/routing/profiles";
import type { Edge, Graph, Point } from "../src/routing/types";
import { loadProfile } from "./helpers";

/**
 * Shipped profiles, held to what they promise a rider in one sentence each.
 *
 * These are product-contract tests, not engine tests: they read the files a rider actually
 * picks, so retuning one deliberately is *supposed* to break them. A failure here means
 * "a shipped profile changed meaning" and the promise in profiles/README.md has to change
 * with it — it does not mean the router regressed. Tests that must not move with product
 * tuning pin their own preferences instead (see tests/exploration.test.ts).
 */
const GRAVEL = loadProfile("gravel_50");
const MTB = loadProfile("trail_60");
const ROAD = loadProfile("road_28");
const BIKEPACKING = loadProfile("gravel_50_bikepacking");

const way = (
  highway: string,
  surface: string,
  tags: Record<string, string>,
  grade: number,
  extra: Partial<Edge> = {},
): Edge => ({
  id: 0,
  from: 0,
  to: 1,
  way: "w",
  length: 1000,
  geometry: [
    [6.1, 45.1],
    [6.113, 45.1],
  ],
  grades: [[1000, grade]],
  surface,
  highway,
  stress: 0.08,
  uncertainty: 0.1,
  utility: 0.5,
  urban: 0,
  cyclingNetwork: 0,
  reward: 0,
  bridge: false,
  tunnel: false,
  name: "",
  tile: "test",
  tags: { surface, ...tags },
  ...extra,
});

const tarmac = (grade: number) => way("unclassified", "asphalt", {}, grade);
const easyGravel = (grade: number) =>
  way("track", "compacted", { tracktype: "grade2", "mtb:scale": "0" }, grade);
const singletrack = (grade: number) =>
  way("path", "ground", { "mtb:scale": "1" }, grade);
const cost = (edge: Edge, profile = GRAVEL) => total(scoreEdge(edge, profile));
const withDownhill = (
  profile: typeof GRAVEL,
  downhill: (typeof GRAVEL)["preferences"]["downhill"],
) =>
  parseProfile({
    ...profile,
    preferences: { ...profile.preferences, downhill },
  });
const withBike = (
  profile: typeof GRAVEL,
  bike: Partial<(typeof GRAVEL)["setup"]["bike"]>,
) =>
  parseProfile({
    ...profile,
    setup: { ...profile.setup, bike: { ...profile.setup.bike, ...bike } },
  });

describe("gravel", () => {
  it("climbs on easy gravel", () => {
    expect(cost(easyGravel(0.04))).toBeLessThan(cost(tarmac(0.04)));
  });

  it("comes down on smooth tarmac once downhill explicitly avoids gravel", () => {
    const smoothDown = withDownhill(GRAVEL, {
      unpaved: "avoid",
      surface_difficulty: "strongly_avoid",
    });
    expect(cost(tarmac(-0.04), smoothDown)).toBeLessThan(
      cost(easyGravel(-0.04), smoothDown),
    );
    expect(cost(tarmac(-0.04), smoothDown)).toBeLessThan(
      cost(singletrack(-0.04), smoothDown),
    );
    expect(cost(easyGravel(0.04), smoothDown)).toBeLessThan(
      cost(tarmac(0.04), smoothDown),
    );
  });

  it("prices scale 1 by tires and suspension, and scale 2 more uphill", () => {
    const scale1 = singletrack(-0.08);
    const gravel45 = withBike(GRAVEL, { tire_mm: 45 });
    const mtb60 = withBike(GRAVEL, { tire_mm: 60, suspension: "front" });
    expect(scoreEdge(scale1, gravel45).technical).toBeGreaterThan(
      scoreEdge(scale1, GRAVEL).technical,
    );
    expect(scoreEdge(scale1, GRAVEL).technical).toBeGreaterThan(0);
    expect(scoreEdge(scale1, mtb60).technical).toBe(0);

    const scale2Up = way(
      "path",
      "ground",
      { "mtb:scale": "2" },
      0.08,
    );
    const scale2Down = {
      ...scale2Up,
      grades: [[1000, -0.08]] as [number, number][],
    };
    expect(scoreEdge(scale2Up, GRAVEL).technical).toBeGreaterThan(
      scoreEdge(scale2Down, GRAVEL).technical,
    );
  });

  it("makes grade5 rougher with luggage without calling it technical", () => {
    const grade5 = way("track", "unknown", { tracktype: "grade5" }, -0.08);
    const loaded = withBike(GRAVEL, { load_kg: 18 });
    expect(scoreEdge(grade5, loaded).roughness).toBeGreaterThan(
      scoreEdge(grade5, GRAVEL).roughness,
    );
    expect(scoreEdge(grade5, loaded).technical).toBe(0);
  });
});

describe("gravel bikepacking", () => {
  // "Loaded touring on gravel: climbs on easy ground, descends on smooth, and stays off
  // anything rough with the bags on." Unlike shipped Gravel, this one does carry the
  // downhill override, so the promise is testable against the file itself.
  it("climbs on easy gravel", () => {
    expect(cost(easyGravel(0.04), BIKEPACKING)).toBeLessThan(
      cost(tarmac(0.04), BIKEPACKING),
    );
  });

  it("comes down on smooth ground", () => {
    expect(cost(tarmac(-0.04), BIKEPACKING)).toBeLessThan(
      cost(easyGravel(-0.04), BIKEPACKING),
    );
  });

  it("stays off rough ground loaded, uphill and down", () => {
    for (const grade of [0.04, -0.04])
      expect(cost(singletrack(grade), BIKEPACKING)).toBeGreaterThan(
        cost(easyGravel(grade), BIKEPACKING),
      );
  });
});

describe("direction overrides reach the charges outside the detour budget", () => {
  // Reported on the Voirons above Fillinges: `downhill.unpaved: strongly_avoid` moved
  // only the capped preference, because the gravel hazard read `base`. The route went
  // straight down the dirt paths it was told to avoid.
  const noGravelDown = withDownhill(GRAVEL, {
    unpaved: "strongly_avoid",
    surface_difficulty: "strongly_avoid",
  });

  it("charges gravel as a hazard going down, not going up", () => {
    expect(scoreEdge(easyGravel(-0.1), noGravelDown).roughness).toBeGreaterThan(
      scoreEdge(easyGravel(-0.1), GRAVEL).roughness,
    );
    expect(scoreEdge(easyGravel(0.1), noGravelDown).roughness).toBe(
      scoreEdge(easyGravel(0.1), GRAVEL).roughness,
    );
  });

  it("takes a longer sealed descent over a gravel shortcut", () => {
    const points: Point[] = [
      [6.1, 46.1],
      [6.12, 46.1],
      [6.11, 46.105],
    ];
    const link = (id: number, from: number, to: number, edge: Edge): Edge => ({
      ...edge,
      id,
      from,
      to,
      way: String(id),
      length: distance(points[from], points[to]),
      geometry: [points[from], points[to]],
      grades: [[distance(points[from], points[to]), -0.08]],
    });
    const graph: Graph = {
      schemaVersion: 1,
      bbox: [5.8, 45.95, 6.55, 46.45],
      nodes: points.map((p, id) => ({ id, p, elevation: 0 })),
      restrictions: [],
      edges: [
        link(0, 0, 1, easyGravel(0)),
        link(1, 0, 2, tarmac(0)),
        link(2, 2, 1, tarmac(0)),
      ],
    };
    const run = (profile: typeof GRAVEL) =>
      route(graph, { anchors: [points[0], points[1]], profile }, "reference")
        .edgeIds;
    expect(run(GRAVEL)).toEqual([0]);
    expect(run(noGravelDown)).toEqual([1, 2]);
  });
});

describe("mtb", () => {
  it("climbs like gravel and comes down on singletrack", () => {
    expect(cost(easyGravel(0.04), MTB)).toBeLessThan(
      cost(singletrack(0.04), MTB),
    );
    expect(cost(singletrack(-0.04), MTB)).toBeLessThan(
      cost(tarmac(-0.04), MTB),
    );
    expect(cost(singletrack(-0.04), MTB)).toBeLessThan(
      cost(easyGravel(-0.04), MTB),
    );
  });

  it("keeps base preferences on a false flat", () => {
    const flat = withDownhill(MTB, {});
    for (const edge of [singletrack(-0.01), tarmac(-0.01)])
      expect(cost(edge, MTB)).toBeCloseTo(cost(edge, flat), 6);
    expect(cost(singletrack(-0.04), MTB)).toBeLessThan(
      cost(singletrack(-0.04), flat),
    );
  });
});

describe("road", () => {
  it("charges gravel as a hazard, outside the detour budget", () => {
    expect(scoreEdge(easyGravel(0), ROAD).roughness).toBeGreaterThan(0);
    expect(scoreEdge(tarmac(0), ROAD).roughness).toBe(0);
    expect(cost(easyGravel(0), ROAD)).toBeGreaterThan(
      3 * cost(tarmac(0), ROAD),
    );
  });

  it("rides a longer sealed road rather than a gravel shortcut, but is never stranded", () => {
    const points: Point[] = [
      [6.1, 46.1],
      [6.12, 46.1],
      [6.11, 46.105],
    ];
    const link = (id: number, from: number, to: number, edge: Edge): Edge => ({
      ...edge,
      id,
      from,
      to,
      way: String(id),
      length: distance(points[from], points[to]),
      geometry: [points[from], points[to]],
      grades: [[distance(points[from], points[to]), 0]],
    });
    const graph = (edges: Edge[]): Graph => ({
      schemaVersion: 1,
      bbox: [5.8, 45.95, 6.55, 46.45],
      nodes: points.map((p, id) => ({ id, p, elevation: 0 })),
      restrictions: [],
      edges,
    });
    const shortcut = link(0, 0, 1, easyGravel(0));
    const detour = [link(1, 0, 2, tarmac(0)), link(2, 2, 1, tarmac(0))];
    const anchors = [points[0], points[1]];

    const run = (edges: Edge[], profile = ROAD) =>
      route(graph(edges), { anchors, profile }, "reference");
    const road = run([shortcut, ...detour]);
    expect(road.status).toBe("ok");
    expect(road.edgeIds).toEqual([1, 2]);
    expect(run([shortcut, ...detour], GRAVEL).edgeIds).toEqual([0]);
    expect(run([shortcut]).status).toBe("ok");
  });
});

it("round-trips direction overrides, and drops one that repeats base", () => {
  for (const profile of [GRAVEL, MTB, ROAD])
    expect(parseProfile(JSON.parse(serializeProfile(profile)))).toEqual(
      profile,
    );
  expect(JSON.parse(serializeProfile(MTB)).preferences.downhill).toEqual(
    MTB.preferences.downhill,
  );
  const redundant = parseProfile({
    ...ROAD,
    preferences: {
      ...ROAD.preferences,
      uphill: { traffic_stress: ROAD.preferences.base.traffic_stress },
    },
  });
  expect(redundant.preferences.uphill).toEqual({});
  expect(serializeProfile(redundant)).toBe(serializeProfile(ROAD));
});
