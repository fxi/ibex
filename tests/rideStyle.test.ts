import { describe, expect, it } from "vitest";
import {
  RIDE_STYLE,
  rideColorExpression,
  rideFeatures,
  rideTotals,
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
      expect(f.properties.color).toMatch(/^#[0-9a-f]{6}$/i);
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

describe("ride colour expression", () => {
  it("names every class in the table, with a fallback", () => {
    const expression = rideColorExpression() as unknown[];
    expect(expression[0]).toBe("case");
    for (const { ride, color } of RIDE_STYLE) {
      const at = expression.findIndex(
        (part) =>
          Array.isArray(part) &&
          part[0] === "==" &&
          Array.isArray(part[1]) &&
          part[1][1] === "ride" &&
          part[2] === ride,
      );
      expect(at, ride).toBeGreaterThan(0);
      expect(expression[at + 1]).toBe(color);
    }
    // Last element is the fallback colour, not a condition.
    expect(typeof expression.at(-1)).toBe("string");
    expect(expression.length).toBe(RIDE_STYLE.length * 2 + 2);
  });

  it("gives every class a distinct colour", () => {
    const colors = RIDE_STYLE.map((s) => s.color);
    expect(new Set(colors).size).toBe(colors.length);
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
