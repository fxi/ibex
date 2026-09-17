import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { explore } from "../src/routing/exploration";
import { distance, route, total } from "../src/routing/engine";
import { selectedRoute } from "../src/routing/selection";
import type { Edge, Graph, Point, RouteRequest } from "../src/routing/types";
import { loadProfile, withPreferences } from "./helpers";

const graph: Graph = JSON.parse(
  gunzipSync(
    readFileSync(new URL("./fixtures/coudry-graph.json.gz", import.meta.url)),
  ).toString(),
);
const request: RouteRequest = {
  anchors: [
    [6.3533, 46.1632],
    [6.2316, 46.1833],
  ],
  // The detour these tests describe is only worth buying when cycle infrastructure is
  // preferred, so the preference is pinned here rather than inherited from the shipped
  // profile, which is tuned as a product and has already moved it to `neutral` once.
  profile: withPreferences(loadProfile("gravel_50"), {
    cycle_infrastructure: "prefer",
  }),
};
const baseline = route(graph, request, "reference");

describe("scenic destination exploration", () => {
  it("buys the Coudry gravel detour and avoids the Bois des Milieux path", () => {
    const result = explore(graph, request, baseline);
    expect(result.status).toBe("ok");
    expect(
      result.geometry.some((p) => distance(p, [6.2603733, 46.1550886]) < 80),
    ).toBe(true);
    // Stable IDs of real OSM edges, excluding synthetic waypoint split edges.
    const ways = new Set(
      graph.edges
        .filter((e) => result.edgeIds.includes(e.id))
        .map((e) => e.way),
    );
    expect(ways.has("182450223")).toBe(true); // Coudry grade-2 track
    expect(ways.has("47394162")).toBe(true); // through-going gravel towards Menoge
    expect(ways.has("109843020")).toBe(false); // reported unrideable wooded descent
    expect(result.distanceM).toBeGreaterThan(baseline.distanceM + 1000);
    expect(result.distanceM).toBeLessThan(baseline.distanceM * 1.5);
    expect(result.hikeABikeM).toBeLessThanOrEqual(baseline.hikeABikeM + 1);
    expect(result.cost).toBeCloseTo(total(result.components), 6);
    expect(result.experience!.score).toBeLessThan(baseline.cost);
    expect(result.experience!.candidates).toBeLessThanOrEqual(8);
    expect(result.anchors).toEqual(baseline.anchors);
    expect(baseline.experience).toBeUndefined();
    expect(
      selectedRoute({
        reference: baseline,
        corridor: baseline,
        exploration: result,
        relativeCost: 0,
      }),
    ).toBe(result);
  }, 15000);

  it("does not add destinations when scenery or detouring is neutral", () => {
    for (const preferences of [
      { scenic: "neutral" },
      { detour: "neutral" },
    ] as const) {
      const profile = withPreferences(loadProfile("gravel_50"), preferences);
      expect(explore(graph, { ...request, profile }, baseline)).toBe(baseline);
    }
  });

  it("keeps a successful baseline when the candidate budget is exhausted", () => {
    const result = explore(graph, { ...request, maxSettled: 1 }, baseline);
    expect(result.geometry).toEqual(baseline.geometry);
    expect(result.experience!.candidates).toBeLessThanOrEqual(1);
    expect(result.status).toBe("ok");
  });

  it("does not infer destinations from forest or weaker propagated rewards", () => {
    const withoutSources = {
      ...graph,
      edges: graph.edges.map((e) => ({
        ...e,
        reward: Math.min(e.reward ?? 0, 0.7),
      })),
    };
    expect(explore(withoutSources, request, baseline)).toBe(baseline);
  });

  it("does not collect a scenic prize by riding a dead-end twice", () => {
    const points: Point[] = [
      [6, 46],
      [6.02, 46],
      [6.04, 46],
      [6.02, 46.004],
    ];
    const links = [
      [0, 1],
      [1, 2],
      [1, 3],
      [3, 1],
    ];
    const edges: Edge[] = links.map(([from, to], id) => ({
      ...graph.edges[0],
      id,
      from,
      to,
      way: String(id),
      length: distance(points[from], points[to]),
      geometry: [points[from], points[to]],
      grades: [[distance(points[from], points[to]), 0]],
      highway: "unclassified",
      surface: "paved",
      tags: {},
      stress: 0,
      urban: 0,
      uncertainty: 0,
      utility: 1,
      cyclingNetwork: 0,
      forest: id >= 2 ? 1 : 0,
      reward: id === 2 ? 1 : 0,
      quality: 0,
      junction: 0,
    }));
    const spur: Graph = {
      schemaVersion: 1,
      bbox: [5.9, 45.9, 6.1, 46.1],
      nodes: points.map((p, id) => ({ id, p, elevation: 0 })),
      edges,
      restrictions: [],
    };
    const req = { ...request, anchors: [points[0], points[2]] };
    const direct = route(spur, req, "reference");
    const result = explore(spur, req, direct);
    expect(result.experience!.candidates).toBe(1);
    expect(result.geometry).toEqual(direct.geometry);
    expect(result.experience!.scenicBonus).toBe(0);
  });
});
