import { describe, expect, it } from "vitest";
import {
  distance,
  Heap,
  route,
  scoreEdge,
  snapAnchors,
  total,
} from "../src/routing/engine";
import { exportGPX } from "../src/gpx";
import type { Edge, Graph, Point } from "../src/routing/types";
function fixture(points: Point[], links: [number, number, string?][]): Graph {
  const nodes = points.map((p, id) => ({ id, p, elevation: 0 }));
  return {
    schemaVersion: 1,
    bbox: [5.8, 45.95, 6.55, 46.45],
    nodes,
    restrictions: [],
    edges: links.map(([from, to, way], id) => ({
      id,
      from,
      to,
      way: way ?? String(id),
      length: distance(points[from], points[to]),
      geometry: [points[from], points[to]],
      grades: [[distance(points[from], points[to]), 0]],
      surface: "paved",
      stress: 0.1,
      uncertainty: 0.1,
      utility: 0.5,
      bridge: false,
      tunnel: false,
      name: "",
      tile: String(from),
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
    const result = route(
      g,
      { anchors: [points[0], points[2]], profile: "gravel" },
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
        { anchors: [g.nodes[0].p, g.nodes[3].p], profile: "gravel" },
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
      route(g, { anchors: [p[2], p[0]], profile: "road" }, "reference").status,
    ).toBe("no-path");
    expect(
      route(g, { anchors: [p[0], [7, 47]], profile: "road" }, "reference")
        .status,
    ).toBe("outside-coverage");
  });
  it("routes through a valid tile boundary", () => {
    const g = fixture(p, [
      [0, 1],
      [1, 2],
    ]);
    const r = route(
      g,
      { anchors: [p[0], p[2]], profile: "gravel" },
      "corridor",
    );
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
          profile: "road",
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
          profile: "road",
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
      { anchors: [p[0], p[1], p[2]], profile: "road" },
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
      route(g, { anchors: [p[0], p[3]], profile: "gravel" }, "reference")
        .status,
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
      route(g, { anchors: [p[0], p[3]], profile: "gravel" }, "reference")
        .status,
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
      route(g, { anchors: [p[0], p[2]], profile: "road" }, "reference").status,
    ).toBe("ok");
  });
  it("never makes an attraction cost negative", () => {
    const e = fixture(p, [[0, 1]]).edges[0];
    for (const strength of [0, 0.5, 1, 10])
      expect(
        total(
          scoreEdge(e, "gravel", { point: p[1], radiusM: 10000, strength }),
        ),
      ).toBeGreaterThan(0);
  });
  it("scores uphill and downhill differently; keeps missing elevation unknown", () => {
    const g = fixture(p, [
      [0, 1],
      [1, 0],
    ]);
    g.edges[0].grades = [[1000, 0.1]];
    g.edges[1].grades = [[1000, -0.1]];
    expect(scoreEdge(g.edges[0], "touring").slope).toBeGreaterThan(
      scoreEdge(g.edges[1], "touring").slope,
    );
    g.edges[0].grades = null;
    expect(
      route(g, { anchors: [p[0], p[1]], profile: "road" }, "reference").ascentM,
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
    for (const profile of ["road", "gravel", "touring"] as const) {
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
  it("penalizes steep grades non-linearly per spec's severity bands", () => {
    const grade = (g: number): [number, number][] => [[1000, g]];
    const base = fixture(p, [[0, 1]]).edges[0];
    for (const profile of ["road", "gravel", "touring"] as const) {
      const e = { ...base, length: 1000, grades: grade(0.02) };
      expect(scoreEdge(e, profile).slope / 1000).toBeLessThan(0.02);
    }
    for (const profile of ["road", "gravel", "touring"] as const) {
      const e = { ...base, length: 1000, grades: grade(0.08) };
      expect(scoreEdge(e, profile).slope / 1000).toBeGreaterThan(0.4);
    }
    for (const profile of ["road", "gravel", "touring"] as const) {
      const e = { ...base, length: 1000, grades: grade(0.12) };
      expect(scoreEdge(e, profile).slope / 1000).toBeGreaterThan(1.0);
    }
  });
  it("makes road and gravel profiles respond differently to surface", () => {
    const e: Edge = { ...fixture(p, [[0, 1]]).edges[0], surface: "gravel" };
    expect(scoreEdge(e, "road").surface).toBeGreaterThan(
      scoreEdge(e, "gravel").surface,
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
        { anchors: [p[0], p[2]], profile: "road", maxSettled: 1 },
        "reference",
      ).status,
    ).toBe("budget-exceeded");
  });
  it("exports valid track coordinates with no fabricated altitude", () => {
    const g = fixture(p, [[0, 1]]);
    const xml = exportGPX(
      route(g, { anchors: [p[0], p[1]], profile: "road" }, "reference"),
    );
    expect(xml).toContain('lat="46.1" lon="6.1"');
    expect(xml).not.toContain("<ele>");
  });
  it("orders a priority queue correctly", () => {
    const heap = new Heap<number>();
    for (const n of [4, 1, 9, 0, 2]) heap.push(n, n);
    expect(Array.from({ length: 5 }, () => heap.pop()!.value)).toEqual([
      0, 1, 2, 4, 9,
    ]);
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
        profile: "road",
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
        { anchors: [points[0], points[1], points[6]], profile: "road" },
        "reference",
      ).status,
    ).toBe("no-path");
    expect(
      route(
        g,
        { anchors: [points[0], points[2], points[5]], profile: "road" },
        "reference",
      ).status,
    ).toBe("ok");
    expect(
      route(
        g,
        { anchors: [points[7], points[6]], profile: "road" },
        "reference",
      ).status,
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
      route(g, { anchors: [p[0], p[2]], profile: "road" }, "reference").status,
    ).toBe("no-path");
    g.restrictions = [{ ways: ["a", "b", "c"], only: false, uTurn: true }];
    expect(
      route(g, { anchors: [p[0], p[3]], profile: "road" }, "reference").status,
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
