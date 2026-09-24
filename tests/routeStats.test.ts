import { describe, expect, it } from "vitest";
import {
  composition,
  gradeRuns,
  heightAtM,
  MAX_GRADE,
  mergeSpans,
  metersAtVertex,
  metersAtX,
  pinMarks,
  profileGeometry,
  routeWarnings,
  windowRange,
  severityOf,
  steepComposition,
  steepLaneBands,
  steepLevel,
  steepSteps,
  smoothLevels,
  stressLaneBands,
  trafficComposition,
  trafficLevel,
  TRAFFIC_MIN_M,
  vertexAtM,
  WARNING_GAP_M,
  WARNING_MIN_M,
  type Severity,
} from "../src/map/routeStats";
import { ENGINE } from "../src/routing/vocabulary";
import {
  WARM_RAMP,
  segmentSpans,
  surfaceBands,
  warmColor,
} from "../src/map/rideStyle";
import { compileProfile } from "../src/routing/compile";
import { exceedance } from "../src/routing/capability";
import { surfaceRoughness } from "../src/routing/signals";
import type {
  RideClass,
  RouteResult,
  RouteSegment,
} from "../src/routing/types";
import { route } from "../src/routing/engine";
import { importedTrack } from "../src/tracks";
import { ROAD, TRAIL, voironsGraph } from "./helpers";

// `segmentSpans` and `warmColor` live in rideStyle beside the table they belong to, but they
// were added for these stats, so their tests sit with the rest of the feature's maths.

const segment = (
  start: number,
  end: number,
  ride: RideClass,
  surface = "asphalt",
  highway = "cycleway",
  stress = 0.02,
): RouteSegment => ({
  start,
  end,
  ride,
  surface,
  highway,
  grade: 0,
  roughness: surfaceRoughness(surface, highway),
  stress,
  lengthM: (end - start) * 100,
});

/** Only the fields the stats read; the rest of a result is irrelevant here. */
const result = (
  segments: RouteSegment[],
  distanceM: number,
  elevationProfile: [number, number | null][] = [],
): RouteResult =>
  ({ segments, distanceM, elevationProfile }) as unknown as RouteResult;

/** A 400 m climb at a constant grade, as an elevation profile. */
const ramp = (grade: number): [number, number | null][] => [
  [0, 100],
  [400, 100 + grade * 400],
];

const ROAD_CAPABILITY = compileProfile(ROAD).capability;
const TRAIL_CAPABILITY = compileProfile(TRAIL).capability;
const rank = (s: Severity) => ["caution", "hard", "severe"].indexOf(s);

describe("segment spans", () => {
  it("tiles the whole route with no gap or overlap", () => {
    const spans = segmentSpans(
      [segment(0, 1, "paved"), segment(1, 3, "gravel"), segment(3, 4, "rough")],
      1000,
    );
    expect(spans).toHaveLength(3);
    expect(spans[0].startM).toBe(0);
    expect(spans.at(-1)!.endM).toBeCloseTo(1000);
    for (let i = 1; i < spans.length; i++)
      expect(spans[i].startM).toBeCloseTo(spans[i - 1].endM);
  });

  it("carries the segment and its index so a span can be traced back", () => {
    const spans = segmentSpans(
      [segment(0, 1, "paved"), segment(1, 2, "walk")],
      200,
    );
    expect(spans[1].index).toBe(1);
    expect(spans[1].segment.ride).toBe("walk");
  });

  it("has nothing to say about an empty route", () => {
    expect(segmentSpans([], 1000)).toEqual([]);
    expect(segmentSpans([segment(0, 1, "paved")], 0)).toEqual([]);
  });

  it("still produces exactly the bands surfaceBands used to", () => {
    const segments = [
      segment(0, 1, "paved"),
      segment(1, 2, "paved"),
      segment(2, 4, "gravel"),
    ];
    // Merging same-class neighbours out of the spans is all surfaceBands now does, so the
    // two cannot drift apart.
    expect(surfaceBands(segments, 400)).toEqual([
      { ride: "paved", startM: 0, endM: 200 },
      { ride: "gravel", startM: 200, endM: 400 },
    ]);
  });
});

