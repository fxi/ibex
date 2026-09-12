import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { route, snapAnchors } from "../src/routing/engine";
import { eligible } from "../src/routing/eligibility";
import type { Graph, Point } from "../src/routing/types";
import { profileSchema, type UserProfile } from "../src/routing/profiles";
import mountainWanderer from "../profiles/mountain-wanderer.json";
const graph: Graph = JSON.parse(
  gunzipSync(
    readFileSync(new URL("./fixtures/voirons-graph.json.gz", import.meta.url)),
  ).toString(),
);
const anchors: Point[] = [
  [6.3512921, 46.2272083],
  [6.3530403, 46.2270601],
];
it("takes the real Sauget detour when the rider permits its mapped uphill difficulty", () => {
  // The old eligibility check ignored mtb:scale:uphill=1 on this connector.
  // Directional limits now require that capability explicitly.
  expect(route(graph, { profile: "gravel", anchors }, "reference").status).toBe(
    "no-path",
  );
  const profile: UserProfile = {
    version: 1,
    name: "Sauget gravel",
    bike: "gravel",
    capabilities: { max_mtb_scale_up: 1 },
  };
  const result = route(graph, { profile, anchors }, "reference");
  expect(result.status).toBe("ok");
  expect(result.distanceM).toBeGreaterThan(4000);
  expect(result.distanceM).toBeLessThan(6000);
  const snapped = snapAnchors(
    { ...graph, edges: graph.edges.filter((e) => eligible(e, profile)) },
    anchors,
  )!;
  const byId = new Map(snapped.graph.edges.map((e) => [e.id, e]));
  const edges = result.edgeIds.map((id) => byId.get(id)!);
  expect(edges.some((e) => e.highway === "track")).toBe(true);
  expect(edges.some((e) => e.name === "Route des Voirons")).toBe(true);
  expect(edges.some((e) => ["107854950", "107857858"].includes(e.way))).toBe(
    false,
  );
  expect(
    edges.every((e) => !e.tags?.["mtb:scale"] || e.tags["mtb:scale"] === "0"),
  ).toBe(true);
  expect(Math.max(...result.geometry.map((p) => p[1]))).toBeGreaterThan(46.234);
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
it("refuses a hiking-only Road destination but routes between road-access points", () => {
  expect(route(graph, { profile: "road", anchors }, "reference").status).toBe(
    "snap-failed",
  );
  const road = route(
    graph,
    {
      profile: "road",
      anchors: [
        [6.361669, 46.227485],
        [6.3642228, 46.231931],
      ],
    },
    "reference",
  );
  expect(road.status).toBe("ok");
});

/**
 * The Menoge road bridges are the only links between the Geneva plain and the massif, and
 * the terrain sampler leaves every bridge and tunnel without grades on purpose — the DEM
 * reads the ground under the deck. Blocking an unmeasured grade therefore used to delete
 * these three edges and strand the whole of the Voirons from any profile with a grade
 * limit, which is every mountain model.
 */
it("routes over the unmeasured Menoge bridges instead of deleting them", () => {
  const wanderer: UserProfile = profileSchema.parse(mountainWanderer);
  const bridge = graph.edges.find((e) => e.way === "252371604")!;
  expect(bridge.bridge).toBe(true);
  expect(bridge.grades).toBeNull();
  expect(wanderer.capabilities?.max_grade_up).toBe(15);
  expect(eligible(bridge, wanderer)).toBe(true);
  const west = bridge.geometry[0];
  const east = bridge.geometry.at(-1)!;
  const across: Point[] = [
    [west[0] - 0.0004, west[1]],
    [east[0] + 0.0004, east[1]],
  ];
  const result = route(
    graph,
    { profile: wanderer, anchors: across },
    "reference",
  );
  expect(result.status).toBe("ok");
  expect(result.failedLeg).toBeUndefined();
  expect(result.edgeIds).toContain(bridge.id);
});

it("never excludes a structure for the grade it could not measure", () => {
  const wanderer: UserProfile = profileSchema.parse(mountainWanderer);
  // Same model with the limits lifted: anything it still rejects is rejected on surface,
  // access or difficulty — reasons a missing grade has no bearing on.
  const unlimited: UserProfile = {
    ...wanderer,
    capabilities: {
      ...wanderer.capabilities,
      max_grade_up: null,
      max_grade_down: null,
    },
  };
  const structures = graph.edges.filter((e) => e.bridge || e.tunnel);
  expect(structures.length).toBeGreaterThan(0);
  expect(structures.every((e) => e.grades === null)).toBe(true);
  expect(
    structures.filter((e) => eligible(e, unlimited) !== eligible(e, wanderer)),
  ).toEqual([]);
});
