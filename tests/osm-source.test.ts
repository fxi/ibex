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

const MONACO = "tests/fixtures/osm/monaco.osm.pbf";

const EXPECTED = {
  monaco: {
    counts: { node: 4251, way: 6248, relation: 348 },
    waysMissingPositions: 0,
    geometryPoints: 50620,
    fold: { node: "fde4a2db4df4939f", wayGeometry: "bd1981d9c99249c9" },
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
  for (const [name, expected] of Object.entries(EXPECTED))
    it(
      `loads ${name} into the shape the graph build reads`,
      async () => {
        expect(await summarise(MONACO)).toEqual(expected);
      },
      120_000,
    );

  it("resolves way geometry through the node index", async () => {
    const path = MONACO;
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
