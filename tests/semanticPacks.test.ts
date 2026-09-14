import { expect, it } from "vitest";
import {
  encodeBlock,
  decodeBlock,
  stringTable,
} from "../src/offline/ibex/block";
import { edgeSignals } from "../src/routing/signals";
import { snapAnchors } from "../src/routing/engine";
import type { Edge, Graph } from "../src/routing/types";

const graph: Graph = {
  schemaVersion: 1,
  bbox: [6, 46, 7, 47],
  restrictions: [],
  nodes: [
    { id: 1, p: [6.1, 46.1], elevation: 400 },
    { id: 2, p: [6.11, 46.11], elevation: 440 },
  ],
  edges: [],
};
const forward: Edge = {
  id: 8192,
  from: 1,
  to: 2,
  way: "1",
  length: 1300,
  geometry: [
    [6.1, 46.1],
    [6.105, 46.1],
    [6.11, 46.11],
  ],
  grades: [[1300, 0.04]],
  surface: "compacted",
  highway: "track",
  tags: { "mtb:scale:uphill": "2", "mtb:scale:downhill": "0" },
  stress: 0,
  uncertainty: 0,
  utility: 1,
  urban: 0,
  cyclingNetwork: 0,
  bridge: false,
  tunnel: false,
  name: "",
  tile: "test",
};
graph.edges = [
  forward,
  {
    ...forward,
    id: 8193,
    from: 2,
    to: 1,
    geometry: [...forward.geometry].reverse(),
    grades: [[1300, -0.04]],
  },
];

it("new binary packs carry independently derived signals in both directions", () => {
  const table = stringTable();
  const bytes = encodeBlock(
    { x: 1, y: 2 },
    graph.nodes,
    graph.edges,
    table,
    123,
    { semantics: true },
  );
  const decoded = decodeBlock(bytes, table.values(), { releaseTag: 123 });
  for (const [i, edge] of decoded.edges.entries()) {
    expect(edge.semantics?.version).toBe(1);
    const expected = edgeSignals(graph.edges[i]);
    for (const key of [
      "roughness",
      "technicalUp",
      "technicalDown",
      "unpaved",
      "curvature",
    ] as const)
      expect(edgeSignals(edge)[key]).toBeCloseTo(expected[key], 5);
    expect(edgeSignals(edge).surfaceKnown).toBe(expected.surfaceKnown);
  }
  // Split pieces keep the parent's facts, so a waypoint cannot change what a way costs.
  const snapped = snapAnchors({ ...graph, ...decoded }, [[6.103, 46.1]])!;
  const parents = new Map(decoded.edges.map((e) => [e.way, e.semantics]));
  for (const edge of snapped.graph.edges)
    expect(edge.semantics).toEqual(parents.get(edge.way));
});

it("old packs still derive the same facts locally", () => {
  const table = stringTable();
  const bytes = encodeBlock(
    { x: 1, y: 2 },
    graph.nodes,
    graph.edges,
    table,
    123,
  );
  const decoded = decodeBlock(bytes, table.values(), { releaseTag: 123 });
  expect(decoded.edges[0].semantics).toBeUndefined();
  expect(edgeSignals(decoded.edges[0])).toEqual(edgeSignals(forward));
});

it("rejects corrupted precomputed facts", () => {
  const table = stringTable();
  const bad: Edge = {
    ...forward,
    semantics: { ...edgeSignals(forward), version: 1, roughness: 2 },
  };
  const bytes = encodeBlock({ x: 1, y: 2 }, graph.nodes, [bad], table, 123, {
    semantics: true,
  });
  expect(() => decodeBlock(bytes, table.values(), { releaseTag: 123 })).toThrow(
    "Invalid precomputed riding signals",
  );
});
