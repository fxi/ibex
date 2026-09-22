/**
 * The whole builder, on a real cell.
 *
 * The counts below are what `scripts/build_region.py` produces for the same extract with
 * cell-local split nodes and no terrain, and `scripts/build_parity.ts` confirmed the graphs
 * agree field by field: every edge id, node id, geometry, length, tag, grade and restriction
 * matched, and only the three rasterised signals — forest, urban, reward — differed.
 *
 * So this guards the part with a right answer. What the signals should be is settled by the
 * gold routes, not here.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { readSource } from "../src/build/osm/source";
import { inflate } from "../src/build/platform/node";
import { buildGraph, edgeUid } from "../src/build/graph";
import { parseCellId } from "../src/geo/grid";

const CELL = "9-266-187";
const EXTRACT = `data/pbf/geneva-toulon-v7/cells/${CELL}.osm.pbf`;

describe("edgeUid", () => {
  it("is a pure function of way, node index and direction", () => {
    expect(edgeUid(1, 0, 0)).toBe(8192);
    expect(edgeUid(1, 0, 1)).toBe(8193);
    // The index is the segment's first node within the way, so an earlier cut moving does
    // not renumber what follows it.
    expect(edgeUid(1, 7, 0)).toBe(edgeUid(1, 7, 0));
    expect(edgeUid(2, 0, 0)).not.toBe(edgeUid(1, 0, 0));
  });

  it("stays inside the exactly-representable range", () => {
    // An OSM way id near the current maximum, at the last usable node index.
    expect(edgeUid(1_200_000_000, 2000, 1)).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("refuses a way longer than the id can describe", () => {
    expect(() => edgeUid(1, 4096, 0)).toThrow();
  });
});

describe.skipIf(!fs.existsSync(EXTRACT))("buildGraph", () => {
  it(
    "reproduces the Python builder's graph for a real cell",
    async () => {
      const source = await readSource(new Uint8Array(fs.readFileSync(EXTRACT)), inflate);
      const { graph, counts } = buildGraph(source, { cell: parseCellId(CELL) });

      expect(counts.nodes).toBe(4014);
      expect(counts.edges).toBe(7944);
      expect(counts.restrictions).toBe(46);
      expect(counts.waysMissingPositions).toBe(0);

      // Every edge the cell keeps starts inside it — that is what ownership means, and what
      // lets adjacent cells agree without consulting each other.
      expect(counts.edgesBeyondHalo).toBe(0);
      expect(counts.roadOvershootKm).toBeLessThan(5);

      // Identity is well formed: ids unique, both directions distinct, ends are real nodes.
      const ids = new Set(graph.edges.map((e) => e.id));
      expect(ids.size).toBe(graph.edges.length);
      const nodes = new Set(graph.nodes.map((n) => n.id));
      expect(graph.edges.every((e) => nodes.has(e.from) && nodes.has(e.to))).toBe(true);

      // A restriction that named a way this cell does not own would be unenforceable.
      const ways = new Set(graph.edges.map((e) => e.way));
      expect(graph.restrictions.every((r) => r.ways.every((w) => ways.has(w)))).toBe(true);

      // The rasterised signals stay in range, whatever they work out to.
      expect(graph.edges.every((e) => e.forest >= 0 && e.forest <= 1)).toBe(true);
      expect(graph.edges.every((e) => e.urban >= 0 && e.urban <= 1)).toBe(true);
      expect(graph.edges.every((e) => e.reward >= 0 && e.reward <= 1)).toBe(true);
    },
    120_000,
  );
});