describe("warm ramp", () => {
  it("is clamped at both ends", () => {
    expect(warmColor(-1)).toBe(WARM_RAMP[0]);
    expect(warmColor(0)).toBe(WARM_RAMP[0]);
    expect(warmColor(1)).toBe(WARM_RAMP.at(-1));
    expect(warmColor(9)).toBe(WARM_RAMP.at(-1));
  });

  it("passes exactly through hike-a-bike's orange", () => {
    // The colour the elevation profile already hatches a carry with, so a fully-charged
    // difficulty band and that hatch are the same orange by construction.
    expect(WARM_RAMP).toContain("#ff7043");
    expect(warmColor(2 / 3)).toBe("#ff7043");
  });

  it("moves off yellow towards red without ever turning back", () => {
    // Green is the channel that carries this: it falls all the way from the yellow stop to
    // the red one. Red itself is *not* monotone — the last stop is a deep red, darker than
    // the orange before it — so asserting on red would be asserting a prettier ramp than
    // the one the palette actually wants.
    const greens = [0, 0.25, 0.5, 0.75, 1].map((t) =>
      parseInt(warmColor(t).slice(3, 5), 16),
    );
    expect(greens).toEqual([...greens].sort((a, b) => b - a));
    expect(new Set(greens).size).toBe(greens.length);
    for (const t of [0, 0.3, 0.6, 1])
      expect(warmColor(t)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("grade runs", () => {
  it("reads one run per pair of samples, with the sign of the climb", () => {
    const runs = gradeRuns([
      [0, 100],
      [200, 120],
      [400, 100],
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({ startM: 0, endM: 200, grade: 0.1 });
    expect(runs[1].grade).toBeCloseTo(-0.1);
  });

  it("breaks at a hole in the terrain rather than bridging it", () => {
    // A gradient nobody measured is worse than no gradient at all.
    const runs = gradeRuns([
      [0, 100],
      [100, 110],
      [200, null],
      [300, 200],
      [400, 210],
    ]);
    expect(runs.map((r) => [r.startM, r.endM])).toEqual([
      [0, 100],
      [300, 400],
    ]);
  });

  it("steps over the seam where one edge's profile hands over to the next", () => {
    // Edge one ends at an integrated 110 m; edge two restarts 4 mm later from its node's
    // DEM height of 108.9 m. Read naively that is a -27500% slope on flat ground.
    const runs = gradeRuns([
      [0, 100],
      [100, 110],
      [100.004, 108.9],
      [200.004, 118.9],
    ]);
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run.grade).toBeCloseTo(0.1);
  });

  it("never reads a real route steeper than the builder allows", () => {
    // On the Voirons fixture most edge seams used to read past 45%, and every one of them
    // turned into a severe "steep" warning on ordinary ground.
    const graph = voironsGraph();
    const r = route(
      graph,
      {
        profile: TRAIL,
        anchors: [
          graph.nodes[0].p,
          graph.nodes[Math.floor(graph.nodes.length / 2)].p,
        ],
      },
      "reference",
    );
    expect(r.status).toBe("ok");
    const runs = gradeRuns(r.elevationProfile);
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs)
      expect(Math.abs(run.grade)).toBeLessThanOrEqual(MAX_GRADE);
    for (const w of routeWarnings(r, compileProfile(TRAIL).capability))
      if (w.kind === "steep") expect(w.detail).not.toMatch(/\d{3,}%/);
  });

  it("has nothing to say about fewer than two known points", () => {
    expect(gradeRuns([])).toEqual([]);
    expect(gradeRuns([[0, 100]])).toEqual([]);
    expect(
      gradeRuns([
        [0, null],
        [100, null],
      ]),
    ).toEqual([]);
  });
});

describe("pointer to distance", () => {
  const box = { w: 280, h: 75, top: 10, base: 65 };

  it("maps the ends of the chart to the ends of the route", () => {
    expect(metersAtX(0, 280, 1000)).toBe(0);
    expect(metersAtX(280, 280, 1000)).toBe(1000);
    expect(metersAtX(140, 280, 1000)).toBeCloseTo(500);
  });

  it("maps against the visible stretch while a window is active", () => {
    const window = { startM: 400, endM: 800 };
    expect(metersAtX(0, 280, 1000, window)).toBe(400);
    expect(metersAtX(280, 280, 1000, window)).toBe(800);
    expect(metersAtX(140, 280, 1000, window)).toBeCloseTo(600);
  });

  it("clamps a pointer that leaves the chart", () => {
    expect(metersAtX(-50, 280, 1000)).toBe(0);
    expect(metersAtX(9999, 280, 1000)).toBe(1000);
  });

  it("survives a chart with no width yet", () => {
    expect(metersAtX(10, 0, 1000)).toBe(0);
  });

  it("inverts the axis the chart was actually drawn on", () => {
    // The round trip is the property that matters: press a pixel, get a distance, and the
    // curve puts that distance back under the same pixel — windowed or not.
    const profile: [number, number | null][] = [
      [0, 100],
      [500, 400],
      [1000, 200],
    ];
    for (const window of [undefined, { startM: 250, endM: 750 }]) {
      const g = profileGeometry(profile, 1000, box, window)!;
      for (const px of [0, 70, 140, 210, 280])
        expect(g.x(metersAtX(px, box.w, 1000, window))).toBeCloseTo(px);
    }
  });

  it("clamps a window that runs backwards or past the route", () => {
    expect(windowRange(1000)).toEqual([0, 1000]);
    expect(windowRange(1000, { startM: -100, endM: 5000 })).toEqual([0, 1000]);
    // A zero-width window would divide by nothing; it is widened to a metre instead.
    expect(windowRange(1000, { startM: 600, endM: 600 })).toEqual([600, 601]);
  });
});

describe("pin marks", () => {
  it("leaves pins that are far enough apart alone", () => {
    const marks = pinMarks(
      [
        { meters: 0, kind: "waypoint" },
        { meters: 5000, kind: "warning" },
      ],
      100,
    );
    expect(marks).toHaveLength(2);
    expect(marks.every((m) => m.count === 1)).toBe(true);
  });

  it("collapses a cluster into one mark that says how many", () => {
    const marks = pinMarks(
      [
        { meters: 1000, kind: "waypoint" },
        { meters: 1050, kind: "waypoint" },
        { meters: 1090, kind: "waypoint" },
      ],
      100,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].count).toBe(3);
  });

  it("lets a warning outrank a waypoint it merges with", () => {
    // The waypoint is where the rider chose to go; the warning is what they would rather
    // not find out on arrival, so it is the one that stays visible.
    const marks = pinMarks(
      [
        { meters: 1000, kind: "waypoint" },
        { meters: 1020, kind: "warning" },
      ],
      100,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].kind).toBe("warning");
  });

  it("sorts pins given out of order", () => {
    const marks = pinMarks(
      [
        { meters: 900, kind: "warning" },
        { meters: 100, kind: "waypoint" },
      ],
      10,
    );
    expect(marks.map((m) => m.meters)).toEqual([100, 900]);
  });

  it("has nothing to mark on a route with no pins", () => {
    expect(pinMarks([], 100)).toEqual([]);
  });
});

describe("profile geometry", () => {
  const box = { w: 280, h: 75, top: 10, base: 65 };

  it("spans the box from end to end", () => {
    const g = profileGeometry(
      [
        [0, 100],
        [500, 200],
      ],
      500,
      box,
    )!;
    expect(g.x(0)).toBe(0);
    expect(g.x(500)).toBe(280);
    expect(g.min).toBe(100);
    expect(g.max).toBe(200);
    // The taller end of the range sits at the top of the box, so y runs the other way.
    expect(g.y(200)).toBeLessThan(g.y(100));
    expect(g.lines).toHaveLength(1);
    expect(g.areas).toHaveLength(1);
  });

  it("breaks the curve and the fill at a hole in the terrain", () => {
    const g = profileGeometry(
      [
        [0, 100],
        [100, 120],
        [200, null],
        [300, 150],
        [400, 160],
      ],
      400,
      box,
    )!;
    expect(g.lines).toHaveLength(2);
    expect(g.areas).toHaveLength(2);
    // Each area is closed back to the baseline so it can be used as a clip.
    for (const area of g.areas) expect(area.endsWith("Z")).toBe(true);
  });

  it("declines to draw a route with nothing measured", () => {
    expect(profileGeometry([], 100, box)).toBeNull();
    expect(profileGeometry([[0, 100]], 100, box)).toBeNull();
    expect(
      profileGeometry(
        [
          [0, null],
          [100, null],
        ],
        100,
        box,
      ),
    ).toBeNull();
  });

  it("redraws over a window, rescaling the axis to it", () => {
    const profile: [number, number | null][] = [
      [0, 100],
      [250, 900],
      [500, 120],
      [750, 130],
      [1000, 140],
    ];
    const g = profileGeometry(profile, 1000, box, {
      startM: 500,
      endM: 1000,
    })!;
    expect(g.x(500)).toBe(0);
    expect(g.x(1000)).toBe(280);
    expect(g.x(750)).toBeCloseTo(140);
    // The 900 m peak is outside the window, so the height range is the window's own and
    // the flat stretch inside it is actually legible.
    expect(g.max).toBe(140);
    expect(g.min).toBe(120);
  });

  it("draws a narrow window by interpolating its edges", () => {
    // Samples are grade runs and can be hundreds of metres apart, so a brush can easily
    // land between two of them. That must still draw the ground it covers, not go blank.
    const profile: [number, number | null][] = [
      [0, 100],
      [500, 200],
      [1000, 300],
    ];
    const g = profileGeometry(profile, 1000, box, {
      startM: 600,
      endM: 900,
    })!;
    expect(g.x(600)).toBe(0);
    expect(g.x(900)).toBe(280);
    expect(g.min).toBeCloseTo(220);
    expect(g.max).toBeCloseTo(280);
    expect(g.lines).toHaveLength(1);
  });

  it("still declines a window over ground nobody measured", () => {
    const profile: [number, number | null][] = [
      [0, 100],
      [500, null],
      [1000, 300],
    ];
    expect(
      profileGeometry(profile, 1000, box, { startM: 600, endM: 900 }),
    ).toBeNull();
  });

  it("clamps a window that runs past the route", () => {
    const profile: [number, number | null][] = [
      [0, 100],
      [500, 200],
      [1000, 300],
    ];
    const g = profileGeometry(profile, 1000, box, {
      startM: -200,
      endM: 5000,
    })!;
    expect(g.x(0)).toBe(0);
    expect(g.x(1000)).toBe(280);
  });

  it("does not turn a flat route into a mountain of rounding noise", () => {
    const g = profileGeometry(
      [
        [0, 100],
        [200, 100.4],
        [400, 100],
      ],
      400,
      box,
    )!;
    // A 0.4 m bump must not fill the box: the height scale has a 20 m floor.
    const heights = [g.y(100), g.y(100.4)];
    expect(Math.abs(heights[0] - heights[1])).toBeLessThan(2);
  });
});

describe("steep lane", () => {
  it("paints nothing a rider is comfortable with", () => {
    const flat: [number, number | null][] = [
      [0, 100],
      [500, 101],
    ];
    expect(steepLaneBands(flat, TRAIL_CAPABILITY)).toEqual([]);
  });

  it("paints the climb against the ground it is ridden on", () => {
    // The router charges a climb by `tractionGrade`, so the lane has to as well or the
    // chart contradicts the line it is drawing. One gradient, chosen to sit inside the
    // rider's comfortable range on tarmac and outside it on a loose track.
    const capability = ROAD_CAPABILITY;
    const grade = capability.uphill_grade.comfortable_until * 0.95;
    const onGround = (surface: string, highway: string) =>
      steepLaneBands(
        ramp(grade),
        capability,
        [segment(0, 1, "paved", surface, highway)],
        400,
      );
    expect(onGround("asphalt", "residential")).toEqual([]);
    expect(onGround("gravel", "track").length).toBeGreaterThan(0);
    // With no segments at all — a synthetic profile, or a route stored before segments
    // carried roughness — it falls back to the untouched threshold rather than guessing.
    expect(steepLaneBands(ramp(grade), capability)).toEqual([]);
  });

  it("starts painting exactly where this rider stops being comfortable", () => {
    // Driven off each profile's own threshold rather than a guessed gradient, so the test
    // says what the lane promises: the line is the rider's, not the house's.
    for (const capability of [ROAD_CAPABILITY, TRAIL_CAPABILITY]) {
      const threshold = capability.uphill_grade;
      expect(
        steepLaneBands(ramp(threshold.comfortable_until * 0.8), capability),
      ).toEqual([]);
      const hard = steepLaneBands(ramp(threshold.high_cost_at), capability);
      expect(hard).toHaveLength(1);
      expect(hard[0].label).toContain("climb");
      expect(hard[0].color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("never paints a worse ramp cooler than a milder one", () => {
    const green = (hex: string) => parseInt(hex.slice(3, 5), 16);
    const threshold = ROAD_CAPABILITY.uphill_grade;
    const milder = steepLaneBands(
      ramp(threshold.high_cost_at),
      ROAD_CAPABILITY,
    );
    // Worse, but still a grade a real pack can hold.
    const steeper = Math.min(MAX_GRADE, threshold.high_cost_at * 2);
    expect(steeper).toBeGreaterThan(threshold.high_cost_at);
    const worse = steepLaneBands(ramp(steeper), ROAD_CAPABILITY);
    expect(milder).toHaveLength(1);
    expect(worse).toHaveLength(1);
    expect(green(worse[0].color)).toBeLessThanOrEqual(green(milder[0].color));
  });

  it("names a descent a descent", () => {
    // 40% — inside the builder's clamp. A 50% slope cannot come out of a real pack.
    const bands = steepLaneBands(
      [
        [0, 300],
        [400, 140],
      ],
      ROAD_CAPABILITY,
    );
    expect(bands).toHaveLength(1);
    expect(bands[0].label).toContain("descent");
    expect(bands[0].label).toContain("40%");
  });
});

describe("stress lane", () => {
  const quiet = ENGINE.traffic_from - 0.1;
  const busy = ENGINE.traffic_from + (1 - ENGINE.traffic_from) / 2;

  it("paints nothing on a route no busier than a quiet lane", () => {
    // The anchor is the engine's own: below it the cost model leaves traffic to taste, so
    // an empty lane means genuinely calm rather than merely under a house threshold.
    const bands = stressLaneBands(
      [segment(0, 4, "paved", "asphalt", "tertiary", quiet)],
      400,
    );
    expect(bands).toEqual([]);
  });

  it("paints the stretches busier than that, and says how busy", () => {
    const bands = stressLaneBands(
      [
        segment(0, 2, "paved", "asphalt", "residential", quiet),
        segment(2, 4, "paved", "asphalt", "primary", busy),
      ],
      400,
    );
    expect(bands).toHaveLength(1);
    expect(bands[0].startM).toBeCloseTo(200);
    expect(bands[0].endM).toBeCloseTo(400);
    expect(bands[0].label).toContain("traffic stress");
    expect(bands[0].color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("never paints a busier road cooler than a calmer one", () => {
    const green = (hex: string) => parseInt(hex.slice(3, 5), 16);
    const middling = stressLaneBands(
      [segment(0, 4, "paved", "asphalt", "secondary", busy)],
      400,
    );
    const worst = stressLaneBands(
      [segment(0, 4, "paved", "asphalt", "primary", 1)],
      400,
    );
    expect(green(worst[0].color)).toBeLessThanOrEqual(green(middling[0].color));
  });

  it("paints nothing for a route computed before segments carried stress", () => {
    // The field is required now, but a result persisted earlier has no value to paint.
    const stale = [
      { ...segment(0, 4, "paved"), stress: undefined },
    ] as unknown as RouteSegment[];
    expect(stressLaneBands(stale, 400)).toEqual([]);
  });
});

describe("distance and height lookups", () => {
  const segments = [segment(0, 2, "paved"), segment(2, 5, "gravel")];

  it("puts the first vertex at the start and the last at the finish", () => {
    expect(metersAtVertex(segments, 500, 0)).toBe(0);
    expect(metersAtVertex(segments, 500, 5)).toBeCloseTo(500);
  });

  it("interpolates inside the segment holding the vertex", () => {
    // Two spans: vertices 0-2 over the first 200 m, 2-5 over the remaining 300 m.
    expect(metersAtVertex(segments, 500, 1)).toBeCloseTo(100);
    expect(metersAtVertex(segments, 500, 2)).toBeCloseTo(200);
    expect(metersAtVertex(segments, 500, 4)).toBeCloseTo(400);
  });

  it("has nothing to interpolate on a route with no segments", () => {
    expect(metersAtVertex([], 500, 3)).toBe(0);
    expect(vertexAtM([], 500, 250)).toBe(0);
  });

  it("turns a distance back into a vertex, undoing metersAtVertex", () => {
    // The two have to agree or a located point would drift from the band pointed at.
    for (const vertex of [0, 1, 2, 4, 5]) {
      const meters = metersAtVertex(segments, 500, vertex);
      expect(vertexAtM(segments, 500, meters)).toBeCloseTo(vertex);
    }
  });

  it("clamps a distance past either end onto the route", () => {
    expect(vertexAtM(segments, 500, -10)).toBe(0);
    expect(vertexAtM(segments, 500, 900)).toBe(5);
  });

  it("reads a height between two samples", () => {
    const profile: [number, number | null][] = [
      [0, 100],
      [200, 200],
    ];
    expect(heightAtM(profile, 0)).toBe(100);
    expect(heightAtM(profile, 100)).toBeCloseTo(150);
    expect(heightAtM(profile, 200)).toBe(200);
  });

  it("refuses to guess across a hole in the terrain or past the ends", () => {
    expect(
      heightAtM(
        [
          [0, 100],
          [200, null],
        ],
        100,
      ),
    ).toBeNull();
    expect(
      heightAtM(
        [
          [0, 100],
          [200, 200],
        ],
        500,
      ),
    ).toBeNull();
    expect(heightAtM([], 0)).toBeNull();
  });
});

describe("severity", () => {
  it("steps at the engine's own boundaries", () => {
    expect(severityOf(0.01)).toBe("caution");
    expect(severityOf(0.99)).toBe("caution");
    expect(severityOf(1)).toBe("hard");
    expect(severityOf(1.99)).toBe("hard");
    expect(severityOf(2)).toBe("severe");
  });

  it("calls it hard exactly where the router would stop pedalling", () => {
    // `segmentMode` forces walking at an exceedance of 1, so "hard" is not a taste.
    const threshold = ROAD_CAPABILITY.uphill_grade;
    const atLimit = threshold.high_cost_at;
    expect(exceedance(atLimit, threshold)).toBeCloseTo(1);
    expect(
      rank(severityOf(exceedance(atLimit, threshold))),
    ).toBeGreaterThanOrEqual(rank("hard"));
    expect(severityOf(exceedance(threshold.comfortable_until, threshold))).toBe(
      "caution",
    );
  });
});

describe("merging spans", () => {
  it("joins what is nearly touching and leaves a real gap alone", () => {
    const near = mergeSpans(
      [
        { startM: 0, endM: 100 },
        { startM: 100 + WARNING_GAP_M - 1, endM: 600 },
      ],
      WARNING_GAP_M,
    );
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({ startM: 0, endM: 600 });
    expect(near[0].parts).toHaveLength(2);

    const far = mergeSpans(
      [
        { startM: 0, endM: 100 },
        { startM: 100 + WARNING_GAP_M + 1, endM: 600 },
      ],
      WARNING_GAP_M,
    );
    expect(far).toHaveLength(2);
  });

  it("keeps the parts so the worst of them can still be found", () => {
    const merged = mergeSpans(
      [
        { startM: 0, endM: 100, grade: 0.1 },
        { startM: 150, endM: 300, grade: 0.2 },
      ],
      WARNING_GAP_M,
    );
    expect(merged[0].parts.map((p) => p.grade)).toEqual([0.1, 0.2]);
  });
});

describe("route warnings", () => {
  it("reports a pushed section as hard however gentle the ground looks", () => {
    const warnings = routeWarnings(
      result([segment(0, 1, "paved"), segment(1, 6, "walk")], 600),
      ROAD_CAPABILITY,
    );
    const walk = warnings.filter((w) => w.kind === "walk");
    expect(walk).toHaveLength(1);
    expect(rank(walk[0].severity)).toBeGreaterThanOrEqual(rank("hard"));
    expect(walk[0].headline).toBe("Hike-a-bike");
    expect(walk[0].startM).toBeCloseTo(100);
    expect(walk[0].endM).toBeCloseTo(600);
  });

  it("ignores a section too short to be worth a line of its own", () => {
    const short = (WARNING_MIN_M - 20) / 100;
    expect(
      routeWarnings(
        result([segment(0, short, "walk")], WARNING_MIN_M - 20),
        ROAD_CAPABILITY,
      ),
    ).toEqual([]);
  });

  it("joins two rough stretches a few metres apart into one section", () => {
    const warnings = routeWarnings(
      result(
        [
          segment(0, 3, "rough", "ground", "track"),
          segment(3, 3.5, "gravel", "compacted", "track"),
          segment(3.5, 7, "rough", "ground", "track"),
        ],
        700,
      ),
      ROAD_CAPABILITY,
    );
    const rough = warnings.filter((w) => w.kind === "rough");
    expect(rough).toHaveLength(1);
    expect(rough[0].startM).toBeCloseTo(0);
    expect(rough[0].endM).toBeCloseTo(700);
  });

  it("judges the same broken ground against the bike that is on it", () => {
    // `surface_roughness` is built from tyre width and suspension, so this is the whole
    // point of taking thresholds from the rider rather than picking a number.
    const rough = result([segment(0, 6, "rough", "ground", "track")], 600);
    const onRoad = routeWarnings(rough, ROAD_CAPABILITY).filter(
      (w) => w.kind === "rough",
    );
    const onTrail = routeWarnings(rough, TRAIL_CAPABILITY).filter(
      (w) => w.kind === "rough",
    );
    expect(onRoad).toHaveLength(1);
    const roadRank = rank(onRoad[0].severity);
    const trailRank = onTrail.length ? rank(onTrail[0].severity) : -1;
    expect(roadRank).toBeGreaterThan(trailRank);
  });

  it("flags a steep climb and names how steep it got", () => {
    const warnings = routeWarnings(
      result([segment(0, 4, "paved")], 400, [
        [0, 100],
        [200, 110],
        [400, 170],
      ]),
      ROAD_CAPABILITY,
    );
    const steep = warnings.filter((w) => w.kind === "steep");
    expect(steep).toHaveLength(1);
    expect(steep[0].headline).toBe("Steep climb");
    expect(steep[0].detail).toContain("30%");
  });

  it("flags a steep descent too", () => {
    const warnings = routeWarnings(
      result([segment(0, 4, "paved")], 400, [
        [0, 200],
        [400, 80],
      ]),
      ROAD_CAPABILITY,
    );
    expect(warnings.some((w) => w.headline === "Steep descent")).toBe(true);
  });

  it("orders the worst sections first", () => {
    const warnings = routeWarnings(
      result(
        [segment(0, 4, "rough", "gravel", "track"), segment(4, 10, "walk")],
        1000,
        [
          [0, 100],
          [400, 130],
          [1000, 400],
        ],
      ),
      ROAD_CAPABILITY,
    );
    const ranks = warnings.map((w) => rank(w.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  it("says nothing about an imported track, which has no segments at all", () => {
    // Built by the real importer rather than cast from a literal: `segments` is declared
    // on RouteResult, and a stand-in without it hid that importedTrack never set it.
    const imported = importedTrack(0, {
      name: "Sunday loop",
      geometry: [
        [6.1, 46.1],
        [6.2, 46.2],
      ],
      elevationProfile: [],
      distanceM: 5000,
      ascentM: null,
      descentM: null,
    }).result!;
    expect(imported.segments).toEqual([]);
    expect(routeWarnings(imported, ROAD_CAPABILITY)).toEqual([]);
  });
});

describe("lenses", () => {
  it("names steepness levels by this rider's own gradients", () => {
    // A 20% ramp on a pro's compact is not a 6% drag on a loaded fixed gear: the steps
    // are the profile's, so two riders read the same climb differently.
    const road = steepSteps(ROAD_CAPABILITY.uphill_grade);
    const trail = steepSteps(TRAIL_CAPABILITY.uphill_grade);
    expect(road[0]).toBeLessThan(road[1]);
    expect(road[1]).toBeLessThan(road[2]);
    expect(road).not.toEqual(trail);
    const t = ROAD_CAPABILITY.uphill_grade;
    expect(steepLevel(t.comfortable_until, t)).toBe(0);
    expect(steepLevel(road[1] - 0.001, t)).toBe(1);
    expect(steepLevel(road[1] + 0.001, t)).toBe(2);
    // Level 3 is exactly where the capability model stops the pedals.
    expect(steepLevel(t.high_cost_at, t)).toBe(3);
  });

  it("shares a climb out by level, and counts what has no terrain apart", () => {
    const t = ROAD_CAPABILITY.uphill_grade;
    const entries = steepComposition(
      result([segment(0, 10, "paved")], 1000, [
        [0, 100],
        [400, 100],
        [800, 100 + t.high_cost_at * 1.05 * 400],
        [900, null],
        [1000, null],
      ]),
      ROAD_CAPABILITY,
    );
    const byLevel = Object.fromEntries(entries.map((e) => [e.level, e]));
    expect(byLevel[0].meters).toBeCloseTo(400);
    expect(byLevel[3].meters).toBeCloseTo(400);
    expect(byLevel[3].label).toContain("push");
    expect(byLevel.unknown.meters).toBeCloseTo(200);
    expect(entries.reduce((sum, e) => sum + e.share, 0)).toBeCloseTo(1);
  });

  it("draws a steady climb as one stretch, not a string of dashes", () => {
    const run = (startM: number, endM: number, level: 0 | 1 | 2 | 3) => ({
      startM,
      endM,
      level,
    });
    expect(
      smoothLevels([
        run(0, 200, 1),
        run(200, 220, 0), // a 20 m breather inside the climb
        run(220, 500, 1),
        run(500, 510, 3), // a 10 m spike
        run(510, 800, 1),
        run(800, 1000, 0),
      ]),
    ).toEqual([run(0, 800, 1), run(800, 1000, 0)]);
    // A long enough flat stays flat.
    expect(
      smoothLevels([run(0, 200, 1), run(200, 300, 0), run(300, 500, 1)]),
    ).toHaveLength(3);
  });

  it("leaves traffic calm up to the engine's own threshold, then steps by road class", () => {
    expect(trafficLevel(ENGINE.traffic_from)).toBe(0);
    expect(trafficLevel(0.2)).toBe(0);
    // A signed town primary, calmed by the network.
    expect(trafficLevel(0.95 * ENGINE.network_calming)).toBe(1);
    expect(trafficLevel(0.8)).toBe(2);
    expect(trafficLevel(0.95)).toBe(3);
    expect(trafficLevel(NaN)).toBe(0);
    const entries = trafficComposition(
      result(
        [
          segment(0, 6, "paved", "asphalt", "residential", 0.2),
          segment(6, 10, "paved", "asphalt", "primary", 0.95),
        ],
        1000,
      ),
    );
    expect(entries.map((e) => [e.level, Math.round(e.meters)])).toEqual([
      [0, 600],
      [3, 400],
    ]);
  });

  it("files a push under what forced it: gradient or ground", () => {
    const t = ROAD_CAPABILITY.uphill_grade;
    const [steep] = routeWarnings(
      result([segment(0, 4, "walk", "asphalt", "path")], 400, [
        [0, 100],
        [400, 100 + t.high_cost_at * 1.2 * 400],
      ]),
      ROAD_CAPABILITY,
    ).filter((w) => w.kind === "walk");
    expect(steep.lens).toBe("steep");
    const [ground] = routeWarnings(
      result([segment(0, 4, "walk", "rock", "path")], 400, ramp(0)),
      ROAD_CAPABILITY,
    ).filter((w) => w.kind === "walk");
    expect(ground.lens).toBe("surface");
    // Steps are carried whatever the gradient says.
    const [steps] = routeWarnings(
      result([segment(0, 4, "walk", "paved", "steps")], 400, [
        [0, 100],
        [400, 100 + t.high_cost_at * 1.2 * 400],
      ]),
      ROAD_CAPABILITY,
    ).filter((w) => w.kind === "walk");
    expect(steps.lens).toBe("surface");
    expect(steps.detail).toContain("steps");
  });

  it("warns of a busy road ridden along, not of one crossed", () => {
    const along = routeWarnings(
      result(
        [
          segment(0, 2, "paved", "asphalt", "residential", 0.2),
          segment(2, 12, "paved", "asphalt", "secondary", 0.8),
        ],
        1200,
      ),
      ROAD_CAPABILITY,
    ).filter((w) => w.lens === "traffic");
    expect(along).toHaveLength(1);
    expect(along[0].headline).toBe("Busy road");
    expect(along[0].detail).toContain("secondary");
    const crossed = (TRAFFIC_MIN_M - 100) / 100;
    expect(
      routeWarnings(
        result(
          [segment(0, crossed, "paved", "asphalt", "primary", 0.95)],
          TRAFFIC_MIN_M - 100,
        ),
        ROAD_CAPABILITY,
      ).filter((w) => w.lens === "traffic"),
    ).toEqual([]);
  });
});

describe("composition", () => {
  it("shares out the whole route and sums to one", () => {
    const entries = composition(
      [segment(0, 6, "paved"), segment(6, 9, "gravel"), segment(9, 10, "walk")],
      1000,
    );
    expect(entries.map((e) => e.ride)).toEqual(["paved", "gravel", "walk"]);
    expect(entries.reduce((sum, e) => sum + e.share, 0)).toBeCloseTo(1);
    expect(entries.reduce((sum, e) => sum + e.meters, 0)).toBeCloseTo(1000);
    expect(entries[0].share).toBeCloseTo(0.6);
    expect(entries[0].label).toBe("Paved");
  });

  it("lists classes in the order the map and the Legend tab use", () => {
    const entries = composition(
      [segment(0, 1, "walk"), segment(1, 2, "paved"), segment(2, 3, "gravel")],
      300,
    );
    expect(entries.map((e) => e.ride)).toEqual(["paved", "gravel", "walk"]);
  });

  it("reports the classes ridden rather than the raw surface tags", () => {
    // `RouteResult.surfaceM` is keyed by OSM surface and does not agree with these classes,
    // which is exactly why composition is built from the segments instead.
    const entries = composition(
      [
        segment(0, 5, "gravel", "compacted"),
        segment(5, 10, "gravel", "fine_gravel"),
      ],
      1000,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ride: "gravel", meters: 1000 });
  });

  it("has nothing to say about an empty route", () => {
    expect(composition([], 1000)).toEqual([]);
  });
});
