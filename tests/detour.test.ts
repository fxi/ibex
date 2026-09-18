import { describe, expect, it } from "vitest";
import { route, scoreEdge, total } from "../src/routing/engine";
import { eligible } from "../src/routing/eligibility";
import { compileProfile } from "../src/routing/compile";
import { LEVELS } from "../src/routing/vocabulary";
import type { Point } from "../src/routing/types";
import {
  GRAVEL,
  PROFILES,
  SHIPPED,
  voironsGraph,
  withPreferences,
} from "./helpers";

const graph = voironsGraph();

/**
 * Anchor pairs inside the fixture, far enough apart that the network offers a choice.
 * The first is the short Sauget connector that used to be unroutable for the gravel
 * preset; the rest cross the massif.
 */
const pairs: [Point, Point][] = [
  [
    [6.3512921, 46.2272083],
    [6.3530403, 46.2270601],
  ],
  [
    [6.3038953, 46.2491345],
    [6.3351177, 46.2012161],
  ],
  [
    [6.3243159, 46.2482591],
    [6.3620567, 46.2058277],
  ],
  [
    [6.3258498, 46.249117],
    [6.3203358, 46.2016903],
  ],
];

/**
 * How well a line matches what the rider asked for, independent of how far they said
 * they would go for it.
 *
 * Distance alone proves nothing and is not even monotone: opening the detour budget
 * changes the objective, so the router can settle on a route that is both shorter and
 * better liked. What must improve is the line itself. Recovering the preference exponent
 * from the ratio of two budgets isolates exactly that — lower is better liked.
 */
const LOW = withPreferences(GRAVEL, { detour: "strongly_avoid" });
const HIGH = withPreferences(GRAVEL, { detour: "strongly_prefer" });
const SPAN =
  Math.log(compileProfile(HIGH).detour.budget_ratio) -
  Math.log(compileProfile(LOW).detour.budget_ratio);
const byId = new Map(graph.edges.map((e) => [e.id, e]));

function quality(edgeIds: number[]): number {
  let weighted = 0,
    length = 0;
  for (const id of edgeIds) {
    const e = byId.get(id);
    if (!e) continue;
    const exponent =
      Math.log(total(scoreEdge(e, HIGH)) / total(scoreEdge(e, LOW))) / SPAN;
    weighted += exponent * e.length;
    length += e.length;
  }
  return length > 0 ? weighted / length : 0;
}

describe("detour actually detours", () => {
  it("takes a better-liked line as the budget opens, on every pair", () => {
    // The contract. The old model could not do this at all: every reward was a capped
    // discount on the penalties and distance was always charged in full, so the cheapest
    // possible edge still cost its own length and no detour could ever pay for itself.
    let improved = 0;
    for (const [i, anchors] of pairs.entries()) {
      const routes = LEVELS.map((detour) => {
        const r = route(
          graph,
          { profile: withPreferences(GRAVEL, { detour }), anchors },
          "reference",
        );
        expect(r.status, `pair ${i} / ${detour}`).toBe("ok");
        return r.edgeIds;
      });
      const scores = routes.map(quality);
      for (let n = 1; n < scores.length; n++)
        expect(
          scores[n],
          `pair ${i}: ${LEVELS[n]} chose a worse line than ${LEVELS[n - 1]}`,
        ).toBeLessThanOrEqual(scores[n - 1] + 1e-9);
      // A pair whose tightest budget already rides the line the loosest one would has
      // nothing left to buy — traffic avoidance, which is not budgeted, can get it there
      // on its own. Anything else must actually improve.
      if (routes[0].join() === routes.at(-1)!.join()) continue;
      expect(scores.at(-1), `pair ${i} never improved`).toBeLessThan(scores[0]);
      improved++;
    }
    expect(improved, "no pair improved as the budget opened").toBeGreaterThan(0);
  });

  it("spends real distance on it", () => {
    // Modest here on purpose: the fixture is one sparse mountain massif where the network
    // offers few genuine alternatives. The same sweep over the full Geneva release moves
    // 9-20%, well inside the 1.5x budget `prefer` promises.
    const spreads = pairs.map((anchors) => {
      const at = (detour: (typeof LEVELS)[number]) =>
        route(
          graph,
          { profile: withPreferences(GRAVEL, { detour }), anchors },
          "reference",
        ).distanceM;
      return at("strongly_prefer") / at("strongly_avoid");
    });
    expect(Math.max(...spreads)).toBeGreaterThan(1.02);
  });

  it("stays inside the budget it promised", () => {
    for (const [i, anchors] of pairs.entries()) {
      const direct = route(
        graph,
        { profile: LOW, anchors },
        "reference",
      ).distanceM;
      for (const detour of LEVELS) {
        const profile = withPreferences(GRAVEL, { detour });
        const r = route(graph, { profile, anchors }, "reference");
        const budget = compileProfile(profile).detour.budget_ratio;
        expect(
          r.distanceM,
          `pair ${i} / ${detour} exceeded its ${budget}x budget`,
        ).toBeLessThanOrEqual(direct * budget * 1.05);
      }
    }
  });
});

describe("no preference may make a route impossible", () => {
  it("routes every shipped profile between every pair", () => {
    // The shipped set, not the varied fixture set: the guarantee is about what a rider
    // can actually pick, and the default profile was in neither list before.
    for (const profile of [...SHIPPED, ...PROFILES])
      for (const [i, anchors] of pairs.entries()) {
        const r = route(graph, { profile, anchors }, "reference");
        expect(r.status, `${profile.id} / pair ${i}`).toBe("ok");
      }
  });

  it("routes every combination of detour and the three permissions", () => {
    for (const detour of LEVELS)
      for (const ferry of [true, false])
        for (const stairs of [true, false])
          for (const push of [true, false]) {
            const profile = {
              ...withPreferences(GRAVEL, { detour }),
              permissions: { ferry, stairs, push },
            };
            const r = route(graph, { profile, anchors: pairs[1] }, "reference");
            expect(r.status, `${detour} ${ferry}${stairs}${push}`).toBe("ok");
          }
  });

  it("keeps the Menoge bridges flat instead of sampling the ground below", () => {
    // A structure without an explicit incline is flat in the routing model. Reading the
    // DEM below it once made these cut vertices prohibitively expensive.
    const structures = graph.edges.filter(
      (e) =>
        (e.bridge || e.tunnel) &&
        e.grades?.length === 1 &&
        e.grades[0][1] === 0,
    );
    expect(structures.length).toBeGreaterThan(0);
    for (const profile of [...SHIPPED, ...PROFILES])
      expect(
        structures.every((e) => eligible(e, profile)),
        profile.id,
      ).toBe(true);
  });
});
