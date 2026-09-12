import { expect, it } from "vitest";
import { eligible } from "../src/routing/eligibility";
import { route, scoreEdge, distance } from "../src/routing/engine";
import { selectedRoute } from "../src/routing/selection";
import { total } from "../src/routing/engine";
import type { Edge, Graph, Point } from "../src/routing/types";
import { GRAVEL, ROAD, TOURING } from "./helpers";
const points: Point[] = [
  [6.1, 46.1],
  [6.102, 46.1],
  [6.101, 46.102],
];
const edge = (from = 0, to = 1): Edge => ({
  id: 0,
  from,
  to,
  way: "hike",
  length: distance(points[from], points[to]),
  geometry: [points[from], points[to]],
  grades: null,
  surface: "unknown",
  highway: "path",
  stress: 0.08,
  uncertainty: 0.7,
  utility: 0.5,
  urban: 0,
  cyclingNetwork: 0,
  reward: 0.1,
  bridge: false,
  tunnel: false,
  name: "",
  tile: "test",
});
it("prices technical and unsurveyed paths steeply without excluding them", () => {
  // This test used to assert the opposite: an unsurveyed path or an mtb:scale tag made
  // the edge ineligible, which is how a preference could return "no-path". Difficulty is
  // priced now, so the ordering it was really checking survives and the exclusions do not.
  for (const profile of [ROAD, GRAVEL, TOURING]) {
    const plain = total(scoreEdge(edge(), profile));
    let previous = plain;
    for (const tags of [
      { "mtb:scale": "2" },
      { "mtb:scale": "3" },
      { "mtb:scale": "5" },
    ]) {
      const e = { ...edge(), tags };
      expect(eligible(e, profile), profile.id).toBe(true);
      const cost = total(scoreEdge(e, profile));
      expect(cost, `${profile.id} ${JSON.stringify(tags)}`).toBeGreaterThanOrEqual(previous);
      previous = cost;
    }
    // An unsurveyed path is not assumed easy either: it still costs more than a street.
    expect(plain).toBeGreaterThan(
      total(scoreEdge({ ...edge(), highway: "residential", surface: "paved" }, profile)),
    );
  }
  // A road bike is more put off by a gravel track than a gravel bike is.
  const track = { ...edge(), highway: "track", surface: "gravel" };
  expect(total(scoreEdge(track, ROAD))).toBeGreaterThan(
    total(scoreEdge(track, GRAVEL)),
  );
});
it("takes a rideable detour and snaps only to eligible edges", () => {
  // Snapping must land on a usable edge, so the one to avoid has to be genuinely barred
  // rather than merely hard: difficulty is priced now and never removes an edge.
  const bad = { ...edge(), tags: { bicycle: "no" } };
  const a = {
    ...edge(0, 2),
    id: 1,
    way: "road",
    highway: "residential",
    surface: "paved",
    grades: [[500, 0]] as [number, number][],
  };
  const b = {
    ...edge(2, 1),
    id: 2,
    way: "road",
    highway: "residential",
    surface: "paved",
    grades: [[500, 0]] as [number, number][],
  };
  const graph: Graph = {
    schemaVersion: 1,
    bbox: [6, 46, 6.2, 46.2],
    nodes: points.map((p, id) => ({ id, p, elevation: 0 })),
    edges: [bad, a, b],
    restrictions: [],
  };
  for (const profile of [ROAD, GRAVEL]) {
    const result = route(
      graph,
      { profile, anchors: [points[0], points[1]] },
      "reference",
    );
    expect(result.status).toBe("ok");
    expect(result.edgeIds).toEqual([1, 2]);
    const middle: Point = [6.101, 46.1];
    const snapped = route(
      graph,
      { profile, anchors: [middle, points[1]] },
      "reference",
    );
    expect(snapped.anchors[0]).not.toEqual(middle);
  }
});
it("displays and exports the cheaper full-graph result", () => {
  const g: Graph = {
    schemaVersion: 1,
    bbox: [6, 46, 6.2, 46.2],
    nodes: points.map((p, id) => ({ id, p, elevation: 0 })),
    edges: [{ ...edge(), highway: "residential", surface: "paved" }],
    restrictions: [],
  };
  const reference = route(
    g,
    { profile: ROAD, anchors: points.slice(0, 2) },
    "reference",
  );
  const corridor = {
    ...reference,
    cost: reference.cost * 10,
    mode: "corridor" as const,
  };
  expect(selectedRoute({ reference, corridor, relativeCost: 9 })).toBe(
    reference,
  );
  expect(
    selectedRoute({
      reference: { ...reference, status: "budget-exceeded" },
      corridor,
      relativeCost: null,
    }),
  ).toBe(corridor);
});
