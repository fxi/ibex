import { preference, savePreference } from "./offline/store";
import { profileSchema, type UserProfile } from "./routing/profiles";
const files = import.meta.glob("../profiles/*.json", {
  eager: true,
  import: "default",
});
export async function loadModels(): Promise<UserProfile[]> {
  const value = await preference<unknown>("routing-profiles");
  if (value !== undefined && !Array.isArray(value))
    throw new Error("Saved profile collection is invalid.");
  const local = ((value ?? []) as unknown[]).map((p) => profileSchema.parse(p));
  const shipped = Object.entries(files)
    .filter(
      ([path]) => !/\/(master|gravel|road|touring|scenic)\.json$/.test(path),
    )
    .map(([, p]) => profileSchema.parse(p));
  return [
    ...shipped.filter((p) => !local.some((q) => q.name === p.name)),
    ...local,
  ];
}
export const saveModels = (models: UserProfile[]) =>
  savePreference("routing-profiles", models);
