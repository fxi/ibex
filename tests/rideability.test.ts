import { expect, it } from "vitest";
import { eligible } from "../src/routing/eligibility";
import { route, scoreEdge, distance } from "../src/routing/engine";
import { selectedRoute } from "../src/routing/selection";
import type { Edge, Graph, Point } from "../src/routing/types";
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
  bridge: false,
  tunnel: false,
  name: "",
  tile: "test",
});
it("excludes technical and undocumented hiking paths despite missing grades", () => {
  for (const profile of ["road", "gravel", "touring"] as const) {
    for (const tags of [
      {},
      { "mtb:scale": "3" },
      { "mtb:scale": "5" },
      { sac_scale: "mountain_hiking" },
    ] as Record<string, string>[])
      expect(eligible({ ...edge(), tags }, profile)).toBe(false);
    expect(
      eligible(
        { ...edge(), surface: "paved", tags: { "mtb:scale": "5" } },
        profile,
      ),
    ).toBe(false);
    expect(scoreEdge(edge(), profile).slope).toBeGreaterThan(0);
  }
  expect(eligible({ ...edge(), surface: "compacted" }, "gravel")).toBe(true);
  expect(
    eligible({ ...edge(), highway: "track", surface: "gravel" }, "road"),
  ).toBe(false);
  expect(eligible({ ...edge(), highway: "residential" }, "road")).toBe(true);
});
it("takes a rideable detour and snaps only to eligible edges", () => {
  const bad = { ...edge(), tags: { "mtb:scale": "3" } };
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
  for (const profile of ["road", "gravel"] as const) {
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
    { profile: "road", anchors: points.slice(0, 2) },
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
