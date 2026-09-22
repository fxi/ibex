/**
 * The tag rules against `scripts/build_region.py`.
 *
 * Two layers. The corpus expectations below were produced by calling the Python
 * `permitted`, `directions` and `edge_quality` over every way in a real extract and
 * digesting the outcomes, including four stress levels per way so the rounding is
 * exercised; all three matched exactly when recorded. The unit assertions state the rules
 * a reader would want to check by eye, and would survive the extracts being absent.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { readPbf } from "../src/build/osm/pbf";
import { inflate } from "../src/build/platform/node";
import { directions, edgeQuality, permitted, PAVED } from "../src/build/tags";
import { roundTo } from "../src/build/round";

const MONACO = "tests/fixtures/osm/monaco.osm.pbf";
const STRESSES = [0.0, 0.15, 0.5, 0.95];

const EXPECTED = {
  monaco: {
    counts: { ways: 6248, permitted: 1677, forward: 6247, backward: 5546, quality: 4 },
    fold: "7e148e6ab74734e1",
  },
};

async function summarise(path: string) {
  let fold = 0n;
  const counts = { ways: 0, permitted: 0, forward: 0, backward: 0, quality: 0 };
  await readPbf(
    new Uint8Array(fs.readFileSync(path)),
    {
      way: ({ id, tags }) => {
        counts.ways++;
        const allowed = permitted(tags);
        const [forward, backward] = directions(tags);
        counts.permitted += allowed ? 1 : 0;
        counts.forward += forward ? 1 : 0;
        counts.backward += backward ? 1 : 0;
        const raw = tags.surface ?? "unknown";
        const surface = PAVED.has(raw) ? "paved" : raw;
        const qualities = STRESSES.map((s) => edgeQuality(tags.highway ?? "", surface, tags, s));
        counts.quality += qualities.filter((q) => q > 0).length;
        const line =
          `${id}|${allowed ? 1 : 0}${forward ? 1 : 0}${backward ? 1 : 0}|` +
          qualities.map((q) => q.toFixed(3)).join(",");
        fold ^= BigInt("0x" + createHash("sha256").update(line).digest("hex").slice(0, 16));
      },
    },
    inflate,
  );
  return { counts, fold: fold.toString(16) };
}

describe("tag rules", () => {
  for (const [name, expected] of Object.entries(EXPECTED))
    it(
      `scores every way in ${name}`,
      async () => {
        expect(await summarise(MONACO)).toEqual(expected);
      },
      120_000,
    );

  describe("permitted", () => {
    it("takes the most specific access tag", () => {
      expect(permitted({ highway: "track", access: "private" })).toBe(false);
      // bicycle outranks access, so an otherwise private track opens.
      expect(permitted({ highway: "track", access: "private", bicycle: "yes" })).toBe(true);
    });

    it("refuses anything conditional rather than guessing the condition", () => {
      expect(permitted({ highway: "track", "bicycle:conditional": "no @ (Nov-Mar)" })).toBe(false);
    });

    it("needs an explicit bicycle tag on roads that exclude bikes by default", () => {
      expect(permitted({ highway: "footway" })).toBe(false);
      expect(permitted({ highway: "footway", bicycle: "designated" })).toBe(true);
      expect(permitted({ highway: "trunk" })).toBe(false);
      expect(permitted({ highway: "primary", motorroad: "yes" })).toBe(false);
    });

    it("keeps steps unless walking them is forbidden", () => {
      expect(permitted({ highway: "steps" })).toBe(true);
      expect(permitted({ highway: "steps", foot: "no" })).toBe(false);
    });

    it("admits ferries, which have no highway tag", () => {
      expect(permitted({ route: "ferry" })).toBe(true);
      expect(permitted({ name: "not a way you can ride" })).toBe(false);
    });
  });

  describe("directions", () => {
    it("rides both ways by default and one way when told", () => {
      expect(directions({ highway: "residential" })).toEqual([true, true]);
      expect(directions({ highway: "residential", oneway: "yes" })).toEqual([true, false]);
      expect(directions({ highway: "residential", oneway: "-1" })).toEqual([false, true]);
    });

    it("treats a roundabout as one-way without the tag", () => {
      expect(directions({ highway: "residential", junction: "roundabout" })).toEqual([true, false]);
    });

    it("lets a contraflow lane undo a one-way", () => {
      expect(directions({ highway: "residential", oneway: "yes", cycleway: "opposite_lane" })).toEqual([
        true,
        true,
      ]);
    });

    it("prefers oneway:bicycle over oneway", () => {
      expect(
        directions({ highway: "residential", oneway: "yes", "oneway:bicycle": "no" }),
      ).toEqual([true, true]);
    });
  });

  describe("edgeQuality", () => {
    it("scores only tracks, paths and bridleways", () => {
      expect(edgeQuality("residential", "gravel", {}, 0)).toBe(0);
      expect(edgeQuality("track", "gravel", {}, 0)).toBe(0.7);
    });

    it("takes the weakest evidence present, ignoring absent tags", () => {
      // grade1 alone is good evidence; it does not get diluted by unknown surface.
      expect(edgeQuality("track", "unknown", { tracktype: "grade1" }, 0)).toBe(1);
      // but it never rescues a surface that is known to be bad.
      expect(edgeQuality("track", "mud", { tracktype: "grade1" }, 0)).toBe(0);
    });

    it("scores nothing when nothing is known", () => {
      expect(edgeQuality("path", "unknown", {}, 0)).toBe(0);
    });

    it("discounts by stress", () => {
      expect(edgeQuality("track", "gravel", {}, 0.5)).toBe(0.525);
    });
  });

  describe("roundTo", () => {
    // Each of these was checked against CPython's round() directly: a literal that looks
    // like a tie is not one, because the double beneath it sits just below the boundary.
    it("rounds the value's own decimal expansion", () => {
      expect(roundTo(8.165, 3)).toBe(8.165); // 8.16499999999999914...
      expect(roundTo(1.0005, 3)).toBe(1); // 1.00049999999999994...
      expect(roundTo(2.675, 2)).toBe(2.67); // 2.67499999999999982...
      expect(roundTo(0.525, 3)).toBe(0.525); // 0.52500000000000002...
    });

    it("refuses the one case where it would not match Python", () => {
      expect(() => roundTo(0.5, 0)).toThrow();
    });
  });
});
