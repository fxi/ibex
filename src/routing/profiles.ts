import { z } from "zod";
import { LEVELS, PREFERENCE_KEYS, type PreferenceKey } from "./vocabulary";

/**
 * A profile is complete or it is not a profile.
 *
 * The previous format was a sparse overlay resolved master -> bike preset -> user, which
 * meant a shipped profile could be three lines long and mean nothing on its own: the
 * values that decided a route were somewhere else, and the form could only show them as
 * a greyed-out "inherited". Every field is required here, nothing is merged, and export
 * writes exactly what routed. A file is readable by whoever receives it.
 */
export const FORMAT_VERSION = 2;

const unit = z.number().min(0).max(1);
const level = z.enum(LEVELS);

export const bikeSchema = z.strictObject({
  /** Nominal tire width. Drives rolling resistance, roughness tolerance, wheel size. */
  tire_mm: z.number().min(18).max(110),
  /** Frame, wheels and everything bolted on, without luggage. */
  mass_kg: z.number().min(4).max(40),
  /**
   * Chainring teeth over largest cog — 34/40 is 0.85. The single most important number
   * for whether a steep climb is rideable, and the one riders most often cannot name;
   * the presets carry sensible values per bike type.
   */
  lowest_gear_ratio: z.number().min(0.2).max(3),
  suspension: z.enum(["none", "front", "full"]),
  /** Luggage and water. Separate from bike mass because it is the field riders change. */
  load_kg: z.number().min(0).max(60),
});

export const riderSchema = z.strictObject({
  mass_kg: z.number().min(30).max(200),
  /**
   * Power a rider holds for the length of a climb, per kilo of rider. Roughly FTP/mass;
   * 1.9 is a casual rider, 3.2 a strong amateur, 4.3 a racer.
   */
  sustained_w_per_kg: z.number().min(0.8).max(7),
  /** Handling on technical ground, 0 to 1. */
  tech_skill: unit,
  /** Willingness to let the bike run downhill, 0 to 1. Independent of fitness. */
  descend_confidence: unit,
});

export const setupSchema = z.strictObject({
  /**
   * Where the numbers below came from. A label for the form, never resolved at routing
   * time — so this profile cannot change meaning when the preset table does.
   */
  preset: z.string().trim().min(1).max(60),
  bike: bikeSchema,
  rider: riderSchema,
});

const preferencesSchema = z.strictObject(
  Object.fromEntries(PREFERENCE_KEYS.map((k) => [k, level])) as Record<
    PreferenceKey,
    typeof level
  >,
);

export const permissionsSchema = z.strictObject({
  ferry: z.boolean(),
  /** Stairs, ramped or not. Always pushed or carried, never ridden. */
  stairs: z.boolean(),
  /** Hike-a-bike: may a stretch be walked when it cannot be ridden? */
  push: z.boolean(),
});

export const profileSchema = z.strictObject({
  format_version: z.literal(FORMAT_VERSION),
  id: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, - and _"),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(400).default(""),
  setup: setupSchema,
  preferences: preferencesSchema,
  permissions: permissionsSchema,
});

export type Bike = z.infer<typeof bikeSchema>;
export type Rider = z.infer<typeof riderSchema>;
export type Setup = z.infer<typeof setupSchema>;
export type Permissions = z.infer<typeof permissionsSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;
export type Profile = z.infer<typeof profileSchema>;

/**
 * Parse, then freeze all the way down.
 *
 * Routing reads a profile on every edge of every search. Freezing is cheap insurance
 * that nothing downstream mutates a value mid-route and produces a path that no single
 * set of settings would have produced.
 */
export function parseProfile(input: unknown): Profile {
  const value = profileSchema.parse(input);
  Object.freeze(value.setup.bike);
  Object.freeze(value.setup.rider);
  Object.freeze(value.setup);
  Object.freeze(value.preferences);
  Object.freeze(value.permissions);
  return Object.freeze(value);
}

export const isProfile = (input: unknown): input is Profile =>
  profileSchema.safeParse(input).success;

/**
 * One canonical field order for the whole app.
 *
 * Two places compare profiles by `JSON.stringify` equality to decide whether a track is
 * still on a named model. Key order is part of that string, so it cannot be left to
 * whichever object literal happened to build the value.
 */
export function serializeProfile(profile: Profile): string {
  return JSON.stringify(orderProfile(profile), null, 2);
}

export function orderProfile(profile: Profile) {
  return {
    format_version: profile.format_version,
    id: profile.id,
    name: profile.name,
    description: profile.description,
    setup: {
      preset: profile.setup.preset,
      bike: {
        tire_mm: profile.setup.bike.tire_mm,
        mass_kg: profile.setup.bike.mass_kg,
        lowest_gear_ratio: profile.setup.bike.lowest_gear_ratio,
        suspension: profile.setup.bike.suspension,
        load_kg: profile.setup.bike.load_kg,
      },
      rider: {
        mass_kg: profile.setup.rider.mass_kg,
        sustained_w_per_kg: profile.setup.rider.sustained_w_per_kg,
        tech_skill: profile.setup.rider.tech_skill,
        descend_confidence: profile.setup.rider.descend_confidence,
      },
    },
    preferences: Object.fromEntries(
      PREFERENCE_KEYS.map((k) => [k, profile.preferences[k]]),
    ),
    permissions: {
      ferry: profile.permissions.ferry,
      stairs: profile.permissions.stairs,
      push: profile.permissions.push,
    },
  };
}

export const sameProfile = (a: Profile, b: Profile) =>
  serializeProfile(a) === serializeProfile(b);
