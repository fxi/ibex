import { BIKE_PRESET_IDS, RIDER_PRESET_IDS } from "./presets";
import type { Bike, Rider } from "./profiles";
import {
  SETTING_KEYS,
  SIGNAL_KEYS,
  type SettingKey,
  type SignalKey,
} from "./vocabulary";

/**
 * What the setup form draws, and the only place a control's bounds are written twice.
 *
 * `tests/profileFields.test.ts` asserts these keys match the schema exactly, so a field
 * added to a profile without a control here — or the reverse — fails the build rather
 * than quietly disappearing from the form.
 */
export type NumberField<T> = {
  key: keyof T & string;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
};

export const BIKE_FIELDS: NumberField<Bike>[] = [
  {
    key: "tire_mm",
    label: "Tire width",
    hint: "Sets rolling resistance and how much rough ground the bike shrugs off.",
    min: 18,
    max: 110,
    step: 1,
    unit: "mm",
  },
  {
    key: "mass_kg",
    label: "Bike weight",
    hint: "Frame, wheels and fittings, without luggage.",
    min: 4,
    max: 40,
    step: 0.5,
    unit: "kg",
  },
  {
    key: "lowest_gear_ratio",
    label: "Lowest gear",
    hint: "Chainring teeth over largest cog: 34/40 is 0.85. Decides the steepest grade you can still turn over.",
    min: 0.2,
    max: 3,
    step: 0.01,
  },
  {
    key: "load_kg",
    label: "Luggage",
    hint: "Bags and water. Heavy loads cost more on rough and technical ground than on a gradient.",
    min: 0,
    max: 60,
    step: 0.5,
    unit: "kg",
  },
];

export const RIDER_FIELDS: NumberField<Rider>[] = [
  {
    key: "mass_kg",
    label: "Rider weight",
    hint: "With clothing and shoes.",
    min: 30,
    max: 200,
    step: 1,
    unit: "kg",
  },
  {
    key: "sustained_w_per_kg",
    label: "Sustained power",
    hint: "Watts per kilo held for the length of a climb. About 1.9 casual, 3.2 strong, 4.3 racing.",
    min: 0.8,
    max: 7,
    step: 0.1,
    unit: "W/kg",
  },
  {
    key: "tech_skill",
    label: "Technical skill",
    hint: "Handling on loose, steep or broken ground.",
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: "descend_confidence",
    label: "Descending",
    hint: "Willingness to let the bike run downhill. Independent of fitness.",
    min: 0,
    max: 1,
    step: 0.05,
  },
];

export const SUSPENSION_OPTIONS: {
  value: Bike["suspension"];
  label: string;
}[] = [
  { value: "none", label: "Rigid" },
  { value: "front", label: "Front" },
  { value: "full", label: "Full" },
];

export const BIKE_OPTIONS = BIKE_PRESET_IDS;
export const RIDER_OPTIONS = RIDER_PRESET_IDS;

type Field<K> = { key: K; label: string; hint: string };

export const SETTING_FIELDS: Field<SettingKey>[] = [
  {
    key: "detour",
    label: "Detour",
    hint: "How much further you will ride for everything below. This decides how far the route wanders for a better line; only avoiding traffic can push it further.",
  },
  {
    key: "climbing",
    label: "Climbing",
    hint: "Whether height gain is the point or the price. Adds up over the whole ride.",
  },
  {
    key: "steepness",
    label: "Steepness",
    hint: "How the height is gained, apart from how much of it there is. Avoiding it takes the gentler way up the same hill, and the gentler way down.",
  },
  {
    key: "direction_changes",
    label: "Turns",
    hint: "Changing direction at intersections takes attention. Avoiding it prefers a straight line over a zigzag through side streets.",
  },
];

export const SIGNAL_FIELDS: Field<SignalKey>[] = [
  {
    key: "traffic_stress",
    label: "Traffic",
    hint: "Estimated from road class and cycle infrastructure in the pack, not from live traffic. Avoiding it keeps you off main roads even at a small detour.",
  },
  {
    key: "unpaved",
    label: "Unpaved",
    hint: "Gravel, track and dirt, where the surface is actually mapped. Unsurveyed ways are never assumed to be gravel.",
  },
  {
    key: "surface_difficulty",
    label: "Difficult ground",
    hint: "The worse of how broken the surface is and its mapped MTB or hiking difficulty, judged in the direction you ride.",
  },
  {
    key: "scenic",
    label: "Scenery",
    hint: "Proximity to viewpoints, peaks, forest and good ground. Selects between lines; it will not invent landmarks.",
  },
  {
    key: "urbanity",
    label: "Built-up",
    hint: "How built-up the surroundings are, from land use and settlement density. A quiet suburban street is still urban.",
  },
  {
    key: "cycle_infrastructure",
    label: "Cycle routes",
    hint: "Membership of mapped cycle and MTB route relations.",
  },
];

export const PERMISSION_FIELDS: {
  key: "ferry" | "stairs" | "push";
  label: string;
  hint: string;
}[] = [
  {
    key: "ferry",
    label: "Ferries",
    hint: "Mapped bicycle ferries. Schedules are not checked — confirm seasons and departures.",
  },
  {
    key: "stairs",
    label: "Stairs",
    hint: "Carrying the bike up or down steps. Allowed either way; refusing only makes them a last resort.",
  },
  {
    key: "push",
    label: "Pushing",
    hint: "Walking the bike where it cannot be ridden. Refusing makes pushing very expensive, never impossible.",
  },
];

export { SETTING_KEYS, SIGNAL_KEYS };
