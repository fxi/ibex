import { expect, it } from "vitest";
import { cycleInfrastructure, scoreEdge, total } from "../src/routing/engine";
import { traversalSegments } from "../src/routing/eligibility";
import { edgeSignals } from "../src/routing/signals";
import type { Edge } from "../src/routing/types";
import { GRAVEL, loadProfile, TRAIL } from "./helpers";

// Regressions found by matching a hand-drawn Geneva → Hyères bikepacking route
// (data/tracks/reference/geneve_mediterranean.gpx) against the Geneva–Toulon release.
const way = (
  highway: string,
  surface: string,
  tags: Record<string, string> = {},
  extra: Partial<Edge> = {},
): Edge => ({
  id: 0,
  from: 0,
  to: 1,
  way: "w",
  length: 100,
  geometry: [
    [6.1, 45.1],
    [6.101, 45.1],
  ],
  grades: null,
  surface,
  highway,
  stress: 0.08,
  uncertainty: 0.1,
  utility: 0.5,
  urban: 0,
  cyclingNetwork: 0,
  reward: 0,
  bridge: false,
  tunnel: false,
  name: "",
  tile: "test",
  tags,
  ...extra,
});

it("reads packed earth on a solid track as gravel, not as a loose trail", () => {
  expect(edgeSignals(way("track", "dirt", { tracktype: "grade2" })).roughness).toBe(0.45);
  expect(edgeSignals(way("track", "ground", { tracktype: "grade1" })).roughness).toBe(0.45);
  // Smoothness still speaks for the surface, and loose material stays loose.
  expect(
    edgeSignals(way("track", "dirt", { tracktype: "grade2", smoothness: "very_bad" })).roughness,
  ).toBe(0.65);
  expect(edgeSignals(way("track", "sand", { tracktype: "grade2" })).roughness).toBe(0.95);
  expect(edgeSignals(way("track", "dirt")).roughness).toBe(0.6);
});

it("splits the difference when a gravel surface and a rough tracktype disagree", () => {
  expect(
    edgeSignals(way("track", "fine_gravel", { tracktype: "grade4" })).roughness,
  ).toBeCloseTo((0.22 + 0.65) / 2);
  expect(edgeSignals(way("track", "unknown", { tracktype: "grade4" })).roughness).toBe(0.65);
});

it("does not treat a designated or smoothness-surveyed path as unsurveyed", () => {
  expect(edgeSignals(way("footway", "fine_gravel")).technicalUp).toBe(0.25);
  expect(
    edgeSignals(way("footway", "fine_gravel", { bicycle: "designated" })).technicalUp,
  ).toBe(0);
  expect(edgeSignals(way("path", "gravel", { smoothness: "good" })).technicalUp).toBe(0);
});

it("counts ways built for bikes as cycle infrastructure below a signed route", () => {
  expect(cycleInfrastructure(way("cycleway", "paved"))).toBe(0.8);
  expect(cycleInfrastructure(way("path", "paved", { bicycle: "designated" }))).toBe(0.8);
  expect(cycleInfrastructure(way("path", "paved", {}, { cyclingNetwork: 1 }))).toBe(1);
  expect(cycleInfrastructure(way("residential", "paved"))).toBe(0);
});

it("stops riding difficulty compounding on a push known to walk easily", () => {
  const push = (tags: Record<string, string>, extra: Partial<Edge> = {}) =>
    way("path", "gravel", { "mtb:scale:uphill": "4", ...tags }, { grades: [[100, 0.2]], ...extra });
  const unsurveyed = push({});
  expect(traversalSegments(unsurveyed, GRAVEL).every((s) => s.mode === "walk")).toBe(true);
  const hiking = total(scoreEdge(push({ sac_scale: "hiking" }), GRAVEL));
  const signed = total(scoreEdge(push({}, { cyclingNetwork: 1 }), GRAVEL));
  const plain = total(scoreEdge(unsurveyed, GRAVEL));
  expect(hiking).toBeLessThan(plain);
  expect(signed).toBeLessThan(plain);
  // Still a harder push than easier ground on the same terms.
  expect(total(scoreEdge(push({ sac_scale: "hiking", "mtb:scale:uphill": "5" }), GRAVEL))).toBeGreaterThan(hiking);
});

it("makes technical ground harder on a climb past what the rider climbs comfortably", () => {
  // The Chemin rural dit du Sel near Esery: `mtb:scale:uphill=2` at 7-14%. A loaded gravel
  // bike rides that ground on the flat and pushes it up a steep climb; a low-geared trail
  // bike still has the momentum to clear it.
  const bikepacking = loadProfile("bikepacking_45");
  const climb = (grade: number) =>
    way("track", "ground", { "mtb:scale:uphill": "2" }, { grades: [[100, grade]] });
  const modes = (grade: number, profile: typeof TRAIL) =>
    traversalSegments(climb(grade), profile).map((s) => s.mode);
  expect(modes(0.04, bikepacking)).toEqual(["ride"]);
  expect(modes(0.12, bikepacking)).toEqual(["walk"]);
  expect(modes(0.12, TRAIL)).toEqual(["ride"]);
  expect(scoreEdge(climb(0.12), TRAIL).technical).toBe(
    scoreEdge(climb(0.04), TRAIL).technical,
  );
});
