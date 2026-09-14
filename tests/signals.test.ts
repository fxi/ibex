import { expect, it } from "vitest";
import { scoreEdge } from "../src/routing/engine";
import { edgeSignals } from "../src/routing/signals";
import type { Edge } from "../src/routing/types";
import { GRAVEL } from "./helpers";

const track = (tags: Record<string, string>, surface = "gravel"): Edge => ({
  id: 0,
  from: 0,
  to: 1,
  way: "tram",
  length: 100,
  geometry: [
    [5.654, 45.176],
    [5.655, 45.176],
  ],
  grades: null,
  surface,
  highway: "track",
  stress: 0.05,
  uncertainty: 0.1,
  utility: 0.5,
  urban: 0,
  cyclingNetwork: 0,
  reward: 0.3,
  bridge: false,
  tunnel: false,
  name: "",
  tile: "test",
  tags,
});

// The Ancienne Voie du Tram above Seyssins, as mapped.
const TRAM = {
  tracktype: "grade2",
  smoothness: "very_bad",
  "mtb:scale": "0",
  sac_scale: "hiking",
};

it("lets mtb:scale=0 overrule a smoothness that calls firm ground broken", () => {
  expect(edgeSignals(track(TRAM)).roughness).toBe(0.45);
  // Without the MTB grade, smoothness is still the best evidence there is.
  const { "mtb:scale": _, ...ungraded } = TRAM;
  expect(edgeSignals(track(ungraded)).roughness).toBe(0.65);
  // And the graded track costs a gravel bike a fraction of the roughness charge.
  expect(scoreEdge(track(TRAM), GRAVEL).roughness).toBeLessThan(
    scoreEdge(track(ungraded), GRAVEL).roughness / 4,
  );
});

it("never lets mtb:scale=0 smooth over the surface itself", () => {
  expect(edgeSignals(track(TRAM, "sand")).roughness).toBe(0.95);
  expect(
    edgeSignals(track({ ...TRAM, "mtb:scale": "1" })).roughness,
  ).toBe(0.65);
});
