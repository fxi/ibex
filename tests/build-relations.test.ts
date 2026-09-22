/**
 * What relations say about a way.
 *
 * Checked against `scripts/profile_features.py` on three real extracts — cycling membership
 * over 340,544 ways and every ferry's metadata agreed exactly — so these state the rules
 * rather than repeat the digests. The duration cases are where a lenient parse would drift
 * quietly: a ferry charged the wrong crossing time is worse than one charged none.
 */
import { describe, expect, it } from "vitest";
import { cyclingMemberships, durationSeconds, onCyclingNetwork } from "../src/build/relations";
import type { CellSource, OsmWay } from "../src/build/osm/source";
import type { OsmRelation } from "../src/build/osm/pbf";

const way = (id: number, tags: Record<string, string> = {}): OsmWay => ({ id, refs: [], tags });

const sourceOf = (relations: OsmRelation[]): CellSource =>
  ({ relations, ways: [], nodes: [], wayById: new Map() }) as unknown as CellSource;

const route = (id: number, members: OsmRelation["members"], tags: Record<string, string> = {}) => ({
  id,
  members,
  tags: { type: "route", route: "bicycle", ...tags },
});

describe("durationSeconds", () => {
  it("reads bare minutes, hours and seconds", () => {
    expect(durationSeconds("30")).toBe(1800);
    expect(durationSeconds("1:30")).toBe(5400);
    expect(durationSeconds("0:45:30")).toBe(2730);
    expect(durationSeconds("00:20")).toBe(1200);
  });

  it("refuses what is not a whole number of parts", () => {
    // A decimal is not an int; Python's int() raises on it and so must this.
    expect(durationSeconds("1.5")).toBeUndefined();
    expect(durationSeconds("abc")).toBeUndefined();
    expect(durationSeconds("1:2:3:4")).toBeUndefined();
    expect(durationSeconds("")).toBeUndefined();
    expect(durationSeconds(undefined)).toBeUndefined();
  });

  it("refuses negative, zero and absurd durations", () => {
    expect(durationSeconds("-5")).toBeUndefined();
    expect(durationSeconds("5:-1")).toBeUndefined();
    expect(durationSeconds("0")).toBeUndefined();
    // A week is the limit; past it the tag is a typo, not a crossing.
    expect(durationSeconds("10080")).toBe(604800);
    expect(durationSeconds("10081")).toBeUndefined();
  });

  it("tolerates the whitespace and sign Python's int() does", () => {
    expect(durationSeconds(" 7 ")).toBe(420);
    expect(durationSeconds("+5")).toBe(300);
  });
});

describe("cyclingMemberships", () => {
  it("carries both directions unless a role narrows it", () => {
    const memberships = cyclingMemberships(
      sourceOf([
        route(1, [
          { type: "way", ref: 10, role: "" },
          { type: "way", ref: 11, role: "forward" },
        ]),
      ]),
    );
    expect([...memberships.get(10)!].sort()).toEqual(["backward", "forward"]);
    expect([...memberships.get(11)!]).toEqual(["forward"]);
  });

  it("follows nested route relations, narrowing as it descends", () => {
    const memberships = cyclingMemberships(
      sourceOf([
        route(1, [{ type: "relation", ref: 2, role: "forward" }]),
        { id: 2, tags: {}, members: [{ type: "way", ref: 10, role: "" }] },
      ]),
    );
    expect([...memberships.get(10)!]).toEqual(["forward"]);
  });

  it("does not loop on a relation that contains itself", () => {
    const memberships = cyclingMemberships(
      sourceOf([
        route(1, [
          { type: "relation", ref: 1, role: "" },
          { type: "way", ref: 10, role: "" },
        ]),
      ]),
    );
    expect(memberships.get(10)).toBeDefined();
  });

  it("ignores routes that are not built or not signed", () => {
    const unbuilt: Record<string, string>[] = [
      { state: "proposed" },
      { state: "construction" },
      { signposted: "no" },
    ];
    for (const tags of unbuilt)
      expect(
        cyclingMemberships(sourceOf([route(1, [{ type: "way", ref: 10, role: "" }], tags)])).size,
      ).toBe(0);
  });

  it("ignores routes that are not for bicycles", () => {
    expect(
      cyclingMemberships(
        sourceOf([route(1, [{ type: "way", ref: 10, role: "" }], { route: "hiking" })]),
      ).size,
    ).toBe(0);
    expect(
      cyclingMemberships(sourceOf([route(1, [{ type: "way", ref: 10, role: "" }], { route: "mtb" })]))
        .size,
    ).toBe(1);
  });
});

describe("onCyclingNetwork", () => {
  const empty = new Map();

  it("honours the legacy network tags on the way itself", () => {
    expect(onCyclingNetwork(way(1, { lcn: "yes" }), "forward", empty)).toBe(1);
    expect(onCyclingNetwork(way(1, { ncn_ref: "EV17" }), "backward", empty)).toBe(1);
    expect(onCyclingNetwork(way(1, { lcn: "no" }), "forward", empty)).toBe(0);
  });

  it("answers per direction from the membership", () => {
    const memberships = new Map([[1, new Set<"forward" | "backward">(["forward"])]]);
    expect(onCyclingNetwork(way(1), "forward", memberships)).toBe(1);
    expect(onCyclingNetwork(way(1), "backward", memberships)).toBe(0);
  });
});
