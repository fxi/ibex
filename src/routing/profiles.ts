import { z } from "zod";
import {
  LEVELS,
  SETTING_KEYS,
  SIGNAL_KEYS,
  type Level,
  type SettingKey,
  type SignalKey,
} from "./vocabulary";

/**
 * A profile is complete or it is not a profile.
 *
 * The previous format was a sparse overlay resolved master -> bike preset -> user, which
 * meant a shipped profile could be three lines long and mean nothing on its own: the
 * values that decided a route were somewhere else, and the form could only show them as
 * a greyed-out "inherited". Every field is required here, nothing is merged, and export
 * writes exactly what routed. A file is readable by whoever receives it.
 *
 * Format 3 separates whole-ride `settings` from way `preferences`, and states those for
 * `base` with optional `uphill` and `downhill` overrides.
 */
export const FORMAT_VERSION = 3;

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

/**
 * `steepness` defaults rather than being required, unlike every other setting.
 *
 * It was added after format 3 shipped, and a profile snapshot that fails to parse is not
 * a warning here: `restoreCollection` parses the whole track collection at once, so one
 * stored profile without the key would lose every saved track. A profile that predates
 * the setting means the rider never expressed an opinion about gradient, which is exactly
 * what `neutral` says. Every profile this repo ships states it outright.
 */
export const settingsSchema = z.strictObject(
  Object.fromEntries(
    SETTING_KEYS.map((k) => [
      k,
      k === "steepness" ? level.default("neutral") : level,
    ]),
  ) as Record<SettingKey, typeof level>,
);

const signalsSchema = z.strictObject(
  Object.fromEntries(SIGNAL_KEYS.map((k) => [k, level])) as Record<
    SignalKey,
    typeof level
  >,
);

export const preferencesSchema = z.strictObject({
  /** Every way preference, stated once. */
  base: signalsSchema,
  /** Only what changes on a climb. */
  uphill: signalsSchema.partial().default({}),
  /** Only what changes on a descent. */
  downhill: signalsSchema.partial().default({}),
});

export const permissionsSchema = z.strictObject({
  ferry: z.boolean(),
  /** Stairs, ramped or not. Always pushed or carried, never ridden. */
  stairs: z.boolean(),
  /** Hike-a-bike: may a stretch be walked when it cannot be ridden? */
  push: z.boolean(),
});

export const profileSchema = z.strictObject({
  format_version: z.literal(FORMAT_VERSION),
  /** Generated, never chosen: two people's "my_gravel" must not overwrite each other. */
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(400).default(""),
  setup: setupSchema,
  settings: settingsSchema,
  preferences: preferencesSchema,
  permissions: permissionsSchema,
});

export type Bike = z.infer<typeof bikeSchema>;
export type Rider = z.infer<typeof riderSchema>;
export type Setup = z.infer<typeof setupSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Permissions = z.infer<typeof permissionsSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;
export type Direction = "uphill" | "downhill";
export type Profile = z.infer<typeof profileSchema>;

const formatUuid = (bytes: Uint8Array) => {
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** A fresh random id (UUID v4). Works outside secure contexts, unlike `randomUUID`. */
export function newProfileId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return formatUuid(b);
}

/** Overrides that actually differ from `base`, in canonical key order. */
export function overrides(
  preferences: Preferences,
  direction: Direction,
): Partial<Record<SignalKey, Level>> {
  return Object.fromEntries(
    SIGNAL_KEYS.filter(
      (k) =>
        preferences[direction][k] !== undefined &&
        preferences[direction][k] !== preferences.base[k],
    ).map((k) => [k, preferences[direction][k]]),
  );
}

/**
 * Validate, canonicalize, then freeze all the way down.
 *
 * Routing reads a profile on every edge of every search. Freezing is cheap insurance
 * that nothing downstream mutates a value mid-route and produces a path that no single
 * set of settings would have produced. An override equal to `base` says nothing, and is
 * dropped so that two profiles meaning the same thing serialize the same.
 */
export function parseProfile(input: unknown): Profile {
  const value = profileSchema.parse(input);
  value.preferences = {
    base: Object.freeze(value.preferences.base),
    uphill: Object.freeze(overrides(value.preferences, "uphill")),
    downhill: Object.freeze(overrides(value.preferences, "downhill")),
  };
  Object.freeze(value.setup.bike);
  Object.freeze(value.setup.rider);
  Object.freeze(value.setup);
  Object.freeze(value.settings);
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
    settings: Object.fromEntries(
      SETTING_KEYS.map((k) => [k, profile.settings[k]]),
    ),
    preferences: {
      base: Object.fromEntries(
        SIGNAL_KEYS.map((k) => [k, profile.preferences.base[k]]),
      ),
      uphill: overrides(profile.preferences, "uphill"),
      downhill: overrides(profile.preferences, "downhill"),
    },
    permissions: {
      ferry: profile.permissions.ferry,
      stairs: profile.permissions.stairs,
      push: profile.permissions.push,
    },
  };
}

export const sameProfile = (a: Profile, b: Profile) =>
  serializeProfile(a) === serializeProfile(b);
