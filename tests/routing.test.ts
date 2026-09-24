import { describe, expect, it } from "vitest";
import {
  GRAVEL,
  ROAD,
  SHIPPED,
  TOURING,
  TRAIL,
  withPreferences,
} from "./helpers";
import {
  distance,
  Heap,
  route,
  scoreEdge,
  snapAnchors,
  total,
} from "../src/routing/engine";
import { eligible } from "../src/routing/eligibility";
import { compileProfile } from "../src/routing/compile";
import { ENGINE } from "../src/routing/vocabulary";
import { exportGPX } from "../src/gpx";
import type { Edge, Graph, Point } from "../src/routing/types";
import type { Level } from "../src/routing/vocabulary";
import type { Profile } from "../src/routing/profiles";
function fixture(
  points: Point[],
  links: [number, number, string?, Partial<Edge>?][],
): Graph {
  const nodes = points.map((p, id) => ({ id, p, elevation: 0 }));
  return {
    schemaVersion: 1,
    bbox: [5.8, 45.95, 6.55, 46.45],
    nodes,
    restrictions: [],
    edges: links.map(([from, to, way, overrides], id) => ({
      id,
      from,
      to,
      way: way ?? String(id),
      length: distance(points[from], points[to]),
      geometry: [points[from], points[to]],
      grades: [[distance(points[from], points[to]), 0]],
      surface: "paved",
      highway: "cycleway",
      stress: 0.1,
      uncertainty: 0.1,
      utility: 0.5,
      urban: 0,
      cyclingNetwork: 0,
      reward: 0,
      bridge: false,
      tunnel: false,
      name: "",
      tile: String(from),
      ...overrides,
    })),
  };
}
const p: Point[] = [
  [6.1, 46.1],
  [6.11, 46.1],
  [6.12, 46.1],
  [6.11, 46.11],
];
describe("routing invariants", () => {
  it("expands a misleading corridor to reach a distant crossing", () => {
    const points: Point[] = [
      [6.1, 46.1],
      [6.11, 46.15],
      [6.12, 46.1],
    ];
    const g = fixture(points, [
      [0, 1],
      [1, 2],
    ]);
    const width = 100,
      height = 100;
    const index = (point: Point) =>
      Math.floor(((point[1] - g.bbox[1]) / (g.bbox[3] - g.bbox[1])) * height) *
        width +
      Math.floor(((point[0] - g.bbox[0]) / (g.bbox[2] - g.bbox[0])) * width);
    const a = index(points[0]),
      b = index(points[2]);
    const f = {
      width,
      height,
      cellM: 600,
      bbox: g.bbox,
      costs: Array(width * height).fill(1),
      paths: [Array.from({ length: b - a + 1 }, (_, i) => a + i)],
    };
    // The crossing sits 10 cells off the straight line. A rider who prefers detours opens
    // a corridor that wide from the start, so pin a narrower one: this is about expansion.
    const result = route(
      g,
      {
        anchors: [points[0], points[2]],
        profile: withPreferences(GRAVEL, { detour: "neutral" }),
      },
      "corridor",
      f,
    );
    expect(result.status).toBe("ok");
    expect(result.metrics.expansions).toBeGreaterThan(0);
  });
  it("does not connect crossing geometries", () => {
    const g = fixture(
      [
        [6.1, 46.1],
        [6.12, 46.12],
        [6.1, 46.12],
        [6.12, 46.1],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    );
    expect(
      route(
        g,
        { anchors: [g.nodes[0].p, g.nodes[3].p], profile: GRAVEL },
        "reference",
      ).status,
    ).toBe("no-path");
  });
  it("honors directed edges and reports coverage separately", () => {
    const g = fixture(p, [
      [0, 1],
      [1, 2],
    ]);
    expect(
      route(g, { anchors: [p[2], p[0]], profile: ROAD }, "reference").status,
    ).toBe("no-path");
    expect(
      route(g, { anchors: [p[0], [7, 47]], profile: ROAD }, "reference").status,
    ).toBe("outside-coverage");
  });
  it("routes through a valid tile boundary", () => {
    const g = fixture(p, [
      [0, 1],
      [1, 2],
    ]);
    const r = route(g, { anchors: [p[0], p[2]], profile: GRAVEL }, "corridor");
    expect(r.status).toBe("ok");
    expect(r.metrics.tiles).toBe(2);
  });
  it("splits a bidirectional edge without allowing reverse on a one-way", () => {
    const g = fixture(p, [
      [0, 2, "road"],
      [2, 0, "road"],
    ]);
    const snapped = snapAnchors(g, [
      [6.105, 46.1],
      [6.115, 46.1],
    ])!;
    expect(snapped.graph.nodes.length).toBe(6);
    expect(
      route(
        g,
        {
          anchors: [
            [6.115, 46.1],
            [6.105, 46.1],
          ],
          profile: ROAD,
        },
        "reference",
      ).status,
    ).toBe("ok");
    const one = fixture(p, [[0, 2, "road"]]);
    expect(
      route(
        one,
        {
          anchors: [
            [6.115, 46.1],
            [6.105, 46.1],
          ],
          profile: ROAD,
        },
        "reference",
      ).status,
    ).toBe("no-path");
  });
  it("preserves no-turn restrictions across hard waypoints", () => {
    const g = fixture(p, [
      [0, 1, "a"],
      [1, 2, "b"],
      [1, 3, "c"],
      [3, 2, "d"],
    ]);
    g.restrictions = [{ ways: ["a", "b"], via: 1, only: false }];
    const r = route(
      g,
      { anchors: [p[0], p[1], p[2]], profile: ROAD },
      "reference",
    );
    expect(r.status).toBe("ok");
    expect(r.edgeIds).toEqual([0, 2, 3]);
  });
  it("enforces via-way restrictions after traversing the via way", () => {
    const g = fixture(
      [...p, [6.115, 46.105]],
      [
        [0, 1, "a"],
        [1, 4, "via"],
        [4, 2, "via"],
        [2, 3, "b"],
      ],
    );
    g.restrictions = [{ ways: ["a", "via", "b"], only: false }];
    expect(
      route(g, { anchors: [p[0], p[3]], profile: GRAVEL }, "reference").status,
    ).toBe("no-path");
  });
  it("allows continued travel within an only-turn via way", () => {
    const g = fixture(
      [...p, [6.115, 46.105]],
      [
        [0, 1, "a"],
        [1, 4, "via"],
        [4, 2, "via"],
        [2, 3, "b"],
      ],
    );
    g.restrictions = [{ ways: ["a", "via", "b"], only: true }];
    expect(
      route(g, { anchors: [p[0], p[3]], profile: GRAVEL }, "reference").status,
    ).toBe("ok");
  });
  it("does not reinterpret no_u_turn as a ban on straight travel", () => {
    const g = fixture(p, [
      [0, 1, "a"],
      [1, 0, "a"],
      [1, 2, "a"],
    ]);
    g.restrictions = [{ ways: ["a", "a"], via: 1, only: false, uTurn: true }];
    expect(
      route(g, { anchors: [p[0], p[2]], profile: ROAD }, "reference").status,
    ).toBe("ok");
  });
  it("never makes an attraction cost negative", () => {
    const e = fixture(p, [[0, 1]]).edges[0];
    for (const strength of [0, 0.5, 1, 10])
      expect(
        total(scoreEdge(e, GRAVEL, { point: p[1], radiusM: 10000, strength })),
      ).toBeGreaterThan(0);
  });
  it("scores uphill and downhill differently; keeps missing elevation unknown", () => {
    const g = fixture(p, [
      [0, 1],
      [1, 0],
    ]);
    g.edges[0].grades = [[1000, 0.1]];
    g.edges[1].grades = [[1000, -0.1]];
    expect(scoreEdge(g.edges[0], TOURING).slope).toBeGreaterThan(
      scoreEdge(g.edges[1], TOURING).slope,
    );
    g.edges[0].grades = null;
    expect(
      route(g, { anchors: [p[0], p[1]], profile: ROAD }, "reference").ascentM,
    ).toBeNull();
  });
  it("prefers a flat valley detour to a steep ridge shortcut (spec §32 golden test)", () => {
    const points: Point[] = [
      [6.1, 46.1],
      [6.12, 46.1],
      [6.11, 46.101],
    ];
    const g = fixture(points, [
      [0, 1, "ridge"],
      [0, 2, "valleyA"],
      [2, 1, "valleyB"],
    ]);
    g.edges[0].length = 1000;
    g.edges[0].grades = [[1000, 0.1]];
    g.edges[1].length = 700;
    g.edges[1].grades = [[700, 0]];
    g.edges[2].length = 700;
    g.edges[2].grades = [[700, 0]];
    for (const profile of [ROAD, GRAVEL, TOURING]) {
      const r = route(
        g,
        { anchors: [points[0], points[1]], profile },
        "reference",
      );
      expect(r.status).toBe("ok");
      expect(r.edgeIds).toEqual([1, 2]);
      expect(r.distanceM).toBeCloseTo(1400, 0);
    }
  });
  it("prices how the height is gained, not only how much of it", () => {
    const base = fixture(p, [[0, 1]]).edges[0];
    // The same 150 m of height, gained at 15% and at 7%.
    const climb = (profile: Profile, grade: number) => {
      const length = 150 / grade;
      return scoreEdge(
        { ...base, length, grades: [[length, grade]] as [number, number][] },
        profile,
      );
    };
    for (const profile of SHIPPED) {
      // `climb_effort` is charged per metre of height, so it is identical on the two and
      // cancels. Road and MTB ship `direction_changes: neutral`, which switched the old
      // `flowCost` off entirely, so before `steepness` they charged the 15% ramp and the
      // 7% road exactly the same and the shorter one always won.
      expect(climb(profile, 0.15).slope).toBeGreaterThan(
        climb(profile, 0.07).slope,
      );
      // Which of the two a rider is sent up also depends on what they think of the ground
      // — a profile gets a surface it dislikes over with quickly — so what is pinned here
      // is that the knob moves the choice, monotonically, in the direction the word says.
      const margin = (steepness: Level) => {
        const q = withPreferences(profile, { steepness });
        return total(climb(q, 0.15)) - total(climb(q, 0.07));
      };
      expect(margin("strongly_avoid")).toBeGreaterThan(margin("avoid"));
      expect(margin("avoid")).toBeGreaterThan(margin("neutral"));
      expect(margin("neutral")).toBeGreaterThan(margin("strongly_prefer"));
    }
  });
  it("credits height and gradient a rider prefers, and nothing a rider avoids", () => {
    const base = fixture(p, [[0, 1]]).edges[0];
    const run = (profile: Profile, grade: number) =>
      total(
        scoreEdge(
          {
            ...base,
            length: 1000,
            grades: [[1000, grade]] as [number, number][],
          },
          profile,
        ),
      );
    for (const profile of SHIPPED) {
      const at = (climbing: Level, steepness: Level = "neutral") =>
        withPreferences(profile, { climbing, steepness });
      // Before, `strongly_prefer` only discounted the effort: still a cost, so Geneva →
      // Grenoble took the same 1330 m of ascent at every level.
      expect(run(at("strongly_prefer"), 0.06)).toBeLessThan(
        run(at("neutral"), 0.06),
      );
      // Down as well: every extra metre climbed is descended again.
      expect(run(at("strongly_prefer"), -0.06)).toBeLessThan(
        run(at("neutral"), -0.06),
      );
      // Flat ground is neither.
      expect(run(at("strongly_prefer"), 0)).toBeCloseTo(
        run(at("neutral"), 0),
        6,
      );
      expect(run(at("neutral", "strongly_prefer"), 0)).toBeCloseTo(
        run(at("neutral"), 0),
        6,
      );
      expect(run(at("neutral", "strongly_prefer"), 0.14)).toBeLessThan(
        run(at("neutral"), 0.14),
      );
      // Avoiding either only scales the physical cost, as it always did.
      expect(
        compileProfile(at("strongly_avoid", "strongly_avoid")),
      ).toMatchObject({
        climbCredit: 0,
        steepCredit: { uphill: 0, downhill: 0 },
      });
    }
  });
  it("goes over the ridge for a rider who prefers climbing", () => {
    const points: Point[] = [
      [6, 46],
      [6.012, 46],
      [6.006, 45.996],
    ];
    const g = fixture(points, [
      [0, 1, "ridge"],
      [0, 2, "valleyA"],
      [2, 1, "valleyB"],
    ]);
    // A 2 km way over a hill (up and down again) against 1.4 km of flat valley road.
    g.edges[0].length = 2000;
    g.edges[0].grades = [
      [1000, 0.06],
      [1000, -0.06],
    ];
    g.edges[1].length = 700;
    g.edges[1].grades = [[700, 0]];
    g.edges[2].length = 700;
    g.edges[2].grades = [[700, 0]];
    const via = (climbing: Level) =>
      route(
        g,
        {
          anchors: [points[0], points[1]],
          profile: withPreferences(GRAVEL, {
            climbing,
            detour: "strongly_prefer",
          }),
        },
        "reference",
      ).edgeIds;
    expect(via("neutral")).toEqual([1, 2]);
    expect(via("strongly_prefer")).toEqual([0]);
  });
  it("prices grade non-linearly, and only past what the rider is comfortable with", () => {
    const grade = (g: number): [number, number][] => [[1000, g]];
    const base = fixture(p, [[0, 1]]).edges[0];
    for (const profile of [ROAD, GRAVEL, TOURING]) {
      const at = (g: number) =>
        scoreEdge({ ...base, length: 1000, grades: grade(g) }, profile).slope /
        1000;
      const comfortable =
        compileProfile(profile).capability.uphill_grade.comfortable_until;
      const band = ENGINE.flow_band * comfortable;
      // Climbing always costs something — lifting the bike takes energy whether or not
      // the gradient is comfortable — and inside the momentum band that cost is purely
      // linear, because it is `climb_effort` alone, charged per metre of height.
      const easy = at(band * 0.4),
        easier = at(band * 0.8);
      expect(easy).toBeGreaterThan(0);
      expect(easier / easy).toBeCloseTo(2, 1);
      // Leaving the band kinks it, which is the whole point of `steepnessCost`: past here
      // *how* the height is gained matters as well as how much, so the same step up in
      // gradient costs several times what it cost inside. Purely linear all the way to
      // comfort — what this test asserted before — is what let a 15% ramp cost the same
      // as the 7% road beside it.
      const inside = at(band * 0.9) - at(band * 0.5);
      const outside = at(band * 1.4) - at(band * 1.0);
      expect(outside).toBeGreaterThan(inside * 3);
      // Past it the ramp is quartic, so each step up costs far more than the last.
      const a = at(comfortable * 1.3),
        b = at(comfortable * 1.6),
        c = at(comfortable * 1.9);
      expect(a).toBeGreaterThan(0);
      expect(b - a).toBeGreaterThan(0);
      expect(c - b).toBeGreaterThan(b - a);
    }
  });
  it("makes road and gravel profiles respond differently to surface", () => {
    const e: Edge = { ...fixture(p, [[0, 1]]).edges[0], surface: "gravel" };
    // A road bike pays for the surface in two ways: it is past what 28 mm tires are
    // comfortable on, and the profile asked to avoid unpaved ground in the first place.
    expect(scoreEdge(e, ROAD).roughness).toBeGreaterThan(
      scoreEdge(e, GRAVEL).roughness,
    );
    expect(total(scoreEdge(e, ROAD))).toBeGreaterThan(
      total(scoreEdge(e, GRAVEL)),
    );
  });
  it("reports budget exhaustion rather than no path", () => {
    const g = fixture(p, [
      [0, 1],
      [1, 2],
    ]);
    expect(
      route(
        g,
        { anchors: [p[0], p[2]], profile: ROAD, maxSettled: 1 },
        "reference",
      ).status,
    ).toBe("budget-exceeded");
  });
  it("exports valid track coordinates with no fabricated altitude", () => {
    const known = exportGPX(
      route(
        fixture(p, [[0, 1]]),
        { anchors: [p[0], p[1]], profile: ROAD },
        "reference",
      ),
      "Named route",
    );
    expect(known).toContain('lat="46.1" lon="6.1"');
    expect(known).toContain("<name>Named route</name>");
    // The fixture's nodes sit at a real elevation of 0, so exporting it is not invention.
    expect(known).toContain("<ele>0.0</ele>");

    // Without grades the engine reports null heights, and none may be written.
    const unknown = exportGPX(
      route(
        fixture(p, [[0, 1, undefined, { grades: null }]]),
        { anchors: [p[0], p[1]], profile: ROAD },
        "reference",
      ),
    );
    expect(unknown).toContain('lat="46.1" lon="6.1"');
    expect(unknown).not.toContain("<ele>");
  });
  it("orders a priority queue correctly", () => {
    const heap = new Heap<number>();
    for (const n of [4, 1, 9, 0, 2]) heap.push(n, n);
    expect(Array.from({ length: 5 }, () => heap.pop()!.value)).toEqual([
      0, 1, 2, 4, 9,
    ]);
  });
});

describe("scenic profile: lookahead, asymmetric MTB cost, reward/junction", () => {
  const technicalUphill = (reward: number): Edge =>
    fixture(p, [
      [
        0,
        1,
        "a",
        {
          tags: { "mtb:scale:uphill": "2", "mtb:scale:downhill": "2" },
          grades: [[1000, 0.1]],
          reward,
        },
      ],
    ]).edges[0];

  it("makes a technical section cheaper when a reward is reachable ahead", () => {
    expect(total(scoreEdge(technicalUphill(1), TRAIL))).toBeLessThan(
      total(scoreEdge(technicalUphill(0), TRAIL)),
    );
  });

  it("lets a rewarded technical-but-shorter path beat a longer flat detour, only for scenic", () => {
    const points: Point[] = [
      [6.1, 46.1],
      [6.12, 46.1],
      [6.11, 46.101],
    ];
    const build = () => {
      const g = fixture(points, [
        [0, 1, "technical"],
        [0, 2, "detourA"],
        [2, 1, "detourB"],
      ]);
      g.edges[0].length = 100;
      g.edges[0].grades = [[100, 0.1]];
      // A real technical shortcut is unsurfaced; a paved way carrying an MTB grade is a
      // tagging oddity and tells us nothing about how the two profiles differ. Scale 2,
      // not 1: 100 m of easy singletrack past a viewpoint is a fair choice for an expert
      // on 40 mm tyres, and the point here is ground the gravel bike is not built for.
      g.edges[0].surface = "ground";
      g.edges[0].tags = { "mtb:scale": "2" };
      g.edges[0].reward = 1;
      g.edges[1].length = 80;
      g.edges[1].grades = [[80, 0]];
      g.edges[2].length = 80;
      g.edges[2].grades = [[80, 0]];
      return g;
    };
    // A rider out looking for difficult ground. Shipped MTB climbs like gravel now and
    // avoids it uphill, so it is not the profile this mechanism is about.
    const seeker = withPreferences(TRAIL, { surface_difficulty: "prefer" });
    const scenic = route(
      build(),
      { anchors: [points[0], points[1]], profile: seeker },
      "reference",
    );
    expect(scenic.status).toBe("ok");
    expect(scenic.edgeIds).toEqual([0]);
    const gravel = route(
      build(),
      { anchors: [points[0], points[1]], profile: GRAVEL },
      "reference",
    );
    expect(gravel.status).toBe("ok");
    // The shortcut used to be *ineligible* for gravel, which is how a preference could
    // delete a connection. It is available now and simply priced higher, so a gravel
    // rider walks round a 160 m alternative rather than being told there is no way.
    expect(gravel.edgeIds).toEqual([1, 2]);
    const rate = (profile: typeof GRAVEL, id: number) => {
      const e = build().edges[id];
      return total(scoreEdge(e, profile)) / e.length;
    };
    expect(rate(GRAVEL, 0)).toBeGreaterThan(rate(seeker, 0));
  });

  it("costs an uphill technical section more than the same-scale downhill", () => {
    const uphill = fixture(p, [
      [0, 1, "a", { tags: { "mtb:scale:uphill": "2" }, grades: [[1000, 0.1]] }],
    ]).edges[0];
    const downhill = fixture(p, [
      [
        0,
        1,
        "a",
        { tags: { "mtb:scale:downhill": "2" }, grades: [[1000, -0.1]] },
      ],
    ]).edges[0];
    // Judged against a rider who is not out looking for technical ground, so this is the
    // capability model's directional thresholds talking rather than a taste for it.
    for (const profile of [GRAVEL, TOURING]) {
      expect(scoreEdge(uphill, profile).technical, profile.id).toBeGreaterThan(
        scoreEdge(downhill, profile).technical,
      );
      expect(total(scoreEdge(uphill, profile)), profile.id).toBeGreaterThan(
        total(scoreEdge(downhill, profile)),
      );
    }
  });

  it("lets every profile respond to reward, junction and technical tags", () => {
    // The old model gated these behind coefficients that most profiles left at zero, so
    // a scenic viewpoint or an MTB grade was literally invisible to the gravel preset.
    // Every profile reads every signal now; what differs is what it makes of them.
    const base = fixture(p, [[0, 1]]).edges[0];
    const decorated: Edge = {
      ...base,
      reward: 1,
      junction: 1,
      tags: { "mtb:scale:uphill": "3", "mtb:scale:downhill": "3" },
    };
    for (const profile of [GRAVEL, ROAD, TOURING, TRAIL]) {
      expect(total(scoreEdge(decorated, profile))).not.toBeCloseTo(
        total(scoreEdge(base, profile)),
        6,
      );
    }
  });

  it("prices mtb:scale by capability instead of excluding it", () => {
    // This used to be an eligibility test: scale 3 deleted the edge for gravel and
    // touring, scale 5 for everyone, and a profile could therefore return "no-path".
    // Difficulty is a cost now, so the ordering survives and the exclusions do not.
    const mk = (scale: string): Edge => ({
      ...fixture(p, [[0, 1]]).edges[0],
      highway: "path",
      tags: { "mtb:scale": scale },
    });
    for (const scale of ["3", "5"])
      for (const profile of [TRAIL, GRAVEL, TOURING])
        expect(eligible(mk(scale), profile)).toBe(true);

    for (const profile of [TRAIL, GRAVEL, TOURING])
      expect(total(scoreEdge(mk("5"), profile))).toBeGreaterThan(
        total(scoreEdge(mk("3"), profile)),
      );
    // A trail bike and rider are less put off by the same ground than a loaded tourer.
    expect(total(scoreEdge(mk("3"), TRAIL))).toBeLessThan(
      total(scoreEdge(mk("3"), TOURING)),
    );
  });
});

describe("review regressions", () => {
  it("preserves distinct one-way roundabout arcs when snapping repeatedly", () => {
    const g = fixture(p, [
      [0, 2, "circle"],
      [2, 0, "circle"],
    ]);
    g.edges[1].geometry = [p[2], p[3], p[0]];
    const untouched = structuredClone(g.edges[1]);
    const s = snapAnchors(g, [
      [6.105, 46.1],
      [6.115, 46.1],
    ])!;
    expect(s.graph.edges.find((e) => e.id === untouched.id)).toEqual(untouched);
    const split = s.graph.edges.filter((e) => e.id !== untouched.id);
    expect(split.reduce((sum, e) => sum + e.length, 0)).toBeCloseTo(
      g.edges[0].length,
    );
    expect(
      split.flatMap((e) => e.grades!).reduce((sum, [l]) => sum + l, 0),
    ).toBeCloseTo(g.edges[0].length);
    const r = route(
      g,
      {
        anchors: [
          [6.115, 46.1],
          [6.105, 46.1],
        ],
        profile: ROAD,
      },
      "reference",
    );
    expect(r.status).toBe("ok");
    expect(r.geometry).toContainEqual(p[3]);
  });
  it("blocks premature only-turn exits at every prefix, including hard waypoints", () => {
    const points: Point[] = Array.from({ length: 8 }, (_, i) => [
      6.1 + i * 0.001,
      46.1,
    ]);
    const g = fixture(points, [
      [0, 1, "a"],
      [1, 2, "v1"],
      [2, 3, "v1"],
      [3, 4, "v2"],
      [4, 5, "b"],
      [1, 6, "exit"],
      [2, 6, "exit"],
      [3, 6, "exit"],
      [4, 6, "exit"],
      [7, 2, "other"],
    ]);
    g.restrictions = [{ ways: ["a", "v1", "v2", "b"], only: true }];
    expect(
      route(
        g,
        { anchors: [points[0], points[1], points[6]], profile: ROAD },
        "reference",
      ).status,
    ).toBe("no-path");
    expect(
      route(
        g,
        { anchors: [points[0], points[2], points[5]], profile: ROAD },
        "reference",
      ).status,
    ).toBe("ok");
    expect(
      route(g, { anchors: [points[7], points[6]], profile: ROAD }, "reference")
        .status,
    ).toBe("ok");
  });
  it("enforces distinct-way and via-way U-turn sequences without immediate reversal", () => {
    const g = fixture(p, [
      [0, 1, "a"],
      [1, 2, "b"],
      [2, 3, "c"],
    ]);
    g.restrictions = [{ ways: ["a", "b"], via: 1, only: false, uTurn: true }];
    expect(
      route(g, { anchors: [p[0], p[2]], profile: ROAD }, "reference").status,
    ).toBe("no-path");
    g.restrictions = [{ ways: ["a", "b", "c"], only: false, uTurn: true }];
    expect(
      route(g, { anchors: [p[0], p[3]], profile: ROAD }, "reference").status,
    ).toBe("no-path");
  });
});

it("preserves directional grades when splitting a genuine reverse pair twice", () => {
  const g = fixture(p, [
    [0, 2, "road"],
    [2, 0, "road"],
  ]);
  const length = g.edges[0].length;
  g.edges[0].grades = [
    [length / 2, 0.1],
    [length / 2, 0.2],
  ];
  g.edges[1].grades = [
    [length / 2, -0.2],
    [length / 2, -0.1],
  ];
  const s = snapAnchors(g, [
    [6.105, 46.1],
    [6.115, 46.1],
  ])!;
  for (const sign of [-1, 1]) {
    const samples = s.graph.edges
      .filter((e) => Math.sign(e.grades![0][1]) === sign)
      .flatMap((e) => e.grades!);
    expect(samples.reduce((sum, [meters]) => sum + meters, 0)).toBeCloseTo(
      length,
    );
    expect(
      samples.reduce((sum, [meters, grade]) => sum + meters * grade, 0),
    ).toBeCloseTo(sign * length * 0.15);
  }
});

it("reports a disconnected later waypoint before spending the search budget", () => {
  const points: Point[] = [
    [6.1, 46.1],
    [6.11, 46.1],
    [6.12, 46.1],
    [6.13, 46.1],
  ];
  const g = fixture(points, [
    [0, 1],
    [1, 0],
    [2, 3],
  ]);
  const r = route(
    g,
    { anchors: points.slice(0, 3), profile: GRAVEL, maxSettled: 1 },
    "reference",
  );
  expect(r.status).toBe("no-path");
  expect(r.failedLeg).toBe(2);
  expect(r.metrics.explored).toBe(0);
});

it("does not multiply loop states because of an unrelated long restriction", () => {
  const points: Point[] = Array.from({ length: 10 }, (_, i) => [
    6.1 + i * 0.001,
    46.1,
  ]);
  const links: [number, number, string?, Partial<Edge>?][] = [];
  for (let i = 1; i <= 8; i++) {
    links.push(
      [0, i, `out${i}`, { length: 1 }],
      [i, 0, `back${i}`, { length: 1 }],
    );
  }
  links.push([0, 9, "destination", { length: 100 }]);
  const g = fixture(points, links);
  g.restrictions = [
    {
      ways: [
        "elsewhere1",
        "elsewhere2",
        "elsewhere3",
        "elsewhere4",
        "elsewhere5",
      ],
      only: false,
    },
  ];
  const r = route(
    g,
    { anchors: [points[0], points[9]], profile: GRAVEL, maxSettled: 40 },
    "reference",
  );
  expect(r.status).toBe("ok");
  expect(r.edgeIds).toEqual([16]);
  expect(r.metrics.explored).toBeLessThan(40);
});
