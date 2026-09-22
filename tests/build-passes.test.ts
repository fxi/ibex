/**
 * The three bounded passes.
 *
 * Each was checked against `build_region.py` over generated graphs of 50, 400 and 1,500
 * edges with identical results; these assert the properties that make them mean something,
 * which is what would catch a later change that still agrees with itself.
 */
import { describe, expect, it } from "vitest";
import {
  junctionSeverity,
  networkUtility,
  rewardPotential,
  type PassEdge,
} from "../src/build/passes";
import { Surface, type BBox } from "../src/build/surface";

const edge = (from: number, to: number, over: Partial<PassEdge> = {}): PassEdge => ({
  way: `w${Math.min(from, to)}`,
  from,
  to,
  length: 100,
  stress: 0.1,
  highway: "cycleway",
  quality: 0,
  forest: 0,
  geometry: [
    [6.0 + from * 0.001, 46.0],
    [6.0 + to * 0.001, 46.0],
  ],
  ...over,
});

/** A chain 0-1-2-…-n, rideable both ways. */
const chain = (n: number, over: Partial<PassEdge> = {}): PassEdge[] =>
  Array.from({ length: n }, (_, i) => [
    edge(i, i + 1, { ...over, way: `w${i}` }),
    edge(i + 1, i, { ...over, way: `w${i}` }),
  ]).flat();

describe("networkUtility", () => {
  it("scores a node in a long low-stress chain above one on a stub", () => {
    const long = networkUtility(chain(20), [0]);
    const stub = networkUtility(chain(1), [0]);
    expect(long.get(0)!).toBeGreaterThan(stub.get(0)!);
  });

  it("counts a segment once however many directions carry it", () => {
    const both = networkUtility(chain(5), [0]);
    const oneWay = networkUtility(
      Array.from({ length: 5 }, (_, i) => edge(i, i + 1, { way: `w${i}` })),
      [0],
    );
    expect(both.get(0)).toBe(oneWay.get(0));
  });

  it("ignores stressful roads, steps and ferries", () => {
    expect(networkUtility(chain(20, { stress: 0.9 }), [0]).get(0)).toBe(0);
    expect(networkUtility(chain(20, { highway: "steps" }), [0]).get(0)).toBe(0);
    expect(networkUtility(chain(20, { highway: "ferry" }), [0]).get(0)).toBe(0);
  });

  it("stops counting at a kilometre", () => {
    // Beyond 1 km the chain adds nothing, so a longer one scores the same.
    const ten = networkUtility(chain(10), [0]).get(0)!;
    const forty = networkUtility(chain(40), [0]).get(0)!;
    expect(forty).toBe(ten);
  });
});

describe("junctionSeverity", () => {
  it("is nothing where nothing converges", () => {
    // A node with one edge each way is a continuation, not a junction.
    expect(junctionSeverity(chain(2), [1]).get(1)).toBe(0);
  });

  it("grows with the number of ways meeting", () => {
    const meeting = (n: number) =>
      Array.from({ length: n }, (_, i) => [
        edge(100 + i, 0, { highway: "primary", way: `w${i}` }),
        edge(0, 100 + i, { highway: "primary", way: `w${i}` }),
      ]).flat();
    const three = junctionSeverity(meeting(3), [0]).get(0)!;
    const six = junctionSeverity(meeting(6), [0]).get(0)!;
    expect(six).toBeGreaterThan(three);
    expect(six).toBeLessThanOrEqual(1);
  });

  it("weighs the busiest road class meeting there", () => {
    const busy = [
      ...chain(1, { highway: "primary" }),
      ...chain(1, { highway: "primary" }).map((e) => ({ ...e, way: "w9" })),
    ];
    const quiet = busy.map((e) => ({ ...e, highway: "cycleway" }));
    expect(junctionSeverity(busy, [1]).get(1)!).toBeGreaterThan(
      junctionSeverity(quiet, [1]).get(1)!,
    );
  });
});

describe("rewardPotential", () => {
  it("seeds from golden gravel and from forest, and decays with distance", () => {
    const edges = chain(10);
    edges[0] = { ...edges[0], quality: 0.9 };
    const reward = rewardPotential(edges, undefined);
    expect(reward.get(0)!).toBeGreaterThan(0.6);
    // Further along the chain the pull fades.
    expect(reward.get(5)!).toBeLessThan(reward.get(1)!);
    expect(reward.get(1)!).toBeLessThanOrEqual(reward.get(0)!);
  });

  it("treats deep forest as a source in its own right", () => {
    const edges = chain(10);
    edges[0] = { ...edges[0], forest: 0.8 };
    expect(rewardPotential(edges, undefined).get(0)!).toBeGreaterThan(0.4);
    // Below the threshold it is not a source at all.
    const shallow = chain(10);
    shallow[0] = { ...shallow[0], forest: 0.5 };
    expect(rewardPotential(shallow, undefined).size).toBe(0);
  });

  it("reaches nothing beyond the horizon", () => {
    const edges = chain(40, { length: 500 });
    edges[0] = { ...edges[0], quality: 0.9 };
    const reward = rewardPotential(edges, undefined);
    // 600 * ln(50) is about 2,347 m, so a node 20 km along is out of reach.
    expect(reward.has(40)).toBe(false);
  });

  it("draws on an attraction surface where one is given", () => {
    const bbox: BBox = [5.99, 45.99, 6.05, 46.01];
    const attraction = new Surface(bbox, 10);
    attraction.stamp([6.0, 46.0], 60, 1.0, "max");
    const withPull = rewardPotential(chain(5), attraction);
    const without = rewardPotential(chain(5), undefined);
    expect(withPull.get(0)!).toBeGreaterThan(0);
    expect(without.size).toBe(0);
  });

  it("propagates against the direction of travel, not with it", () => {
    // A one-way chain 0 -> 1 -> 2 with the reward at 2: riders upstream should feel it.
    const oneWay = [edge(0, 1, { way: "a" }), edge(1, 2, { way: "b", quality: 0.9 })];
    const reward = rewardPotential(oneWay, undefined);
    expect(reward.get(0)).toBeDefined();
    expect(reward.get(0)!).toBeLessThan(reward.get(1)!);
  });
});
