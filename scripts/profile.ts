import fs from "node:fs/promises";
import { parseProfile, type Profile } from "../src/routing/profiles";

/** Load a shipped profile by id, for the dev scripts. */
export const loadProfile = async (id: string): Promise<Profile> =>
  parseProfile(
    JSON.parse(await fs.readFile(`profiles/${id}.profile.json`, "utf8")),
  );

export const PROFILE_IDS = [
  "road_28",
  "gravel_40",
  "touring_45",
  "trail_60",
  "wanderer",
];
