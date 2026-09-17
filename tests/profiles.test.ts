import { describe, expect, it } from "vitest";
import {
  newProfileId,
  parseProfile,
  serializeProfile,
  sameProfile,
} from "../src/routing/profiles";
import { compileProfile } from "../src/routing/compile";
import { eligible, traversalSegments } from "../src/routing/eligibility";
import { route, scoreEdge, total, turnCost } from "../src/routing/engine";
import { SETTING_KEYS, SIGNAL_KEYS } from "../src/routing/vocabulary";
import { matchBike, matchRider, BIKE_PRESETS } from "../src/routing/presets";
import { DEFAULT_PROFILE_ID } from "../src/models";
import type { Edge, Graph, Point } from "../src/routing/types";
import {
  GRAVEL,
  PROFILES,
  ROAD,
  SHIPPED,
  TOURING,
  TRAIL,
  withPermissions,
  withPreferences,
} from "./helpers";

const edge = (overrides: Partial<Edge> = {}): Edge => ({
  id: 1,
  from: 0,
  to: 1,
  way: "1",
  length: 1000,
  geometry: [
    [6.1, 46.1],
    [6.11, 46.1],
  ],
  grades: [[1000, 0]],
  surface: "paved",
  highway: "track",
  stress: 0.1,
  uncertainty: 0.1,
  utility: 0.8,
  urban: 0,
  cyclingNetwork: 0,
  reward: 0.2,
  bridge: false,
  tunnel: false,
  name: "",
  tile: "0",
  ...overrides,
});

describe("the profile format", () => {
  /**
   * What the app ships, named. `gravel_50_bikepacking` was added as `.json` rather than
   * `.profile.json`, so the bundler's glob never saw it and the feature commit shipped
   * nothing for days; `gravel_50_easy_dh` shipped without a doc, a test or a description
   * of its own. Neither was visible to any test, because nothing asserted the set.
   */
  it("ships exactly the profiles the README documents", () => {
    expect(SHIPPED.map((p) => p.name).sort()).toEqual([
      "Gravel",
      "Gravel Bikepacking",
      "MTB",
      "Road",
    ]);
    // Every one is reachable by the id the app pins, and says something of its own.
    expect(new Set(SHIPPED.map((p) => p.id)).size).toBe(SHIPPED.length);
    expect(new Set(SHIPPED.map((p) => p.description)).size).toBe(SHIPPED.length);
    expect(SHIPPED.some((p) => p.id === DEFAULT_PROFILE_ID)).toBe(true);
  });

  it("is complete: every shipped profile parses with nothing inherited", () => {
    for (const p of [...SHIPPED, ...PROFILES]) {
      expect(p.format_version).toBe(3);
      expect(Object.keys(p.settings)).toEqual([...SETTING_KEYS]);
      expect(Object.keys(p.preferences.base).sort()).toEqual(
        [...SIGNAL_KEYS].sort(),
      );
      expect(p.setup.bike.tire_mm).toBeGreaterThan(0);
      expect(p.setup.rider.sustained_w_per_kg).toBeGreaterThan(0);
    }
  });

  it("rejects a partial profile rather than filling the gaps in", () => {
    // This is the whole point of dropping inheritance: a file that does not say what it
    // wants is an incomplete file, not an invitation to guess.
    const { preferences, ...withoutPreferences } = GRAVEL;
    expect(preferences).toBeDefined();
    expect(() => parseProfile(withoutPreferences)).toThrow();
    const partialBase: Record<string, string> = { ...GRAVEL.preferences.base };
    delete partialBase.traffic_stress;
    expect(() =>
      parseProfile({
        ...GRAVEL,
        preferences: { ...GRAVEL.preferences, base: partialBase },
      }),
    ).toThrow();
    expect(() =>
      parseProfile({
        ...GRAVEL,
        settings: { ...GRAVEL.settings, detour: "yes" },
      }),
    ).toThrow();
    // Whole-ride settings cannot be overridden by direction.
    expect(() =>
      parseProfile({
        ...GRAVEL,
        preferences: { ...GRAVEL.preferences, uphill: { detour: "avoid" } },
      }),
    ).toThrow();
    expect(() => parseProfile({ ...GRAVEL, id: "my_gravel" })).toThrow();
    expect(() => parseProfile({ ...GRAVEL, extra: true })).toThrow();
  });

  it("rejects profiles in an older format", () => {
    expect(() => parseProfile({ ...GRAVEL, format_version: 2 })).toThrow();
  });

  it("gives new profiles random ids", () => {
    const a = newProfileId(),
      b = newProfileId();
    expect(a).not.toBe(b);
    expect(() => parseProfile({ ...GRAVEL, id: a })).not.toThrow();
  });

  it("round-trips through its own serializer, key order included", () => {
    const shuffled = JSON.parse(
      JSON.stringify({
        permissions: GRAVEL.permissions,
        preferences: GRAVEL.preferences,
        settings: GRAVEL.settings,
        setup: GRAVEL.setup,
        description: GRAVEL.description,
        name: GRAVEL.name,
        id: GRAVEL.id,
        format_version: GRAVEL.format_version,
      }),
    );
    // Two panels decide "is this track still on that model" by string equality, so a
    // profile written field-for-field in another order has to compare equal.
    expect(serializeProfile(parseProfile(shuffled))).toBe(
      serializeProfile(GRAVEL),
    );
    expect(sameProfile(parseProfile(shuffled), GRAVEL)).toBe(true);
    expect(sameProfile(GRAVEL, ROAD)).toBe(false);
  });

  it("keeps the preset name as a label, never as a lookup", () => {
    expect(matchBike(GRAVEL.setup.bike)).toBe("gravel_40");
    expect(matchRider(GRAVEL.setup.rider)).toBe("expert");
    // Edit one number and the profile stops matching the preset — but it still routes,
    // because nothing ever resolves the name.
    const custom = parseProfile({
      ...GRAVEL,
      setup: {
        ...GRAVEL.setup,
        bike: { ...GRAVEL.setup.bike, tire_mm: 43 },
      },
    });
    expect(matchBike(custom.setup.bike)).toBe("custom");
    expect(
      compileProfile(custom).capability.uphill_grade.comfortable_until,
    ).toBeGreaterThan(0);
  });

  it("freezes what it parses", () => {
    expect(Object.isFrozen(GRAVEL)).toBe(true);
    expect(Object.isFrozen(GRAVEL.preferences)).toBe(true);
    expect(Object.isFrozen(GRAVEL.setup.bike)).toBe(true);
  });
});

