import { deriveCapability, type CapabilityProfile } from "./capability";
import { overrides, type Permissions, type Profile } from "./profiles";
import {
  CLIMB_AVERSION,
  DETOUR,
  ENGINE,
  IMPORTANCE,
  levelKey,
  REFERENCE,
  SCORED_KEYS,
  STEEPNESS_AVERSION,
  STRENGTH,
  VOCABULARY_VERSION,
  type Level,
  type ScoredKey,
  type SignalKey,
} from "./vocabulary";

/**
 * A profile, resolved into the numbers the search actually uses.
 *
 * This is the only place words become coefficients. It is attached to every route result
 * so the Configure panel can show what "prefer" meant on this run — the old model hid its
 * real values behind inheritance, and the fix is not to hide them behind a vocabulary
 * instead.
 */
export type CompiledProfile = {
  vocabulary_version: typeof VOCABULARY_VERSION;
  id: string;
  name: string;
  detour: {
    level: Level;
    budget_ratio: number;
    rate_floor: number;
    corridor_cells: number;
  };
  /**
   * Per-signal weight and direction for `base`. `weight` is 0 for anything left
   * `neutral`, so a preference nobody expressed does not dilute the ones they did.
   */
  weights: Weights;
  /** `weights` with the profile's `uphill` overrides, for grade runs going up. */
  uphillWeights: Weights;
  /** `weights` with the profile's `downhill` overrides, for grade runs going down. */
  downhillWeights: Weights;
  /** How much this rider minds height gained: 1 is neutral, below 1 enjoys it. */
  climbAversion: number;
  /** How much this rider minds the gradient itself; see `steepnessCost`. */
  steepnessAversion: number;
  /** How much a change of direction at an intersection costs; see `turnCost`. */
  directionChanges: Level;
  capability: CapabilityProfile;
  permissions: Permissions;
};

type Weights = Record<
  ScoredKey,
  { level: Level; weight: number; sign: number; reference: number }
>;

export function compileProfile(profile: Profile): CompiledProfile {
  const detourLevel = profile.settings.detour;
  const detour = DETOUR[detourLevel];
  const capability = deriveCapability(profile.setup);
  // What counts as rough depends on what is underneath you. Against the global reference,
  // "avoid roughness" charged a 50 mm tyre for every gravel road and grade3 track — the
  // very ground its "prefer unpaved" was asking for — and priced them above the tarmac
  // beside them. Ordinary for this bike is whatever it rides comfortably.
  const reference = (key: ScoredKey) =>
    key === "roughness"
      ? Math.max(REFERENCE[key], capability.surface_roughness.comfortable_until)
      : REFERENCE[key];
  const weightsFor = (levels: Record<SignalKey, Level>) =>
    Object.freeze(
      Object.fromEntries(
        SCORED_KEYS.map((key) => {
          const level = levels[levelKey(key)];
          const strength = STRENGTH[level];
          return [
            key,
            Object.freeze({
              level,
              weight: Math.abs(strength) * IMPORTANCE[key],
              sign: Math.sign(strength),
              reference: reference(key),
            }),
          ];
        }),
      ) as Weights,
    );
  const base = profile.preferences.base;
  const weights = weightsFor(base);
  const directional = (direction: "uphill" | "downhill") => {
    const changed = overrides(profile.preferences, direction);
    return Object.keys(changed).length
      ? weightsFor({ ...base, ...changed })
      : weights;
  };

  return Object.freeze({
    vocabulary_version: VOCABULARY_VERSION,
    id: profile.id,
    name: profile.name,
    detour: Object.freeze({ level: detourLevel, ...detour }),
    weights,
    uphillWeights: directional("uphill"),
    downhillWeights: directional("downhill"),
    climbAversion: CLIMB_AVERSION(STRENGTH[profile.settings.climbing]),
    steepnessAversion: STEEPNESS_AVERSION(STRENGTH[profile.settings.steepness]),
    directionChanges: profile.settings.direction_changes,
    capability,
    permissions: profile.permissions,
  });
}

const compiled = new WeakMap<Profile, CompiledProfile>();

/**
 * Compile once per profile object.
 *
 * `route()` resolves at its boundary and passes the result down, but `scoreEdge` and the
 * field builder are also reachable directly from tests and scripts, so accept either and
 * never pay for the derivation twice.
 */
export function toCompiled(input: Profile | CompiledProfile): CompiledProfile {
  if (isCompiled(input)) return input;
  const hit = compiled.get(input);
  if (hit) return hit;
  const value = compileProfile(input);
  compiled.set(input, value);
  return value;
}

export const isCompiled = (
  input: Profile | CompiledProfile,
): input is CompiledProfile =>
  (input as CompiledProfile).vocabulary_version !== undefined;

/**
 * Plain-language capability, for the setup form.
 *
 * "Inheritance doesn't show values" was the complaint that started this refactor. A
 * derived model has the same failure mode unless it says out loud what it derived.
 */
export function describeCapability(c: CompiledProfile): string[] {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const k = c.capability;
  return [
    `Climbs comfortably to ${pct(k.uphill_grade.comfortable_until)}, hard going past ${pct(k.uphill_grade.high_cost_at)}.`,
    `Descends comfortably to ${pct(k.downhill_grade.comfortable_until)}, hard going past ${pct(k.downhill_grade.high_cost_at)}.`,
    `About ${k.climb.comfortable_speed_kmh.toFixed(1)} km/h in the lowest gear at ${Math.round(k.climb.sustained_watts)} W sustained.`,
    `Balances distance against route quality; detours are not a fixed distance allowance.`,
  ];
}

export { ENGINE };
