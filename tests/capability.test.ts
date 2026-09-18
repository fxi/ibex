import { describe, expect, it } from "vitest";
import {
  deriveCapability,
  exceedance,
  gearSpeed,
  powerRequired,
  rollingResistance,
  wheelCircumferenceM,
} from "../src/routing/capability";
import { BIKE_PRESETS, RIDER_PRESETS } from "../src/routing/presets";
import type { Bike, Rider } from "../src/routing/profiles";

const setup = (bike: string, rider: string, overrides: Partial<Bike> = {}) => ({
  preset: "test",
  bike: { ...BIKE_PRESETS[bike], ...overrides } as Bike,
  rider: RIDER_PRESETS[rider] as Rider,
});
const up = (bike: string, rider: string, overrides: Partial<Bike> = {}) =>
  deriveCapability(setup(bike, rider, overrides)).uphill_grade;

/**
 * The point of deriving grade capability rather than asking for it is that the answer
 * follows from things a rider can actually state — their gearing, their load, their
 * power. These check that it follows in the right direction and lands somewhere a
 * cyclist would recognise.
 */
describe("the climbing model", () => {
  it("balances power against gravity, rolling and air", () => {
    // 240 W at 90 kg on 10% should be walking-pace-ish, and the same speed on the flat
    // should cost a small fraction of it.
    const steep = powerRequired(1.8, 0.1, 90, 0.005);
    const flat = powerRequired(1.8, 0, 90, 0.005);
    expect(steep).toBeGreaterThan(150);
    expect(steep).toBeLessThan(200);
    expect(flat).toBeLessThan(steep / 10);
    // Power rises monotonically with grade, which is what makes the search for a
    // threshold a simple bisection.
    for (let g = 0; g < 0.4; g += 0.05)
      expect(powerRequired(2, g + 0.05, 90, 0.005)).toBeGreaterThan(
        powerRequired(2, g, 90, 0.005),
      );
  });

  it("lands where a cyclist would put it", () => {
    const gravel = up("gravel_40", "expert");
    expect(gravel.comfortable_until).toBeGreaterThan(0.07);
    expect(gravel.comfortable_until).toBeLessThan(0.13);
    expect(gravel.high_cost_at).toBeGreaterThan(0.17);
    expect(gravel.high_cost_at).toBeLessThan(0.27);
    for (const bike of Object.keys(BIKE_PRESETS))
      for (const rider of Object.keys(RIDER_PRESETS)) {
        const t = up(bike, rider);
        expect(t.high_cost_at, `${bike}/${rider}`).toBeGreaterThan(
          t.comfortable_until,
        );
        expect(t.comfortable_until, `${bike}/${rider}`).toBeGreaterThan(0.02);
      }
  });

  it("rewards lower gearing, which is the whole reason to model it", () => {
    // Same rider, same mass, one gear lower: the hill gets easier. `max_grade_up` could
    // never say this, because it was a number the rider had to invent.
    const tall = up("gravel_40", "expert", { lowest_gear_ratio: 1.1 });
    const low = up("gravel_40", "expert", { lowest_gear_ratio: 0.6 });
    expect(low.comfortable_until).toBeGreaterThan(tall.comfortable_until);
    expect(low.high_cost_at).toBeGreaterThan(tall.high_cost_at);
  });

  it("punishes weight, and luggage more than the bike", () => {
    const light = up("touring_45", "steady", { load_kg: 0 });
    const loaded = up("touring_45", "steady", { load_kg: 30 });
    expect(loaded.comfortable_until).toBeLessThan(light.comfortable_until);

    const heavy = deriveCapability(setup("gravel_40", "expert", { load_kg: 25 }));
    const empty = deriveCapability(setup("gravel_40", "expert", { load_kg: 0 }));
    expect(heavy.surface_roughness.comfortable_until).toBeLessThan(
      empty.surface_roughness.comfortable_until,
    );
    expect(heavy.technical_up.comfortable_until).toBeLessThan(
      empty.technical_up.comfortable_until,
    );
  });

  it("rewards fitness monotonically", () => {
    const grades = ["casual", "steady", "expert", "pro"].map(
      (r) => up("gravel_40", r).comfortable_until,
    );
    for (let i = 1; i < grades.length; i++)
      expect(grades[i]).toBeGreaterThan(grades[i - 1]);
  });

  it("derives wheel size and rolling resistance from the tire", () => {
    expect(wheelCircumferenceM(40)).toBeCloseTo(Math.PI * 0.702, 3);
    expect(wheelCircumferenceM(60)).toBeGreaterThan(wheelCircumferenceM(28));
    expect(rollingResistance(28)).toBeLessThan(rollingResistance(50));
    // 0.85 x 2.2 m per revolution at 60 rpm is a bit under 7 km/h.
    expect(gearSpeed(BIKE_PRESETS.gravel_40, 60) * 3.6).toBeCloseTo(6.7, 1);
    expect(gearSpeed(BIKE_PRESETS.gravel_40, 40)).toBeLessThan(
      gearSpeed(BIKE_PRESETS.gravel_40, 60),
    );
  });
});

describe("the handling heuristics", () => {
  it("follows confidence, tires and suspension downhill", () => {
    const timid = deriveCapability(setup("gravel_40", "casual")).downhill_grade;
    const bold = deriveCapability(setup("gravel_40", "pro")).downhill_grade;
    expect(bold.comfortable_until).toBeGreaterThan(timid.comfortable_until);

    const rigid = deriveCapability(setup("mtb_60", "expert")).downhill_grade;
    const sprung = deriveCapability(setup("mtb_full_60", "expert")).downhill_grade;
    expect(sprung.comfortable_until).toBeGreaterThan(rigid.comfortable_until);
  });

  it("lets wide tires shrug off surfaces that stop narrow ones", () => {
    const road = deriveCapability(setup("road_28", "expert")).surface_roughness;
    const mtb = deriveCapability(setup("mtb_60", "expert")).surface_roughness;
    expect(mtb.comfortable_until).toBeGreaterThan(road.comfortable_until * 2);
  });

  it("makes luggage reduce technical capability", () => {
    const empty = deriveCapability(setup("gravel_50", "expert"));
    const loaded = deriveCapability(
      setup("gravel_50", "expert", { load_kg: 18 }),
    );
    expect(loaded.technical_up.comfortable_until).toBeLessThan(
      empty.technical_up.comfortable_until,
    );
    expect(loaded.technical_down.comfortable_until).toBeLessThan(
      empty.technical_down.comfortable_until,
    );
  });
});

describe("the threshold ramp", () => {
  const t = { comfortable_until: 0.1, high_cost_at: 0.2 };

  it("charges nothing up to comfortable, and 1 at high cost", () => {
    expect(exceedance(0.05, t)).toBe(0);
    expect(exceedance(0.1, t)).toBe(0);
    expect(exceedance(0.2, t)).toBeCloseTo(1, 6);
  });

  it("starts gently and steepens, and never saturates", () => {
    const a = exceedance(0.125, t),
      b = exceedance(0.15, t),
      c = exceedance(0.175, t);
    expect(a).toBeGreaterThan(0);
    expect(b - a).toBeGreaterThan(0);
    expect(c - b).toBeGreaterThan(b - a);
    // Past high_cost_at it keeps climbing rather than flattening, so absurd ground is
    // strongly discouraged — but it stays finite, so it is never impossible.
    expect(exceedance(0.4, t)).toBeGreaterThan(exceedance(0.3, t));
    expect(Number.isFinite(exceedance(1, t))).toBe(true);
  });
});