describe("preferences reach the cost", () => {
  it("moves cost in the direction the word says, for every signal", () => {
    const cases: [string, Partial<Edge>][] = [
      ["traffic_stress", { stress: 0.9 }],
      ["surface_difficulty", { surface: "gravel" }],
      ["urbanity", { urban: 1 }],
      // Scale 2 is still ridden; past a rider capability it becomes walking, and then
      // it is the push cost talking rather than the preference.
      [
        "surface_difficulty",
        { highway: "path", tags: { "mtb:scale": "2" } },
      ],
    ];
    for (const [key, overrides] of cases) {
      const e = edge(overrides);
      const avoid = total(
        scoreEdge(e, withPreferences(GRAVEL, { [key]: "strongly_avoid" })),
      );
      const prefer = total(
        scoreEdge(e, withPreferences(GRAVEL, { [key]: "strongly_prefer" })),
      );
      expect(avoid, key).toBeGreaterThan(prefer);
    }
  });

  it("lets a liked way cost less than its own length", () => {
    // The old model charged full distance and only ever discounted the penalties on top,
    // so nothing could ever come in under 1.0 and no detour could pay for itself.
    const lovely = edge({
      stress: 0.02,
      surface: "compacted",
      urban: 0,
      reward: 0.95,
      cyclingNetwork: 1,
      uncertainty: 0,
      utility: 1,
    });
    const rate = total(scoreEdge(lovely, GRAVEL)) / lovely.length;
    expect(rate).toBeLessThan(1);
    expect(rate).toBeGreaterThan(0);
  });

  it("never prices a busy road below a quiet one, however many defects it lacks", () => {
    // The regression that prompted this rule. A smooth paved main road is *perfect* on
    // "avoid unpaved", "avoid roughness" and "avoid technicality" all at once, and when
    // those credits counted in full they buried the traffic penalty it had honestly
    // earned: a stress-0.95 departmental road with lorries on it priced at 0.68 — below
    // its own length — against 0.67 for a signed cycle route one field away.
    const road = withPreferences(GRAVEL, {
      detour: "strongly_prefer",
      traffic_stress: "strongly_avoid",
      unpaved: "strongly_avoid",
      surface_difficulty: "strongly_avoid",
      scenic: "neutral",
      urbanity: "neutral",
      cycle_infrastructure: "prefer",
    });
    const trunk = edge({
      highway: "primary",
      surface: "paved",
      stress: 0.95,
      cyclingNetwork: 0,
      tags: { smoothness: "excellent" },
    });
    const signed = edge({
      highway: "tertiary",
      surface: "paved",
      stress: 0.55,
      cyclingNetwork: 1,
      tags: { smoothness: "good" },
    });
    const rate = (e: Edge) => total(scoreEdge(e, road)) / e.length;
    expect(rate(trunk)).toBeGreaterThan(1);
    expect(rate(trunk)).toBeGreaterThan(rate(signed) * 1.3);
  });

  it("keeps a rider who strongly avoids traffic off a primary road, whatever the budget", () => {
    // Machilly: route 23 runs along Route de Léman and Route de Couty, a signed tertiary,
    // beside 1.1 km of Route du Pays de la Côte. With traffic `strongly_avoid` and
    // network `strongly_prefer`, the primary still won — the preference factor is capped
    // by the detour budget, so it priced at 1.99 against 1.01 and the extra kilometre of
    // the signed line was not worth it. The hazard now sits outside that cap.
    const rider = withPreferences(ROAD, {
      detour: "strongly_prefer",
      traffic_stress: "strongly_avoid",
      cycle_infrastructure: "strongly_prefer",
    });
    const primary = edge({
      highway: "primary",
      surface: "paved",
      stress: 0.95,
      cyclingNetwork: 0,
      tags: { smoothness: "excellent" },
    });
    const signed = edge({
      highway: "tertiary",
      surface: "paved",
      stress: 0.55,
      cyclingNetwork: 1,
      tags: { smoothness: "good" },
    });
    const rate = (e: Edge, p = rider) => total(scoreEdge(e, p)) / e.length;
    const budget = compileProfile(rider).detour.budget_ratio;
    expect(scoreEdge(primary, rider).traffic).toBeGreaterThan(0);
    expect(rate(primary)).toBeGreaterThan(rate(signed) * budget * 1.25);

    const indifferent = withPreferences(rider, { traffic_stress: "neutral" });
    expect(scoreEdge(primary, indifferent).traffic).toBe(0);
    expect(scoreEdge(signed, rider).traffic).toBeLessThan(
      scoreEdge(primary, rider).traffic / 3,
    );
  });

  it("never produces a zero or negative cost, whatever is stacked on it", () => {
    const lovely = edge({
      stress: 0,
      surface: "compacted",
      urban: 0,
      reward: 1,
      cyclingNetwork: 1,
      uncertainty: 0,
      utility: 1,
    });
    for (const p of PROFILES)
      for (const strength of [0, 0.5, 1, 10])
        expect(
          total(
            scoreEdge(lovely, p, {
              point: [6.105, 46.1],
              radiusM: 9000,
              strength,
            }),
          ),
        ).toBeGreaterThan(0);
  });

  it("splits an edge's cost by grade run, so a waypoint cannot change it", () => {
    const whole = edge({
      grades: [
        [500, 0.12],
        [500, -0.04],
      ],
    });
    const first = edge({ length: 500, grades: [[500, 0.12]] });
    const second = edge({ length: 500, grades: [[500, -0.04]] });
    const joined =
      total(scoreEdge(first, GRAVEL)) + total(scoreEdge(second, GRAVEL));
    // Junctions are per-event, so drop that one term from the comparison.
    expect(total(scoreEdge(whole, GRAVEL))).toBeCloseTo(joined, 6);
  });

  it("reports parts that sum to the whole", () => {
    for (const p of PROFILES) {
      const c = scoreEdge(
        edge({ surface: "gravel", grades: [[1000, 0.25]] }),
        p,
      );
      const parts =
        c.base +
        c.preference +
        c.slope +
        c.technical +
        c.roughness +
        c.uncertainty +
        c.network +
        c.junction +
        c.walking +
        c.ferry +
        c.attraction +
        c.clamp;
      expect(parts).toBeCloseTo(total(c), 6);
    }
  });
});

