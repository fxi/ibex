/**
 * Seed values for the setup form — and nothing else.
 *
 * A profile never references a preset at routing time. Picking one here copies its
 * numbers into the profile, which is what lets a saved file mean the same thing next
 * year, on someone else's machine, after this table has moved on. `setup.preset` keeps
 * the name only so the form can show where the numbers came from.
 */
import type { Bike, Rider } from "../profiles";

export const BIKE_PRESETS: Record<string, Bike> = {
  road_28: {
    tire_mm: 28,
    mass_kg: 8.5,
    lowest_gear_ratio: 1.0,
    suspension: "none",
    load_kg: 1,
  },
  gravel_40: {
    tire_mm: 40,
    mass_kg: 11.5,
    lowest_gear_ratio: 0.85,
    suspension: "none",
    load_kg: 3,
  },
  gravel_50: {
    tire_mm: 50,
    mass_kg: 12.5,
    lowest_gear_ratio: 0.7,
    suspension: "none",
    load_kg: 3,
  },
  touring_45: {
    tire_mm: 45,
    mass_kg: 15,
    lowest_gear_ratio: 0.6,
    suspension: "none",
    load_kg: 18,
  },
  mtb_60: {
    tire_mm: 60,
    mass_kg: 13.5,
    lowest_gear_ratio: 0.52,
    suspension: "front",
    load_kg: 2,
  },
  mtb_full_60: {
    tire_mm: 60,
    mass_kg: 14.5,
    lowest_gear_ratio: 0.52,
    suspension: "full",
    load_kg: 2,
  },
};

export const RIDER_PRESETS: Record<string, Rider> = {
  casual: {
    mass_kg: 78,
    sustained_w_per_kg: 1.9,
    tech_skill: 0.25,
    descend_confidence: 0.3,
  },
  steady: {
    mass_kg: 75,
    sustained_w_per_kg: 2.5,
    tech_skill: 0.45,
    descend_confidence: 0.5,
  },
  expert: {
    mass_kg: 75,
    sustained_w_per_kg: 3.2,
    tech_skill: 0.7,
    descend_confidence: 0.7,
  },
  pro: {
    mass_kg: 70,
    sustained_w_per_kg: 4.3,
    tech_skill: 0.9,
    descend_confidence: 0.9,
  },
};

export const BIKE_PRESET_IDS = Object.keys(BIKE_PRESETS);
export const RIDER_PRESET_IDS = Object.keys(RIDER_PRESETS);

/** The label a form shows once a value has been hand-edited away from every preset. */
export const CUSTOM = "custom";

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

export function matchBike(bike: Bike): string {
  for (const [id, preset] of Object.entries(BIKE_PRESETS))
    if (
      near(preset.tire_mm, bike.tire_mm) &&
      near(preset.mass_kg, bike.mass_kg) &&
      near(preset.lowest_gear_ratio, bike.lowest_gear_ratio) &&
      near(preset.load_kg, bike.load_kg) &&
      preset.suspension === bike.suspension
    )
      return id;
  return CUSTOM;
}

export function matchRider(rider: Rider): string {
  for (const [id, preset] of Object.entries(RIDER_PRESETS))
    if (
      near(preset.mass_kg, rider.mass_kg) &&
      near(preset.sustained_w_per_kg, rider.sustained_w_per_kg) &&
      near(preset.tech_skill, rider.tech_skill) &&
      near(preset.descend_confidence, rider.descend_confidence)
    )
      return id;
  return CUSTOM;
}
