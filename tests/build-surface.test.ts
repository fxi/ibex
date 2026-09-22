/**
 * The raster surfaces.
 *
 * These are approximations on purpose — a stress proxy, not a measurement — so the
 * assertions are about behaviour, not about agreeing with any particular number. Whether
 * the signals are *right* is settled by the gold routes in `tests/fixtures/gold/`, which is
 * the only place that knows what a good line looks like.
 */
import { describe, expect, it } from "vitest";
import { Surface, type BBox } from "../src/build/surface";
import { urbanFraction } from "../src/build/layers";
import type { Point } from "../src/routing/types";

/** A square degree-ish patch near Geneva, so the metre scaling is realistic. */
const BOX: BBox = [6.0, 46.0, 6.1, 46.1];
const square = (w: number, s: number, e: number, n: number): Point[] => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

describe("Surface", () => {
  it("sizes itself in metres, not degrees", () => {
    const surface = new Surface(BOX, 10);
    // 0.1 degrees of latitude is ~11.1 km, so ~1,110 pixels at 10 m.
    expect(surface.height).toBeGreaterThan(1050);
    expect(surface.height).toBeLessThan(1170);
    // Longitude is shorter at 46 N, so the raster is narrower than it is tall.
    expect(surface.width).toBeLessThan(surface.height);
  });

  it("fills a polygon and reads it back", () => {
    const surface = new Surface(BOX, 10);
    surface.fill([square(6.02, 46.02, 6.04, 46.04)]);
    expect(surface.sample([6.03, 46.03])).toBe(1);
    expect(surface.sample([6.06, 46.06])).toBe(0);
  });

  it("leaves a hole empty, by even-odd over every ring", () => {
    const surface = new Surface(BOX, 10);
    surface.fill([square(6.02, 46.02, 6.06, 46.06), square(6.03, 46.03, 6.05, 46.05)]);
    expect(surface.sample([6.025, 46.025])).toBe(1);
    expect(surface.sample([6.04, 46.04])).toBe(0);
  });

  it("reports the fraction of a line that crosses a filled area", () => {
    const surface = new Surface(BOX, 10);
    // Fill the western half of the box; a line spanning it should read about half.
    surface.fill([square(6.0, 46.0, 6.05, 46.1)]);
    const fraction = surface.sampleLine([
      [6.001, 46.05],
      [6.099, 46.05],
    ]);
    expect(fraction).toBeGreaterThan(0.45);
    expect(fraction).toBeLessThan(0.55);
  });

  it("gives a zero-length line the ground it stands on", () => {
    const surface = new Surface(BOX, 10);
    surface.fill([square(6.02, 46.02, 6.04, 46.04)]);
    expect(surface.sampleLine([[6.03, 46.03]])).toBe(1);
    expect(
      surface.sampleLine([
        [6.03, 46.03],
        [6.03, 46.03],
      ]),
    ).toBe(1);
  });

  it("stamps a disc of the radius asked for", () => {
    const surface = new Surface(BOX, 10);
    surface.stamp([6.05, 46.05], 500);
    expect(surface.sample([6.05, 46.05])).toBe(1);
    // ~300 m north is inside, ~900 m north is not.
    expect(surface.sample([6.05, 46.0527])).toBe(1);
    expect(surface.sample([6.05, 46.058])).toBe(0);
  });

  it("grows filled areas by dilation, and leaves an empty surface empty", () => {
    const surface = new Surface(BOX, 10);
    surface.fill([square(6.02, 46.02, 6.04, 46.04)]);
    expect(surface.sample([6.04026, 46.03])).toBe(0);
    surface.dilate(40);
    expect(surface.sample([6.04026, 46.03])).toBe(1);

    const empty = new Surface(BOX, 10);
    empty.dilate(40);
    expect(empty.values.some((v) => v !== 0)).toBe(false);
  });

  it("reads nothing outside its own bounds rather than wrapping", () => {
    const surface = new Surface(BOX, 10);
    surface.fill([square(6.0, 46.0, 6.1, 46.1)]);
    expect(surface.sample([5.9, 45.9])).toBe(0);
    expect(surface.sample([6.2, 46.2])).toBe(0);
  });
});

describe("urbanFraction", () => {
  it("trusts the highway tag over the land use around it", () => {
    const empty = new Surface(BOX, 10);
    expect(urbanFraction([[6.05, 46.05]], { highway: "residential" }, empty)).toBe(1);
    expect(urbanFraction([[6.05, 46.05]], { highway: "living_street" }, empty)).toBe(1);
    expect(urbanFraction([[6.05, 46.05]], { highway: "track" }, empty)).toBe(0);
  });
});
