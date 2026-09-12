import { describe, expect, it } from "vitest";
import {
  SURFACE_STYLE,
  rideFeatures,
  rideTotals,
  surfaceBands,
  surfaceStyle,
  trackColorExpression,
} from "../src/map/rideStyle";
import type { Point, RideClass, RouteSegment } from "../src/routing/types";

const meta = {
  trackId: "t1",
  trackColor: "#2485ff",
  active: true,
  stale: false,
};

const geometry: Point[] = [
  [6.1, 46.2],
  [6.11, 46.2],
  [6.12, 46.2],
  [6.13, 46.2],
  [6.14, 46.2],
];

const segment = (
  start: number,
  end: number,
  ride: RideClass,
): RouteSegment => ({
  start,
  end,
  ride,
  surface: "asphalt",
  highway: "cycleway",
  grade: 0,
  lengthM: (end - start) * 100,
});

describe("ride features", () => {
  it("merges consecutive segments of the same class into one line", () => {
    const features = rideFeatures(
      [segment(0, 1, "paved"), segment(1, 2, "paved"), segment(2, 4, "gravel")],
      geometry,
      meta,
    );
    expect(features).toHaveLength(2);
    expect(features[0].properties.ride).toBe("paved");
    // Merged, and the shared vertex appears once rather than twice.
    expect(features[0].geometry.coordinates).toEqual(geometry.slice(0, 3));
    expect(features[0].properties.lengthM).toBe(200);
    expect(features[1].geometry.coordinates).toEqual(geometry.slice(2, 5));
  });

  it("keeps every class distinct when they alternate", () => {
    const features = rideFeatures(
      [segment(0, 1, "paved"), segment(1, 2, "walk"), segment(2, 3, "paved")],
      geometry,
      meta,
    );
    expect(features.map((f) => f.properties.ride)).toEqual([
      "paved",
      "walk",
      "paved",
    ]);
  });

  it("carries the track's own metadata onto every feature", () => {
    const features = rideFeatures(
      [segment(0, 2, "paved"), segment(2, 4, "rough")],
      geometry,
      { ...meta, stale: true },
    );
    for (const f of features) {
      expect(f.properties.trackId).toBe("t1");
      expect(f.properties.trackColor).toBe("#2485ff");
      expect(f.properties.stale).toBe(true);
    }
  });

  it("draws a result that predates segments as a single line", () => {
    const features = rideFeatures([], geometry, meta);
    expect(features).toHaveLength(1);
    expect(features[0].geometry.coordinates).toEqual(geometry);
  });

  it("produces nothing at all from an empty geometry", () => {
    expect(rideFeatures([], [], meta)).toEqual([]);
    // A degenerate one-vertex segment cannot be a line.
    expect(rideFeatures([segment(0, 0, "paved")], geometry, meta)).toHaveLength(
      1,
    );
  });

  it("covers the geometry exactly once across all features", () => {
    const features = rideFeatures(
      [segment(0, 1, "paved"), segment(1, 3, "gravel"), segment(3, 4, "walk")],
      geometry,
      meta,
    );
    const spans = features.reduce(
      (sum, f) => sum + f.geometry.coordinates.length - 1,
      0,
    );
    expect(spans).toBe(geometry.length - 1);
  });
});

describe("track colour expression", () => {
  it("reads the track's own colour, with a fallback", () => {
    const expression = trackColorExpression() as unknown[];
    // Colour is identity, never terrain: nothing in the expression may look at `ride`.
    expect(JSON.stringify(expression)).not.toContain("ride");
    expect(expression[0]).toBe("to-color");
    expect(expression[1]).toEqual(["get", "trackColor"]);
    expect(expression[2]).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("surface style table", () => {
  it("covers every ride class exactly once", () => {
    const rides = SURFACE_STYLE.map((s) => s.ride);
    expect(new Set(rides).size).toBe(rides.length);
    // Every class a segment can carry must have a symbol, or it draws as bare track
    // colour and silently claims to be paved.
    for (const ride of [
      "paved",
      "gravel",
      "rough",
      "walk",
      "ferry",
      "unknown",
    ] as const)
      expect(rides).toContain(ride);
  });

  it("leaves paved clean and marks everything else", () => {
    expect(surfaceStyle("paved").center).toBeNull();
    for (const s of SURFACE_STYLE.filter((s) => s.ride !== "paved"))
      expect(s.center, s.ride).not.toBeNull();
  });

  it("gets heavier as the going gets worse", () => {
    const weight = (ride: "gravel" | "rough" | "walk") =>
      surfaceStyle(ride).center!.weight;
    expect(weight("gravel")).toBeLessThan(weight("rough"));
    expect(weight("rough")).toBeLessThan(weight("walk"));
    // Denser hatching under the elevation curve, in the same order.
    const spacing = (ride: "gravel" | "rough" | "walk") =>
      surfaceStyle(ride).profile.spacing!;
    expect(spacing("gravel")).toBeGreaterThan(spacing("rough"));
    expect(spacing("rough")).toBeGreaterThan(spacing("walk"));
  });

  it("gives hike-a-bike a colour of its own under the profile", () => {
    // Everything else is hatched in the track's colour. A carry is the one thing the
    // profile has to shout about, so it does not inherit the track's identity.
    expect(surfaceStyle("walk").profile.color).toBe("#ff7043");
    for (const ride of ["gravel", "rough", "unknown"] as const)
      expect(surfaceStyle(ride).profile.color, ride).toBeUndefined();
  });

  it("falls back to a real style for an unrecognised class", () => {
    expect(surfaceStyle("nonsense" as never).ride).toBe("paved");
  });
});

describe("surface bands", () => {
  it("tiles the route end to end, merging repeats", () => {
    const bands = surfaceBands(
      [segment(0, 1, "paved"), segment(1, 2, "paved"), segment(2, 4, "walk")],
      400,
    );
    expect(bands.map((b) => b.ride)).toEqual(["paved", "walk"]);
    expect(bands[0].startM).toBe(0);
    expect(bands[0].endM).toBeCloseTo(200);
    expect(bands[1].endM).toBeCloseTo(400);
  });

  it("rescales spans to the router's own distance", () => {
    // Segment lengths are straight-line spans and run short of the measured distance;
    // the bands still have to end exactly where the elevation profile does.
    const bands = surfaceBands([segment(0, 2, "gravel")], 500);
    expect(bands).toHaveLength(1);
    expect(bands[0].endM).toBeCloseTo(500);
  });

  it("produces nothing without segments or distance", () => {
    expect(surfaceBands([], 100)).toEqual([]);
    expect(surfaceBands([segment(0, 2, "paved")], 0)).toEqual([]);
  });
});

describe("ride totals", () => {
  it("sums distance per class", () => {
    const totals = rideTotals([
      segment(0, 1, "paved"),
      segment(1, 2, "paved"),
      segment(2, 4, "walk"),
    ]);
    expect(totals.get("paved")).toBe(200);
    expect(totals.get("walk")).toBe(200);
    expect(totals.get("ferry")).toBeUndefined();
  });
});
