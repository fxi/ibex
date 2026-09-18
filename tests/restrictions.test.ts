import { describe, expect, it } from "vitest";
import {
  compileRestrictions,
  restrictionAllows,
} from "../src/routing/restrictions";
import { buildAdjacency } from "../src/routing/adjacency";
import type { Edge, Graph } from "../src/routing/types";

/**
 * These were local to `route()`, reachable only by routing a graph and inferring what they
 * did from the line that came out. The behaviour is unchanged — `routing.test.ts` still
 * pins it end to end — but the state-space decisions are now stateable directly, which is
 * what the extraction was for.
 */
const edge = (id: number, from: number, to: number, way: string): Edge =>
  ({ id, from, to, way, length: 100, geometry: [] }) as unknown as Edge;

const rule = (
  ways: string[],
  extra: Partial<Graph["restrictions"][number]> = {},
): Graph["restrictions"][number] => ({ ways, only: false, ...extra });

describe("compileRestrictions", () => {
  it("indexes a simple turn by the way it departs from", () => {
    const { byWay } = compileRestrictions([rule(["a", "b"], { via: 7 })]);
    expect([...byWay.keys()]).toEqual(["a"]);
    expect(byWay.get("a")).toHaveLength(1);
  });

  it("indexes an only-restriction by every way it constrains", () => {
    // A via-way `only_` rule constrains each departure in the sequence, not just the last.
    const { byWay } = compileRestrictions([
      rule(["a", "b", "c"], { only: true }),
    ]);
    expect([...byWay.keys()].sort()).toEqual(["a", "b"]);
  });

  it("remembers nothing when no rule needs a history", () => {
    const { nextHistory } = compileRestrictions([rule(["a", "b"], { via: 1 })]);
    // A two-way rule needs one way of history, so an unrelated road is not accumulated.
    expect(nextHistory(["x"], "y")).toEqual(["y"]);
    expect(nextHistory(["y"], "y")).toEqual(["y"]);
  });

  it("keeps exactly the prefix a via-way rule still needs", () => {
    const { nextHistory, historyLength } = compileRestrictions([
      rule(["a", "b", "c"]),
    ]);
    expect(historyLength).toBe(2);
    // Mid-sequence: "a then b" is a live prefix of the rule, so both are retained.
    expect(nextHistory(["a"], "b")).toEqual(["a", "b"]);
    // Off the sequence: nothing about "x then y" can matter later.
    expect(nextHistory(["x"], "y")).toEqual(["y"]);
  });

  it("does not grow the history for a long rule that is not being followed", () => {
    // The regression behind this: one unrelated long restriction used to widen every state
    // in the region, multiplying equivalent states.
    const { nextHistory } = compileRestrictions([
      rule(["p", "q", "r", "s", "t"]),
    ]);
    expect(nextHistory(["m"], "n")).toEqual(["n"]);
  });
});

describe("restrictionAllows", () => {
  const rules = [rule(["a", "b"], { via: 5 })];

  it("refuses the forbidden turn at the node it applies to", () => {
    const next = edge(2, 5, 6, "b");
    expect(restrictionAllows(rules, ["a"], 5, next)).toBe(false);
    // Same turn, a different junction: the rule says nothing about it.
    expect(restrictionAllows(rules, ["a"], 9, next)).toBe(true);
  });

  it("allows any other departure from the same way", () => {
    expect(restrictionAllows(rules, ["a"], 5, edge(3, 5, 7, "c"))).toBe(true);
  });

  it("inverts for an only-restriction: everything but the named turn", () => {
    const only = [rule(["a", "b"], { via: 5, only: true })];
    expect(restrictionAllows(only, ["a"], 5, edge(2, 5, 6, "b"))).toBe(true);
    expect(restrictionAllows(only, ["a"], 5, edge(3, 5, 7, "c"))).toBe(false);
  });

  it("reads a no-u-turn as the builder writes it, from and to the same way", () => {
    const uTurn = [rule(["a", "a"], { via: 5, uTurn: true })];
    const back = edge(2, 5, 4, "a");
    // Doubling back: the previous edge arrived from the node this one returns to.
    expect(
      restrictionAllows(uTurn, ["a"], 5, back, edge(1, 4, 5, "a")),
    ).toBe(false);
    // Continuing along the same way is not a u-turn.
    expect(
      restrictionAllows(uTurn, ["a"], 5, back, edge(1, 3, 5, "a")),
    ).toBe(true);
  });
});

describe("buildAdjacency", () => {
  it("indexes every edge by both of its ends in one pass", () => {
    const edges = [edge(1, 1, 2, "a"), edge(2, 2, 3, "b"), edge(3, 1, 3, "c")];
    const { adjacency, reverse } = buildAdjacency(edges);
    expect(adjacency.get(1)?.map((e) => e.id)).toEqual([1, 3]);
    expect(adjacency.get(2)?.map((e) => e.id)).toEqual([2]);
    expect(reverse.get(3)?.map((e) => e.id)).toEqual([2, 3]);
    expect(adjacency.get(3)).toBeUndefined();
    expect(reverse.get(1)).toBeUndefined();
  });
});
