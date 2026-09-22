/**
 * The PBF reader against a real extract.
 *
 * The fixture is Geofabrik's Monaco download, committed because it is small (676 KB) and
 * still genuinely real: dense nodes, a string table, multiple blobs, relations with roles.
 *
 * The expectations below were recorded from this reader once pyosmium — the reader the
 * Python builder used — had been shown to agree with it element for element on the old
 * per-cell extracts, in identical canonical forms: scaled integer coordinates, ordered way
 * refs, ordered relation members with roles, the full tag map. Those extracts are gone with
 * the region model, and so is pyosmium, so this is no longer a live cross-check against
 * osmium: it locks the reader against drift from a state that was verified against it.
 *
 * The fold is an xor of per-element digests, so it is order-independent but sensitive to
 * any element's content; the counts and sums localise a failure to a kind of element.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { readPbf } from "../src/build/osm/pbf";
import { inflate } from "../src/build/platform/node";

export const MONACO = "tests/fixtures/osm/monaco.osm.pbf";

type Expectation = {
  counts: { node: number; way: number; relation: number };
  ids: { nodeId: string; wayId: string; relationId: string };
  sums: { refs: number; members: number; tags: number };
  fold: { node: string; way: string; relation: string };
};

const EXPECTED: Record<string, Expectation> = {
  monaco: {
    counts: { node: 41703, way: 6248, relation: 348 },
    ids: { nodeId: "244553901793413", wayId: "3978102628683", relationId: "3294205633" },
    sums: { refs: 50620, members: 40412, tags: 45103 },
    fold: { node: "ecee4d0dbc7a630c", way: "17c0ef9f1fabc7c6", relation: "96d3a36922f26d12" },
  },
};

const digest = (text: string) =>
  BigInt("0x" + createHash("sha256").update(text).digest("hex").slice(0, 16));
const canon = (tags: Record<string, string>) =>
  Object.keys(tags)
    .sort()
    .map((k) => `${k}=${tags[k]}`)
    .join("\x1f");
/** Degrees back to the scaled integers they came from, so no float formatting is involved. */
const scaled = (value: number) => Math.round(value * 1e7);

async function summarise(path: string) {
  const counts = { node: 0, way: 0, relation: 0 };
  // Id sums pass 2^53 on a dense cell, which a double cannot hold.
  const ids = { nodeId: 0n, wayId: 0n, relationId: 0n };
  const sums = { refs: 0, members: 0, tags: 0 };
  const fold = { node: 0n, way: 0n, relation: 0n };
  await readPbf(
    new Uint8Array(fs.readFileSync(path)),
    {
      node: (n) => {
        counts.node++;
        ids.nodeId += BigInt(n.id);
        sums.tags += Object.keys(n.tags).length;
        fold.node ^= digest(`${n.id}|${scaled(n.lon)}|${scaled(n.lat)}|${canon(n.tags)}`);
      },
      way: (w) => {
        counts.way++;
        ids.wayId += BigInt(w.id);
        sums.refs += w.refs.length;
        sums.tags += Object.keys(w.tags).length;
        fold.way ^= digest(`${w.id}|${w.refs.join(",")}|${canon(w.tags)}`);
      },
      relation: (r) => {
        counts.relation++;
        ids.relationId += BigInt(r.id);
        sums.members += r.members.length;
        sums.tags += Object.keys(r.tags).length;
        const members = r.members.map((m) => `${m.type[0]}:${m.ref}:${m.role}`).join("|");
        fold.relation ^= digest(`${r.id}|${members}|${canon(r.tags)}`);
      },
    },
    inflate,
  );
  return {
    counts,
    ids: { nodeId: ids.nodeId.toString(), wayId: ids.wayId.toString(), relationId: ids.relationId.toString() },
    sums,
    fold: { node: fold.node.toString(16), way: fold.way.toString(16), relation: fold.relation.toString(16) },
  };
}

describe("OSM PBF reader", () => {
  for (const [name, expected] of Object.entries(EXPECTED))
    it(`reads ${name} element for element`, async () => {
      expect(await summarise(MONACO)).toEqual(expected);
    }, 60_000);
});
