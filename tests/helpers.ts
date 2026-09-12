import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseProfile, type Profile } from "../src/routing/profiles";
import type { Graph } from "../src/routing/types";
import type { Level } from "../src/routing/vocabulary";

/** Load a shipped profile by id. Profiles are complete files, so this is the whole story. */
export const loadProfile = (id: string): Profile =>
  parseProfile(
    JSON.parse(
      readFileSync(
        new URL(`../profiles/${id}.profile.json`, import.meta.url),
        "utf8",
      ),
    ),
  );

export const GRAVEL = loadProfile("gravel_40");
export const ROAD = loadProfile("road_28");
export const TOURING = loadProfile("touring_45");
export const TRAIL = loadProfile("trail_60");
export const WANDERER = loadProfile("wanderer");
export const PROFILES = [GRAVEL, ROAD, TOURING, TRAIL, WANDERER];

/** A profile with some preferences overridden, for tests that vary one knob. */
export const withPreferences = (
  base: Profile,
  preferences: Partial<Record<keyof Profile["preferences"], Level>>,
): Profile =>
  parseProfile({
    ...base,
    preferences: { ...base.preferences, ...preferences },
  });

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
