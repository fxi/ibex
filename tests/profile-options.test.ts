import { expect, it } from "vitest";
import {
  distance,
  route,
  scoreEdge,
  total,
  snapAnchors,
} from "../src/routing/engine";
import { eligible } from "../src/routing/eligibility";
import type { Edge, Graph, Point } from "../src/routing/types";
import type { UserProfile } from "../src/routing/profiles";
const points: Point[] = [
  [6.1, 46.1],
  [6.101, 46.1],
  [6.102, 46.1],
];
const profile = (overrides: Partial<UserProfile> = {}): UserProfile => ({
  version: 1,
  name: "Options",
  bike: "gravel",
  ...overrides,
});
function edge(from: number, to: number, overrides: Partial<Edge> = {}): Edge {
  const length = distance(points[from], points[to]);
  return {
    id: from,
    from,
    to,
    way: String(from),
    geometry: [points[from], points[to]],
    length,
    grades: [[length, 0]],
    highway: "cycleway",
    surface: "paved",
    tags: {},
    urban: 0,
    cyclingNetwork: 0,
    stress: 0,
    uncertainty: 0,
    utility: 1,
    bridge: false,
    tunnel: false,
    name: "test",
    tile: "test",
    ...overrides,
  };
}
function graph(edges: Edge[]): Graph {
  return {
    schemaVersion: 1,
    bbox: [6, 46, 6.2, 46.2],
    edges,
    restrictions: [],
    nodes: points.map((p, id) => ({ id, p, elevation: 400 })),
  };
}
it("prefers a rural detour when countryside attraction is enabled", () => {
  const urban = edge(0, 2, { id: 0, way: "urban", urban: 1 });
  const rural = edge(0, 2, { id: 1, way: "rural", length: urban.length * 1.5 });
  const g = graph([urban, rural]),
    anchors = [points[0], points[2]];
  expect(
    route(g, { anchors, profile: profile() }, "reference").edgeIds,
  ).toEqual([0]);
  const r = route(
    g,
    { anchors, profile: profile({ attraction: { countryside: 100 } }) },
    "reference",
  );
  expect(r.edgeIds).toEqual([1]);
  expect(r.components.countryside).toBe(0);
});
it("prefers a mapped cycling network without forbidding other connectors", () => {
  const shortcut = edge(0, 2, { id: 0, way: "plain" });
  const network = edge(0, 2, {
    id: 1,
    way: "network",
    cyclingNetwork: 1,
    length: shortcut.length * 1.5,
  });
  const p = profile({ attraction: { cycling_network: 100 } });
  const r = route(
    graph([shortcut, network]),
    { anchors: [points[0], points[2]], profile: p },
    "reference",
  );
  expect(r.edgeIds).toEqual([1]);
  expect(eligible(shortcut, p)).toBe(true);
});
it("requires both stair and carrying permission even on the road preset", () => {
  const steps = edge(0, 1, {
    highway: "steps",
    surface: "unknown",
    grades: null,
  });
  expect(eligible(steps, profile({ access: { steps: true } }))).toBe(false);
  expect(eligible(steps, profile({ access: { hike_a_bike: true } }))).toBe(
    false,
  );
  const p = profile({
    bike: "road",
    access: { steps: true, hike_a_bike: true },
    capabilities: { max_grade_up: 15 },
  });
  expect(eligible(steps, p)).toBe(true);
  const r = route(
    graph([steps]),
    { anchors: points.slice(0, 2), profile: p },
    "reference",
  );
  expect(r.status).toBe("ok");
  expect(r.hikeABikeM).toBeCloseTo(steps.length);
  expect(r.components.walking).toBeGreaterThan(steps.length);
  expect(eligible({ ...steps, tags: { bicycle: "no" } }, p)).toBe(false);
  expect(eligible({ ...steps, tags: { foot: "no" } }, p)).toBe(false);
});
it("prices ferry travel and boards once across service segments and waypoints", () => {
  const first = edge(0, 1, {
    highway: "ferry",
    surface: "unknown",
    grades: null,
    ferrySeconds: 300,
    ferryService: "f1",
  });
  const second = edge(1, 2, {
    highway: "ferry",
    surface: "unknown",
    grades: null,
    ferrySeconds: 300,
    ferryService: "f1",
  });
  const p = profile({
    bike: "road",
    access: { ferry: true },
    capabilities: { max_grade_up: 0, max_grade_down: 0 },
  });
  expect(eligible(first, p)).toBe(true);
  expect(eligible(first, profile())).toBe(false);
  expect(eligible({ ...first, tags: { bicycle: "no" } }, p)).toBe(false);
  expect(scoreEdge(first, p).slope).toBe(0);
  const result = route(
    graph([first, second]),
    { anchors: points, profile: p },
    "reference",
  );
  expect(result.status).toBe("ok");
  expect(result.components.ferry).toBe(600 * 4 + 1000);
  expect(result.cost).toBeCloseTo(
    total(scoreEdge(first, p)) + total(scoreEdge(second, p)) + 1000,
  );
  expect(result.ferryM).toBeCloseTo(first.length + second.length);
  expect(result.ascentM).toBe(0);
  expect(result.hikeABikeM).toBe(0);
  const another = route(
    graph([first, { ...second, ferryService: "f2" }]),
    { anchors: points, profile: p },
    "reference",
  );
  expect(another.components.ferry).toBe(result.components.ferry + 1000);
});
it("preserves ferry travel duration when snapping splits a crossing", () => {
  const crossing = edge(0, 2, {
    highway: "ferry",
    surface: "unknown",
    grades: null,
    ferrySeconds: 600,
    ferryService: "f1",
  });
  const split = snapAnchors(graph([crossing]), [points[1]])!;
  expect(
    split.graph.edges.reduce((sum, e) => sum + (e.ferrySeconds ?? 0), 0),
  ).toBeCloseTo(600);
});
