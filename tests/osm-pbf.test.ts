/**
 * The PBF reader against real extracts.
 *
 * The expectations were produced by pyosmium — the reader the Python builder uses — over
 * the same files, with identical canonical forms on both sides: scaled integer
 * coordinates, ordered way refs, ordered relation members with roles, and the full tag
 * map. Every value below matched exactly when they were recorded, so a change here means
 * the reader has drifted from osmium, not that the numbers need updating.
 *
 * The fold is an xor of per-element digests, so it is order-independent but sensitive to
 * any element's content; the counts and sums localise a failure to a kind of element.
 * Skipped when the extracts are absent, as the release tests are.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { readPbf } from "../src/build/osm/pbf";
import { inflate } from "../src/build/platform/node";

const CELLS = "data/pbf/geneva-toulon-v7/cells";

type Expectation = {
  counts: { node: number; way: number; relation: number };
  ids: { nodeId: string; wayId: string; relationId: string };
  sums: { refs: number; members: number; tags: number };
  fold: { node: string; way: string; relation: string };
};

const EXPECTED: Record<string, Expectation> = {
  "9-266-187": {
    counts: { node: 163101, way: 26222, relation: 329 },
    ids: { nodeId: "888517674015874", wayId: "17380645027885", relationId: "3690352300" },
    sums: { refs: 207098, members: 2099, tags: 149075 },
    fold: { node: "46f6a77fdda5363", way: "8550ef68bd0e44cc", relation: "293798c591e58882" },
  },
  "9-262-187": {
    counts: { node: 455963, way: 28010, relation: 434 },
    ids: { nodeId: "2815631599717136", wayId: "19080179594412", relationId: "5017832693" },
    sums: { refs: 498937, members: 3003, tags: 96131 },
    fold: { node: "f7af0754c2c36d3f", way: "2bc45ffd87709ffa", relation: "712cbb8f8f0fddd0" },
  },
  "9-264-181": {
    counts: { node: 2992035, way: 286312, relation: 3987 },
    ids: { nodeId: "16889097457781942", wayId: "177352476103083", relationId: "43163613279" },
    sums: { refs: 3531906, members: 41705, tags: 1204465 },
    fold: { node: "5196c8f5f1f6f5eb", way: "e47a71d25422b2e5", relation: "d8648dd74370a92e" },
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
  for (const [cell, expected] of Object.entries(EXPECTED)) {
    const path = `${CELLS}/${cell}.osm.pbf`;
    const present = fs.existsSync(path);
    it.skipIf(!present)(`matches osmium on ${cell}`, async () => {
      expect(await summarise(path)).toEqual(expected);
    }, 60_000);
  }
});
