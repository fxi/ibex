import fs from "node:fs/promises";
import { parseProfile, type Profile } from "../src/routing/profiles";

/** Load a shipped or test-fixture profile by id, for the dev scripts. */
export const loadProfile = async (id: string): Promise<Profile> => {
  const shipped = `profiles/${id}.profile.json`;
  const path = await fs
    .access(shipped)
    .then(() => shipped)
    .catch(() => `tests/fixtures/profiles/${id}.profile.json`);
  return parseProfile(JSON.parse(await fs.readFile(path, "utf8")));
};

/** Kept in step with `profiles/*.profile.json`; tests/profiles.test.ts holds that set. */
export const SHIPPED_IDS = [
  "gravel_50",
  "gravel_50_bikepacking",
  "trail_60",
  "road_28",
];

export const PROFILE_IDS = [
  ...SHIPPED_IDS,
  "gravel_40",
  "touring_45",
  "wanderer",
];
