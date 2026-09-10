import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { route, snapAnchors } from "../src/routing/engine";
import { eligible } from "../src/routing/eligibility";
import type { Graph, Point } from "../src/routing/types";
import type { UserProfile } from "../src/routing/profiles";
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