describe("direction changes", () => {
  // A plus-shaped intersection at node 1, with a second route around it via node 5.
  const points: Point[] = [
    [6.1, 46.1],
    [6.11, 46.1],
    [6.12, 46.1],
    [6.11, 46.11],
    [6.11, 46.09],
    [6.1, 46.11],
  ];
  const link = (id: number, from: number, to: number): Edge =>
    edge({
      id,
      from,
      to,
      way: String(id),
      highway: "residential",
      length: Math.hypot(
        (points[from][0] - points[to][0]) * 77000,
        (points[from][1] - points[to][1]) * 111000,
      ),
      geometry: [points[from], points[to]],
      grades: null,
    });
  const turning = withPreferences(GRAVEL, {
    direction_changes: "strongly_avoid",
  });

  it("is free straight on and at a plain way split, and never a reward", () => {
    const west = link(0, 0, 1),
      east = link(1, 1, 2),
      north = link(2, 1, 3);
    const p = compileProfile(turning);
    expect(turnCost(west, east, p, 4)).toBeCloseTo(0, 6);
    expect(turnCost(west, north, p, 4)).toBeGreaterThan(0);
    expect(turnCost(west, north, p, 2)).toBe(0);
    for (const level of ["neutral", "prefer", "strongly_prefer"] as const)
      expect(
        turnCost(
          west,
          north,
          compileProfile(withPreferences(GRAVEL, { direction_changes: level })),
          4,
        ),
      ).toBe(0);
    // A U-turn costs the most.
    expect(turnCost(west, link(3, 1, 0), p, 4)).toBeGreaterThan(
      turnCost(west, north, p, 4),
    );
  });

  it("prices the same turns in the search and in the reported route", () => {
    const g: Graph = {
      schemaVersion: 1,
      bbox: [5.8, 45.95, 6.55, 46.45],
      nodes: points.map((p, id) => ({ id, p, elevation: 0 })),
      restrictions: [],
      edges: [
        link(0, 0, 1),
        link(1, 1, 2),
        link(2, 1, 3),
        link(3, 1, 4),
        link(4, 0, 5),
        link(5, 5, 3),
      ],
    };
    for (const profile of [GRAVEL, turning]) {
      const r = route(
        g,
        { anchors: [points[0], points[3]], profile },
        "reference",
      );
      expect(r.status).toBe("ok");
      expect(r.cost).toBeCloseTo(total(r.components), 3);
    }
  });
});

