import { describe, expect, it } from "vitest";
import {
  profileSchema,
  resolveProfile,
  type UserProfile,
} from "../src/routing/profiles";
import { eligible, traversalSegments } from "../src/routing/eligibility";
import { buildField, route, scoreEdge, total } from "../src/routing/engine";
import type { Edge, Graph } from "../src/routing/types";
const profile = (overrides: Partial<UserProfile> = {}): UserProfile => ({
  version: 1,
  name: "Test",
  bike: "gravel",
  ...overrides,
});
const edge = (overrides: Partial<Edge> = {}): Edge => ({
  id: 1,
  from: 0,
  to: 1,
  way: "a",
  length: 1000,
  geometry: [
    [6, 46],
    [6.01, 46],
  ],
  grades: [[1000, 0.08]],
  highway: "track",
  surface: "gravel",
  stress: 0,
  uncertainty: 0,
  utility: 1,
  bridge: false,
  tunnel: false,
  name: "",
  tile: "test",
  ...overrides,
});
const graph = (edges: Edge[]): Graph => ({
  schemaVersion: 1,
  bbox: [5.99, 45.99, 6.02, 46.02],
  nodes: [
    { id: 0, p: [6, 46], elevation: 0 },
    { id: 1, p: [6.01, 46], elevation: 0 },
  ],
  edges,
  restrictions: [],
});
describe("profile resolution", () => {
  it("inherits master and bike defaults while preserving zero, false, and null", () => {
    const p = resolveProfile(
      profile({
        bike: "scenic",
        attraction: { quiet: 0 },
        capabilities: { allow_unknown_paths: false, max_grade_up: null },
        costs: { technical: 0 },
      }),
    );
    expect(p.attraction.quiet).toBe(0);
    expect(p.attraction.scenic).toBe(100);
    expect(p.capabilities.allow_unknown_paths).toBe(false);
    expect(p.capabilities.max_grade_up).toBeNull();
    expect(p.costs.technical).toBe(0);
    expect(p.costs.walking_factor).toBe(5);
    expect(resolveProfile("scenic").capabilities.allow_unknown_paths).toBe(
      true,
    );
  });
  it("rejects typos, unknown versions, invalid types, and out-of-range settings", () => {
    for (const value of [
      profile({ version: 2 as 1 }),
      profile({ attraction: { quiet: 101 } }),
      profile({ capabilities: { max_grade_up: -2 } }),
      { ...profile(), typo: true },
      { ...profile(), attraction: { quet: 20 } },
      { ...profile(), access: { steps: "false" } },
      profile({ costs: { climbing_discount: 1 } }),
    ])
      expect(() => profileSchema.parse(value)).toThrow();
  });
  it("requires updated graph fields when using the new map features", () => {
    for (const p of [
      profile({ attraction: { countryside: 1 } }),
      profile({ attraction: { cycling_network: 1 } }),
      profile({ access: { steps: true } }),
      profile({ access: { ferry: true } }),
    ]) {
      expect(() =>
        buildField(graph([edge()]), {
          profile: p,
          anchors: [
            [6, 46],
            [6.01, 46],
          ],
        }),
      ).toThrow(/updated region/);
      expect(() =>
        buildField(graph([edge({ urban: 0, cyclingNetwork: 0 })]), {
          profile: p,
          anchors: [
            [6, 46],
            [6.01, 46],
          ],
        }),
      ).not.toThrow();
    }
  });
  it("gives bundled names and equivalent JSON identical scores", () => {
    for (const bike of ["gravel", "road", "touring", "scenic"] as const)
      expect(scoreEdge(edge(), profile({ bike }))).toEqual(
        scoreEdge(edge(), bike),
      );
  });
});
describe("directional capability and walking", () => {
  const rider = profile({
    capabilities: {
      max_grade_up: 15,
      max_grade_down: 25,
      max_mtb_scale_up: 0,
      max_mtb_scale_down: 2,
    },
  });
  it("uses grade and technical limits in each travel direction", () => {
    expect(eligible(edge({ grades: [[1000, 0.2]] }), rider)).toBe(false);
    expect(eligible(edge({ grades: [[1000, -0.2]] }), rider)).toBe(true);
    expect(eligible(edge({ tags: { "mtb:scale": "2" } }), rider)).toBe(false);
    expect(
      eligible(
        edge({ tags: { "mtb:scale": "2" }, grades: [[1000, -0.1]] }),
        rider,
      ),
    ).toBe(true);
    expect(
      eligible(
        edge({ tags: { "mtb:scale": "0", "mtb:scale:uphill": "1" } }),
        rider,
      ),
    ).toBe(false);
  });
  it("keeps an unmeasured way rather than deleting it from the graph", () => {
    // Bridges and tunnels are deliberately left unsampled, so a grade limit must not
    // remove them: a handful of unmeasured road bridges are cut vertices for a massif.
    expect(eligible(edge({ grades: null }), rider)).toBe(true);
    expect(
      eligible(
        edge({ grades: null, bridge: true, highway: "residential" }),
        rider,
      ),
    ).toBe(true);
    // Unknown terrain is still priced pessimistically, so it is kept but not preferred.
    const unknown = total(scoreEdge(edge({ grades: null }), rider));
    expect(unknown).toBeGreaterThan(total(scoreEdge(edge(), rider)));
  });
  it("prices and reports only the portions requiring hike-a-bike", () => {
    const p = { ...rider, access: { hike_a_bike: true } };
    const e = edge({
      grades: [
        [400, 0.2],
        [600, -0.1],
      ],
    });
    expect(eligible(e, p)).toBe(true);
    expect(traversalSegments(e, p).map((s) => s.mode)).toEqual([
      "walk",
      "ride",
    ]);
    expect(scoreEdge(e, p).walking).toBe(2000);
    const result = route(
      graph([e]),
      {
        profile: p,
        anchors: [
          [6, 46],
          [6.01, 46],
        ],
      },
      "reference",
    );
    expect(result.status).toBe("ok");
    expect(result.hikeABikeM).toBeCloseTo(400);
  });
  it("does not mistake a hiking classification for bicycle rideability", () => {
    const trail = edge({
      highway: "path",
      surface: "unknown",
      tags: { sac_scale: "hiking" },
    });
    expect(eligible(trail, profile())).toBe(false);
    const walker = profile({ access: { hike_a_bike: true } });
    expect(eligible(trail, walker)).toBe(true);
    expect(traversalSegments(trail, walker)[0].mode).toBe("walk");
  });
  it("checks SAC limits and walking permission independently", () => {
    const p = profile({
      access: { hike_a_bike: true },
      capabilities: {
        max_grade_up: 10,
        max_hike_sac_up: 1,
        max_hike_sac_down: 2,
      },
    });
    expect(
      eligible(
        edge({ grades: [[1000, 0.2]], tags: { sac_scale: "mountain_hiking" } }),
        p,
      ),
    ).toBe(false);
    expect(
      eligible(
        edge({
          grades: [[1000, -0.2]],
          tags: { sac_scale: "mountain_hiking" },
        }),
        p,
      ),
    ).toBe(true);
    expect(
      eligible(edge({ grades: [[1000, 0.2]], tags: { foot: "no" } }), p),
    ).toBe(false);
    expect(
      eligible(
        edge({
          surface: "unknown",
          highway: "path",
          grades: [[1000, 0.2]],
          tags: { "mtb:scale": "0" },
        }),
        p,
      ),
    ).toBe(false);
  });
});
describe("attraction costs", () => {
  it("actively chooses a climb over a flat alternative at strong attraction", () => {
    const uphill = edge({ surface: "asphalt" });
    const flat = edge({
      id: 2,
      way: "flat",
      surface: "asphalt",
      length: 1100,
      grades: [[1100, 0]],
    });
    const request = {
      anchors: [
        [6, 46],
        [6.01, 46],
      ] as [number, number][],
    };
    expect(
      route(
        graph([uphill, flat]),
        { ...request, profile: profile() },
        "reference",
      ).edgeIds,
    ).toEqual([2]);
    expect(
      route(
        graph([uphill, flat]),
        { ...request, profile: profile({ attraction: { climbing: 100 } }) },
        "reference",
      ).edgeIds,
    ).toEqual([1]);
  });
  it("rewards offroad separately uphill and downhill without rewarding asphalt", () => {
    const p = profile({ attraction: { offroad_up: 0, offroad_down: 100 } });
    expect(scoreEdge(edge(), p).offroad).toBe(0);
    expect(
      scoreEdge(edge({ grades: [[1000, -0.08]] }), p).offroad,
    ).toBeLessThan(0);
    expect(
      scoreEdge(edge({ surface: "asphalt", grades: [[1000, -0.08]] }), p)
        .offroad,
    ).toBe(0);
  });
  it("keeps attraction costs additive when a waypoint splits mixed grades", () => {
    const p = profile({
      attraction: {
        climbing: 80,
        scenic: 90,
        offroad_up: 20,
        offroad_down: 85,
      },
    });
    const whole = edge({
      reward: 1,
      grades: [
        [400, 0.2],
        [600, -0.04],
      ],
    });
    const first = {
      ...whole,
      length: 400,
      grades: [[400, 0.2]] as [number, number][],
    };
    const second = {
      ...whole,
      length: 600,
      grades: [[600, -0.04]] as [number, number][],
    };
    expect(total(scoreEdge(whole, p))).toBeCloseTo(
      total(scoreEdge(first, p)) + total(scoreEdge(second, p)),
      8,
    );
  });
  it("continues strengthening scenic preference across its full range", () => {
    const costs = [0, 25, 50, 75, 100].map((scenic) =>
      total(
        scoreEdge(edge({ reward: 1 }), profile({ attraction: { scenic } })),
      ),
    );
    expect(costs.every((cost, i) => i === 0 || cost < costs[i - 1])).toBe(true);
  });
  it("keeps combined maximum attractions finite and strictly positive", () => {
    const p = profile({
      bike: "scenic",
      attraction: {
        quiet: 100,
        climbing: 100,
        scenic: 100,
        offroad_up: 100,
        offroad_down: 100,
      },
    });
    for (const grade of [-0.4, -0.08, 0, 0.08, 0.4]) {
      const c = scoreEdge(
        edge({ stress: 1, reward: 1, grades: [[1000, grade]] }),
        p,
        { point: [6.01, 46], strength: 1, radiusM: 10000 },
      );
      expect(Number.isFinite(total(c))).toBe(true);
      expect(total(c)).toBeGreaterThan(0);
    }
  });
});
