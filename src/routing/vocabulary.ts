/**
 * The one vocabulary every preference speaks, and the numbers it resolves to.
 *
 * Profiles are authored in words because words are what a rider can hold in their head.
 * The numbers below are what those words mean, kept in one versioned table so they are
 * inspectable rather than scattered through the cost function. `compileProfile` copies
 * the resolved values into every route result, so "prefer" is never a claim the app
 * makes without showing its work.
 */
export const VOCABULARY_VERSION = "vocabulary-v1";

export const LEVELS = [
  "strongly_avoid",
  "avoid",
  "neutral",
  "prefer",
  "strongly_prefer",
] as const;
export type Level = (typeof LEVELS)[number];

/**
 * Signed appetite, -1 (away) to +1 (towards). Every preference is two-sided: a rider who
 * `prefer`s roughness wants the rough line, and the same knob that penalizes a signal
 * rewards it on the other side of neutral.
 */
export const STRENGTH: Record<Level, number> = {
  strongly_avoid: -1,
  avoid: -0.5,
  neutral: 0,
  prefer: 0.5,
  strongly_prefer: 1,
};

export const PREFERENCE_KEYS = [
  "detour",
  "traffic_stress",
  "unpaved",
  "roughness",
  "technicality",
  "climbing",
  "scenic",
  "urbanity",
  "cycle_infrastructure",
] as const;
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

/** Preferences that steer terrain choice. `detour` is global and handled separately. */
/**
 * Preferences that score a way against a reference. `detour` is global, and `climbing`
 * acts directly on the climbing cost instead — see `CLIMB_AVERSION`.
 */
export type SignalKey = Exclude<PreferenceKey, "detour" | "climbing">;
export const SIGNAL_KEYS = PREFERENCE_KEYS.filter(
  (k): k is SignalKey => k !== "detour" && k !== "climbing",
);

/**
 * What `climbing` multiplies the climbing effort by, from `strongly_avoid` to
 * `strongly_prefer`.
 *
 * Climbing is the one preference with a cost already attached to it: the metres of effort
 * in `ENGINE.climb_effort`. Scoring it against a reference like the others would have
 * charged for the same hill twice and, worse, left a rider who marked climbing "neutral"
 * paying the full physical cost with no way to say they did not mind — which in the Alps
 * is most of what there is to say. This scales the real cost instead.
 */
export const CLIMB_AVERSION = (strength: number) => 1 - 0.6 * strength;

/**
 * How far a rider will go out of their way for everything else.
 *
 * `budget_ratio` is the honest reading of each word: at `prefer`, a perfect line is worth
 * riding 1.5x the direct distance for. `rate_floor` is its reciprocal, and it is what
 * makes that true — see `scoreEdge`. `corridor_cells` widens the search enough that a
 * route that long is actually reachable; at 700 m per cell, 8 cells is 5.6 km of slack.
 */
export const DETOUR: Record<
  Level,
  { budget_ratio: number; rate_floor: number; corridor_cells: number }
> = {
  strongly_avoid: {
    budget_ratio: 1.05,
    rate_floor: 1 / 1.05,
    corridor_cells: 2,
  },
  avoid: { budget_ratio: 1.15, rate_floor: 1 / 1.15, corridor_cells: 3 },
  neutral: { budget_ratio: 1.25, rate_floor: 1 / 1.25, corridor_cells: 5 },
  prefer: { budget_ratio: 1.5, rate_floor: 1 / 1.5, corridor_cells: 8 },
  strongly_prefer: {
    budget_ratio: 2.0,
    rate_floor: 1 / 2.0,
    corridor_cells: 13,
  },
};

/**
 * What an ordinary way looks like, per signal.
 *
 * Preferences are two-sided against this reference, which is what lets "strongly avoid
 * traffic" both punish a main road and *reward* the quiet lane. A one-sided penalty could
 * only ever push the rate up from 1.0, and an edge that can never cost less than its own
 * length can never win a detour — the exact reason the old model always went straight.
 *
 * Each value sits near the median of its signal across a real release, measured with
 * `scripts/audit_signals.ts`. That matters more than it looks: a reference set away from
 * the median puts most of the network on one side of it, so nearly every edge collects a
 * reward of the same sign and the scores collapse into a narrow band that cannot tell
 * anything apart. These should be re-measured when the builder changes how a signal is
 * derived.
 */
export const REFERENCE: Record<SignalKey, number> = {
  traffic_stress: 0.18,
  unpaved: 0.35,
  roughness: 0.18,
  // Almost nothing carries an MTB or SAC grade, so the reference sits just above zero:
  // any technical tag at all is then a real deviation rather than business as usual.
  technicality: 0.03,
  scenic: 0.4,
  // Bimodal — a way is in a built-up area or it is not — so the midpoint is the median.
  urbanity: 0.5,
  cycle_infrastructure: 0.1,
};

