import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseProfile, type Profile } from "../src/routing/profiles";
import { shippedProfiles } from "../src/models";
import type { Graph } from "../src/routing/types";
import {
  SETTING_KEYS,
  type Level,
  type SettingKey,
  type SignalKey,
} from "../src/routing/vocabulary";

/**
 * Load a profile by id: a shipped one, or one kept only as a test fixture. Profiles are
 * complete files, so this is the whole story.
 */
export const loadProfile = (id: string): Profile => {
  const shipped = new URL(`../profiles/${id}.profile.json`, import.meta.url);
  const fixture = new URL(
    `./fixtures/profiles/${id}.profile.json`,
    import.meta.url,
  );
  return parseProfile(
    JSON.parse(readFileSync(existsSync(shipped) ? shipped : fixture, "utf8")),
  );
};

export const GRAVEL = loadProfile("gravel_40");
export const ROAD = loadProfile("road_28");
export const TOURING = loadProfile("touring_45");
export const TRAIL = loadProfile("trail_60");
export const WANDERER = loadProfile("wanderer");
/**
 * A deliberately varied set for tests that want several different riders. Three of these
 * are fixtures, so it is *not* what the app ships — use SHIPPED for that. Conflating the
 * two left the default profile untested by everything claiming to cover "every shipped
 * profile".
 */
export const PROFILES = [GRAVEL, ROAD, TOURING, TRAIL, WANDERER];

/** Exactly what the app ships, read the way the app reads it. */
export const SHIPPED: Profile[] = shippedProfiles();

/**
 * A profile with some settings or base preferences overridden, for tests that vary one
 * knob. Keys are routed to `settings` or `preferences.base` by name.
 */
export const withPreferences = (
  base: Profile,
  changes: Partial<Record<SettingKey | SignalKey, Level>>,
): Profile => {
  const settings: Record<string, Level> = { ...base.settings };
  const signals: Record<string, Level> = { ...base.preferences.base };
  for (const [key, level] of Object.entries(changes))
    if ((SETTING_KEYS as readonly string[]).includes(key)) settings[key] = level;
    else signals[key] = level;
  return parseProfile({
    ...base,
    settings,
    preferences: { ...base.preferences, base: signals },
  });
};

export const withPermissions = (
  base: Profile,
  permissions: Partial<Profile["permissions"]>,
): Profile =>
  parseProfile({
    ...base,
    permissions: { ...base.permissions, ...permissions },
  });

export const withSetup = (
  base: Profile,
  setup: Partial<Profile["setup"]>,
): Profile => parseProfile({ ...base, setup: { ...base.setup, ...setup } });

export const voironsGraph = (): Graph =>
  JSON.parse(
    gunzipSync(
      readFileSync(
        new URL("./fixtures/voirons-graph.json.gz", import.meta.url),
      ),
    ).toString(),
  );
