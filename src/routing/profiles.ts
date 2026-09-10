import { z } from "zod";
import master from "../../profiles/master.json";
import gravel from "../../profiles/gravel.json";
import road from "../../profiles/road.json";
import touring from "../../profiles/touring.json";
import scenic from "../../profiles/scenic.json";
import type { Profile } from "./types";

const attraction = z.number().min(0).max(100);
const coefficient = z.number().min(0).max(1000);
const discount = z.number().min(0).max(0.95);
const grade = z.number().min(0).max(100).nullable();
const mtb = z.number().int().min(0).max(6);
const sac = z.number().int().min(0).max(6);
const attractionSchema = z.strictObject({
  quiet: attraction,
  countryside: attraction,
  scenic: attraction,
  climbing: attraction,
  cycling_network: attraction,
  offroad_up: attraction,
  offroad_down: attraction,
});
const capabilitiesSchema = z.strictObject({
  max_grade_up: grade,
  max_grade_down: grade,
  max_mtb_scale_up: mtb,
  max_mtb_scale_down: mtb,
  max_hike_sac_up: sac,
  max_hike_sac_down: sac,
  paved_only: z.boolean(),
  allow_unknown_paths: z.boolean(),
  allow_rough_surfaces: z.boolean(),
  max_track_grade: z.number().int().min(1).max(5),
  max_smoothness: z.number().int().min(0).max(6),
});
const accessSchema = z.strictObject({
  hike_a_bike: z.boolean(),
  steps: z.boolean(),
  ferry: z.boolean(),
});
const costsSchema = z.strictObject({
  slope: coefficient,
  surface: coefficient,
  uncertainty: coefficient,
  graph_utility: coefficient,
  technical: coefficient,
  junction: coefficient,
  quiet_factor: coefficient,
  slope_reference_grade: z.number().min(0.01).max(1),
  downhill_free_grade: z.number().min(0).max(1),
  downhill_factor: coefficient,
  technical_up: coefficient,
  technical_down: coefficient,
  scenic_discount: discount,
  climbing_discount: discount,
  offroad_discount: discount,
  junction_meters: coefficient,
  walking_factor: z.number().min(1).max(1000),
  countryside_factor: coefficient,
  cycling_network_factor: coefficient,
  steps_factor: z.number().min(1).max(1000),
  ferry_factor: coefficient,
  ferry_second_meters: coefficient,
  ferry_boarding_meters: coefficient,
});
const metadata = {
  version: z.literal(1),
  name: z.string().trim().min(1).max(100),
  bike: z.enum(["gravel", "road", "touring", "scenic"]),
};
export const profileSchema = z.strictObject({
  ...metadata,
  attraction: attractionSchema.partial().optional(),
  capabilities: capabilitiesSchema.partial().optional(),
  access: accessSchema.partial().optional(),
  costs: costsSchema.partial().optional(),
});
const resolvedSchema = z.strictObject({
  ...metadata,
  attraction: attractionSchema,
  capabilities: capabilitiesSchema,
  access: accessSchema,
  costs: costsSchema,
});
export type UserProfile = z.infer<typeof profileSchema>;
export type ResolvedProfile = z.infer<typeof resolvedSchema>;
export type ProfileInput = Profile | UserProfile;
export const bundledProfiles: Record<Profile, UserProfile> = {
  gravel: profileSchema.parse(gravel),
  road: profileSchema.parse(road),
  touring: profileSchema.parse(touring),
  scenic: profileSchema.parse(scenic),
};
const defaults = resolvedSchema.parse(master);
const resolved = new WeakSet<object>();
const presets = new Map<Profile, ResolvedProfile>();

/** Merge individual fields, preserving explicit zero, false, and null values. */
export function resolveProfile(input: ProfileInput): ResolvedProfile {
  if (typeof input === "object" && input !== null && resolved.has(input))
    return input as ResolvedProfile;
  if (typeof input === "string" && presets.has(input))
    return presets.get(input)!;
  const custom = profileSchema.parse(
    typeof input === "string" ? bundledProfiles[input] : input,
  );
  const base = bundledProfiles[custom.bike];
  const value = resolvedSchema.parse({
    ...defaults,
    ...base,
    ...custom,
    attraction: {
      ...defaults.attraction,
      ...base.attraction,
      ...custom.attraction,
    },
    capabilities: {
      ...defaults.capabilities,
      ...base.capabilities,
      ...custom.capabilities,
    },
    access: { ...defaults.access, ...base.access, ...custom.access },
    costs: { ...defaults.costs, ...base.costs, ...custom.costs },
  });
  for (const group of [
    value.attraction,
    value.capabilities,
    value.access,
    value.costs,
  ])
    Object.freeze(group);
  Object.freeze(value);
  resolved.add(value);
  if (typeof input === "string") presets.set(input, value);
  return value;
}
