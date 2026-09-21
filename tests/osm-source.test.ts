/**
 * The cell loader against `scripts/osm_source.py`, which the Python builder reads through.
 *
 * The expectations were produced by running `load_elements` over the same extracts and
 * digesting the same things: tagged node elements with their scaled coordinates and tags,
 * and every way's fully resolved geometry. Each matched exactly when recorded, so a change
 * here means the loader has drifted from the reader the builder is being ported against.
 *
 * `geometryPoints` and `waysMissingPositions` are asserted separately from the fold because
 * they say *where* a drift is: a fold alone cannot distinguish a moved coordinate from a
 * dropped way. Skipped when the extracts are absent, as the release tests are.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { geometry, readSource } from "../src/build/osm/source";
import { inflate } from "../src/build/platform/node";

const CELLS = "data/pbf/geneva-toulon-v7/cells";

const EXPECTED = {
  "9-266-187": {
    counts: { node: 14642, way: 26222, relation: 329 },
    waysMissingPositions: 0,
    geometryPoints: 207098,
    fold: { node: "e5115f4104fb2106", wayGeometry: "6df5db60b7dbfdf5" },
  },
  "9-262-187": {
    counts: { node: 4743, way: 28010, relation: 434 },
    waysMissingPositions: 0,
    geometryPoints: 498937,
    fold: { node: "b19fb7b95bd7e52f", wayGeometry: "cf1fdb05a3ee8fb0" },
  },
  "9-264-181": {
    counts: { node: 72923, way: 286312, relation: 3987 },
    waysMissingPositions: 0,
    geometryPoints: 3531906,
    fold: { node: "209595e694517084", wayGeometry: "7688914b68d499eb" },
  },
};

const digest = (text: string) =>
  BigInt("0x" + createHash("sha256").update(text).digest("hex").slice(0, 16));
const scaled = (value: number) => Math.round(value * 1e7);
const canon = (tags: Record<string, string>) =>
  Object.keys(tags)
    .sort()
    .map((k) => `${k}=${tags[k]}`)
    .join("\x1f");

async function summarise(path: string) {
  const source = await readSource(new Uint8Array(fs.readFileSync(path)), inflate);
  const fold = { node: 0n, wayGeometry: 0n };
  let waysMissingPositions = 0;
  let geometryPoints = 0;
  for (const node of source.nodes)
    fold.node ^= digest(`${node.id}|${scaled(node.lon)}|${scaled(node.lat)}|${canon(node.tags)}`);
  for (const way of source.ways) {
    const coords = geometry(way, source.positions);
    if (!coords) {
      waysMissingPositions++;
      continue;
    }
    geometryPoints += coords.length;
    fold.wayGeometry ^= digest(
      `${way.id}|${coords.map((p) => `${scaled(p[0])},${scaled(p[1])}`).join(";")}`,
    );
  }
  return {
    counts: {
      node: source.nodes.length,
      way: source.ways.length,
      relation: source.relations.length,
    },
    waysMissingPositions,
    geometryPoints,
    fold: { node: fold.node.toString(16), wayGeometry: fold.wayGeometry.toString(16) },
  };
}

describe("cell source loader", () => {
  for (const [cell, expected] of Object.entries(EXPECTED)) {
    const path = `${CELLS}/${cell}.osm.pbf`;
    const present = fs.existsSync(path);
    it.skipIf(!present)(
      `matches osm_source.py on ${cell}`,
      async () => {
        expect(await summarise(path)).toEqual(expected);
      },
      120_000,
    );
  }

  it("resolves way geometry through the node index", async () => {
    const path = `${CELLS}/9-266-187.osm.pbf`;
    if (!fs.existsSync(path)) return;
    const source = await readSource(new Uint8Array(fs.readFileSync(path)), inflate);
    const way = source.ways.find((w) => w.refs.length > 2)!;
    const coords = geometry(way, source.positions)!;
    expect(coords).toHaveLength(way.refs.length);
    // The index has to answer for every node a way names, tagged or not.
    expect(way.refs.every((ref) => source.positions.has(ref))).toBe(true);
    // A ref that is not in the extract makes the whole way unusable, not a partial shape.
    expect(geometry({ ...way, refs: [...way.refs, -1] }, source.positions)).toBeUndefined();
  });
});