describe("capability replaces exclusion", () => {
  it("prices steep and technical ground instead of deleting it", () => {
    const brutal = edge({
      highway: "path",
      surface: "ground",
      grades: [[1000, 0.4]],
      tags: { "mtb:scale": "5", sac_scale: "alpine_hiking" },
    });
    for (const p of PROFILES) {
      expect(eligible(brutal, p), p.id).toBe(true);
      expect(total(scoreEdge(brutal, p))).toBeGreaterThan(brutal.length * 3);
    }
    // And it is still worse for the rider less equipped for it.
    expect(total(scoreEdge(brutal, ROAD))).toBeGreaterThan(
      total(scoreEdge(brutal, TRAIL)),
    );
  });

  it("never treats a missing grade as impassable", () => {
    // Bridges and tunnels are left unsampled on purpose; three of them once stranded a
    // whole massif from every profile that set a grade limit.
    const bridge = edge({ grades: null, bridge: true });
    for (const p of PROFILES) expect(eligible(bridge, p), p.id).toBe(true);
  });

  it("still excludes what the law excludes", () => {
    expect(eligible(edge({ tags: { bicycle: "no" } }), TRAIL)).toBe(false);
    expect(eligible(edge({ tags: { access: "private" } }), TRAIL)).toBe(false);
    expect(eligible(edge({ highway: "motorway" }), TRAIL)).toBe(false);
    expect(eligible(edge({ tags: { smoothness: "impassable" } }), TRAIL)).toBe(
      false,
    );
  });

  it("walks a gradient past what the lowest gear can turn", () => {
    const wall = edge({ highway: "track", grades: [[1000, 0.45]] });
    const modes = traversalSegments(wall, TOURING).map((s) => s.mode);
    expect(modes).toContain("walk");
    // Lower gearing on the same hill keeps the rider pedalling for longer.
    const geared = parseProfile({
      ...TOURING,
      setup: { ...TOURING.setup, bike: { ...BIKE_PRESETS.mtb_60 } },
    });
    const up = compileProfile(geared).capability.uphill_grade.high_cost_at;
    expect(up).toBeGreaterThan(
      compileProfile(TOURING).capability.uphill_grade.high_cost_at,
    );
  });

  it("makes refusing to push expensive, not impossible", () => {
    const wall = edge({ highway: "track", grades: [[1000, 0.45]] });
    const willing = withPermissions(GRAVEL, { push: true });
    const unwilling = withPermissions(GRAVEL, { push: false });
    expect(eligible(wall, unwilling)).toBe(true);
    expect(total(scoreEdge(wall, unwilling))).toBeGreaterThan(
      total(scoreEdge(wall, willing)),
    );
  });

  it("blocks only where the law says a rider may not walk", () => {
    const wall = edge({
      highway: "path",
      grades: [[1000, 0.45]],
      tags: { foot: "no" },
    });
    expect(eligible(wall, GRAVEL)).toBe(false);
  });
});
