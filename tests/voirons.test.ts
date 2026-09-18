import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { route, scoreEdge, total } from "../src/routing/engine";
import { eligible } from "../src/routing/eligibility";
import type { Point } from "../src/routing/types";
import {
  GRAVEL,
  PROFILES,
  ROAD,
  TRAIL,
  loadProfile,
  voironsGraph,
  withPreferences,
} from "./helpers";

const graph = voironsGraph();
const anchors: Point[] = [
  [6.3512921, 46.2272083],
  [6.3530403, 46.2270601],
];
const defaultGravel = loadProfile("gravel_50");
const climbAnchors: Point[] = [
  [6.3072653464371875, 46.24165426558587],
  [6.354980055182864, 46.229866761960544],
];
const geometryDigest = (geometry: Point[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        geometry.map(([lon, lat]) => [+lon.toFixed(7), +lat.toFixed(7)]),
      ),
    )
    .digest("hex")
    .slice(0, 16);

/**
 * This used to assert the opposite — that the gravel preset returned `no-path` here,
 * because the connector carries `mtb:scale:uphill=1` and the profile's capability limit
 * deleted the edge. A leisure router failing because of a preference is the bug, not the
 * feature: difficulty is priced now, so every profile gets somewhere.
 */
it("routes the Sauget crossing for every profile, by a line that suits each", () => {
  for (const profile of PROFILES) {
    const r = route(graph, { profile, anchors }, "reference");
    expect(r.status, profile.id).toBe("ok");
    // These two points are 190 m apart and every way across is a long way round. That is
    // the real answer here; the old failure was that gravel got no answer at all. The
    // wanderer, keenest to explore, rides about 6.8 km: it trades 1.6 km of paths nobody
    // described for mapped ground and dirt paths, and climbs less doing it.
    expect(r.distanceM, profile.id).toBeGreaterThan(2500);
    expect(r.distanceM, profile.id).toBeLessThan(8000);
  }

  const byId = new Map(graph.edges.map((e) => [e.id, e]));
  const technicality = (profile: (typeof PROFILES)[number]) => {
    const r = route(graph, { profile, anchors }, "reference");
    const edges = r.edgeIds.map((id) => byId.get(id)).filter((e) => !!e);
    const mtb = edges.reduce(
      (sum, e) => sum + Number(e.tags?.["mtb:scale"] ?? 0) * e.length,
      0,
    );
    return { distance: r.distanceM, mtb: mtb / r.distanceM };
  };
  const gravel = technicality(GRAVEL);
  const trail = technicality(TRAIL);
  // A trail bike takes the shorter, rougher way; the gravel rider goes round it.
  expect(trail.distance).toBeLessThan(gravel.distance);
  expect(trail.mtb).toBeGreaterThan(gravel.mtb);
});

it("makes the technical shortcut cost more than the road for a gravel rider", () => {
  const technical = graph.edges.find((e) => e.way === "107854950")!;
  const road = graph.edges.find((e) => e.name === "Route des Voirons")!;
  const rate = (e: typeof technical) => total(scoreEdge(e, GRAVEL)) / e.length;
  expect(rate(technical)).toBeGreaterThan(rate(road));
  // And a rider who came looking for exactly that ground is charged less for it.
  const seeker = withPreferences(GRAVEL, {
    surface_difficulty: "strongly_prefer",
  });
  expect(total(scoreEdge(technical, seeker))).toBeLessThan(
    total(scoreEdge(technical, GRAVEL)),
  );
});

it("keeps steep Sauget grades nonzero while eliminating a short road-edge pixel spike", () => {
  const trail = graph.edges.find((e) => e.way === "107854950")!;
  expect(trail.grades).not.toBeNull();
  expect(
    Math.max(...trail.grades!.map(([, g]) => Math.abs(g))),
  ).toBeGreaterThan(0.2);
  const road = graph.edges.find(
    (e) => e.way === "1300850464" && e.length === 112.1,
  )!;
  expect(Math.max(...road.grades!.map(([, g]) => Math.abs(g)))).toBeLessThan(
    0.15,
  );
});

it("routes a road profile between road-access points", () => {
  const road = route(
    graph,
    {
      profile: ROAD,
      anchors: [
        [6.361669, 46.227485],
        [6.3642228, 46.231931],
      ],
    },
    "reference",
  );
  expect(road.status).toBe("ok");
});

it("reproduces the standard Voirons climb from only its endpoints", () => {
  const result = route(
    graph,
    { profile: defaultGravel, anchors: climbAnchors },
    "reference",
  );
  expect(result.status).toBe("ok");
  expect(result.distanceM).toBeCloseTo(14459.116, 2);
  // Digest of tmp/voirons_climb_standard.gpx, rounded to centimetre-scale coordinates.
  expect(geometryDigest(result.geometry)).toBe("8510387755cc005b");

  const byId = new Map(graph.edges.map((edge) => [edge.id, edge]));
  expect(result.edgeIds.some((id) => byId.get(id)?.way === "111311811")).toBe(
    false,
  );
});

/**
 * The Menoge road bridges are the only links between the Geneva plain and the massif, and
 * the DEM reads the ground under their decks. They therefore carry an explicit flat grade
 * unless OSM describes the structure's incline. A terrain-derived grade once made these
 * cut vertices prohibitively expensive and stranded the whole Voirons massif.
 */
it("routes over the flat-modelled Menoge bridges instead of deleting them", () => {
  const bridge = graph.edges.find((e) => e.way === "252371604")!;
  expect(bridge.bridge).toBe(true);
  expect(bridge.grades).toEqual([[bridge.length, 0]]);
  for (const profile of PROFILES)
    expect(eligible(bridge, profile), profile.id).toBe(true);

  const west = bridge.geometry[0];
  const east = bridge.geometry.at(-1)!;
  const across: Point[] = [
    [west[0] - 0.0004, west[1]],
    [east[0] + 0.0004, east[1]],
  ];
  for (const profile of PROFILES) {
    const result = route(graph, { profile, anchors: across }, "reference");
    expect(result.status, profile.id).toBe("ok");
    expect(result.failedLeg).toBeUndefined();
    expect(result.edgeIds, profile.id).toContain(bridge.id);
  }
});

it("never derives a structure grade from terrain", () => {
  const structures = graph.edges.filter((e) => e.bridge || e.tunnel);
  expect(structures.length).toBeGreaterThan(0);
  expect(
    structures.every(
      (e) => e.grades?.length === 1 && e.grades[0][1] === 0,
    ),
  ).toBe(true);
  for (const profile of PROFILES)
    expect(
      structures.filter((e) => !eligible(e, profile)).map((e) => e.way),
      profile.id,
    ).toEqual([]);
});