/**
 * How much each preference counts, per unit of strength.
 *
 * Only relative values matter: the weighted mean is normalized, so these decide which
 * preference wins an argument, not how far the router will go overall. That is `detour`.
 */
export const IMPORTANCE: Record<SignalKey, number> = {
  traffic_stress: 1.4,
  unpaved: 1,
  roughness: 1,
  technicality: 1,
  scenic: 1.2,
  urbanity: 0.9,
  cycle_infrastructure: 0.7,
};

/**
 * Weights with no user-facing knob: they describe the graph's own confidence and shape,
 * not a taste. They live here rather than in a profile because a rider has no way to
 * form an opinion about them, and every profile would have carried the same value.
 */
/**
 * The spread of `net` that counts as the full range of a preference.
 *
 * `net` is a weighted mean over every signal, and real ways are never good at all of them
 * at once — a profile that prefers unpaved while avoiding roughness is asking for two
 * things that are anticorrelated in the data. Measured across a real release the best 1%
 * of edges reach only about -0.2, so feeding `net` straight into the budget exponent
 * delivered a fraction of the detour the profile promised. Squashing it through
 * `tanh(net / NET_SCALE)` instead maps a realistically excellent way onto the budget
 * floor and a realistically awful one onto the ceiling, while staying smooth, monotone
 * and bounded either side. Re-measure with `scripts/audit_signals.ts` if the signals
 * change.
 */
export const NET_SCALE = 0.25;

/**
 * How much a way is credited for being better than ordinary, against how much it is
 * charged for being worse.
 *
 * Preferences have to work both ways — "strongly avoid traffic" must make the quiet lane
 * cheap, or nothing can ever cost less than its own length and no detour pays for itself.
 * But the two sides are not worth the same. Being free of a defect is ordinary; having a
 * virtue is not. Credited symmetrically, a smooth paved main road collected a full credit
 * from every one of "avoid unpaved", "avoid roughness" and "avoid technicality" — nearly
 * three units of reward for being unremarkable — which buried the single traffic penalty
 * it had honestly earned and priced a truck route below a signed cycle route.
 *
 * So: charged in full for what is wrong with it, credited modestly for what is right.
 */
export const REWARD_SHARE = 0.35;

export const ENGINE = {
  /**
   * Equivalent metres of flat riding per metre climbed.
   *
   * Lower than the 8:1 rule of thumb, which is a time equivalence for someone racing.
   * This is a leisure router in the Alps: at 8 the climbing term swamped everything else
   * on real mountain terrain, every profile took the long flat way round, and `detour`
   * had nothing left to buy with the distance it was willing to spend. It still has to
   * be unconditional — lifting yourself and the bike costs energy whether or not you
   * enjoy it — and it is still enough that 400 m of flat beats 100 m of climbing. How
   * much a rider minds it is `CLIMB_AVERSION`.
   */
  climb_effort: 5,
  /** Added per unit of `edge.uncertainty` — unsurveyed ways are a gamble, not a dislike. */
  uncertainty: 0.25,
  /**
   * Added per unit of `1 - edge.utility`, the reach of low-stress road within a kilometre.
   *
   * Deliberately small. The old model weighted this at 0.7 and it was quietly one of the
   * reasons routes came out direct: a quiet lane on a hillside has little low-stress
   * network around it and scored badly for it, which is precisely backwards for an app
   * whose whole point is going somewhere remote. It survives only as a mild tie-breaker
   * towards coherent networks over stranded fragments.
   */
  off_network: 0.15,
  /** Added per junction event, in equivalent metres. */
  junction_meters: 18,
  /**
   * How much of the ground's difficulty survives getting off the bike.
   *
   * Not zero: pushing up loose 40% scree is not the same errand as pushing up a farm
   * track, and if walking wiped the difficulty out entirely then every surface worse than
   * `push` would price identically and the router would lose the ability to tell awful
   * ground from merely hard ground.
   */
  walk_hard_share: 0.35,
  /** Pushing and carrying, as a multiple of a reference ridden metre. */
  push: 5,
  stairs: 9,
  /**
   * The same, for a rider who said they would rather not. A last resort loud enough to
   * lose to almost any alternative, and still finite — refusing to push is a preference,
   * and no preference may make a destination unreachable.
   */
  push_refused: 60,
  stairs_refused: 90,
  /** Ferries are priced on their own clock; see `scoreEdge`. */
  ferry_second_meters: 4,
  ferry_meters: 1,
  ferry_boarding_meters: 1000,
  /**
   * Nothing is ever unroutable. A segment far past what a rider can handle costs this
   * much per metre — a last resort, and still finite, so a route always exists.
   */
  rate_max: 200,
  /**
   * Rate added at `high_cost_at`. `comfortable_until` adds nothing and the ramp between
   * them is quartic, so the onset is barely felt and the far side climbs hard.
   */
  threshold_rate: 8,
} as const;
