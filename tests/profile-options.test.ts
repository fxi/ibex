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
import { GRAVEL, withPermissions, withPreferences } from "./helpers";
const points: Point[] = [
  [6.1, 46.1],
  [6.101, 46.1],
  [6.102, 46.1],
];
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
it("prefers a rural detour when built-up surroundings are avoided", () => {
  const urban = edge(0, 2, { id: 0, way: "urban", urban: 1 });
  const rural = edge(0, 2, { id: 1, way: "rural", length: urban.length * 1.4 });
  const g = graph([urban, rural]),
    anchors = [points[0], points[2]];
  expect(
    route(
      g,
      {
        anchors,
        profile: withPreferences(GRAVEL, {
          urbanity: "prefer",
          detour: "strongly_avoid",
        }),
      },
      "reference",
    ).edgeIds,
  ).toEqual([0]);
  const r = route(
    g,
    {
      anchors,
      profile: withPreferences(GRAVEL, { urbanity: "strongly_avoid" }),
    },
    "reference",
  );
  expect(r.edgeIds).toEqual([1]);
});
it("prefers a mapped cycling network without forbidding other connectors", () => {
  const shortcut = edge(0, 2, { id: 0, way: "plain" });
  const network = edge(0, 2, {
    id: 1,
    way: "network",
    cyclingNetwork: 1,
    length: shortcut.length * 1.5,
  });
  const p = withPreferences(GRAVEL, {
    cycle_infrastructure: "strongly_prefer",
  });
  const r = route(
    graph([shortcut, network]),
    { anchors: [points[0], points[2]], profile: p },
    "reference",
  );
  expect(r.edgeIds).toEqual([1]);
  expect(eligible(shortcut, p)).toBe(true);
});
it("prices stairs as carrying, and refusing them makes them a last resort", () => {
  const steps = edge(0, 1, {
    highway: "steps",
    surface: "unknown",
    grades: null,
  });
  const allowed = withPermissions(GRAVEL, { stairs: true, push: true });
  const refused = withPermissions(GRAVEL, { stairs: false, push: false });
  // Stairs are never removed for a preference: a rider can always carry the bike, and a
  // profile that would rather not is told so in the price.
  expect(eligible(steps, allowed)).toBe(true);
  expect(eligible(steps, refused)).toBe(true);
  const r = route(
    graph([steps]),
    { anchors: points.slice(0, 2), profile: allowed },
    "reference",
  );
  expect(r.status).toBe("ok");
  expect(r.hikeABikeM).toBeCloseTo(steps.length);
  expect(r.components.walking).toBeGreaterThan(steps.length);
  expect(scoreEdge(steps, refused).walking).toBeGreaterThan(
    scoreEdge(steps, allowed).walking,
  );
  // The law still applies.
  expect(eligible({ ...steps, tags: { bicycle: "no" } }, allowed)).toBe(false);
  expect(eligible({ ...steps, tags: { foot: "no" } }, allowed)).toBe(false);
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
  const p = withPermissions(GRAVEL, { ferry: true });
  expect(eligible(first, p)).toBe(true);
  // A ferry is a mode choice, not a difficulty: refusing it really does remove the link.
  expect(eligible(first, withPermissions(GRAVEL, { ferry: false }))).toBe(
    false,
  );
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
