import { preference, savePreference } from "./offline/store";
import { parseProfile, type Profile } from "./routing/profiles";

/** The shipped Gravel profile (`profiles/gravel_50.profile.json`) starts every new track. */
export const DEFAULT_PROFILE_ID = "02aae4ad-e71c-4cd4-b24a-da1e9f145ab2";

/**
 * Every `*.profile.json` in `profiles/` ships with the app. There is no master file and
 * no preset filter any more: each of these is a complete, self-contained profile, which
 * is the whole point of the format.
 */
const files = import.meta.glob("../profiles/*.profile.json", {
  eager: true,
  import: "default",
});

export const shippedProfiles = (): Profile[] =>
  Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, p]) => parseProfile(p));

export const defaultProfile = (): Profile =>
  shippedProfiles().find((p) => p.id === DEFAULT_PROFILE_ID) ??
  shippedProfiles()[0];

export async function loadModels(): Promise<Profile[]> {
  const value = await preference<unknown>("routing-profiles");
  if (value !== undefined && !Array.isArray(value))
    throw new Error("Saved profile collection is invalid.");
  // Profiles saved in the old sparse format cannot be converted: their meaning lived in
  // a master file and a bike preset that no longer exist. Drop them rather than guess.
  const local: Profile[] = [];
  let dropped = 0;
  for (const entry of (value ?? []) as unknown[]) {
    try {
      local.push(parseProfile(entry));
    } catch {
      dropped++;
    }
  }
  if (dropped)
    console.warn(
      `Discarded ${dropped} profile(s) in an older, unconvertible format.`,
    );
  const shipped = shippedProfiles();
  return [
    ...shipped.filter((p) => !local.some((q) => q.id === p.id)),
    ...local,
  ];
}

export const saveModels = (models: Profile[]) =>
  savePreference("routing-profiles", models);
