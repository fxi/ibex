/**
 * What a way costs the rider in front of us, in metres of equivalent effort.
 *
 * `scoreEdge` is the whole cost model: it prices one edge for one compiled profile and
 * returns the `Components` the UI later shows. Everything here is a pure function of the
 * edge and the profile, which is what lets `costCache` price each edge once per search and
 * what lets the engine stay a search over these numbers rather than a search that also
 * decides them.
 */

import { toCompiled, type CompiledProfile } from "./compile";
import type { Profile } from "./profiles";
import {
  ENGINE,
  NET_SCALE,
  REWARD_SHARE,
  STRENGTH,
  type ScoredKey,
} from "./vocabulary";
import { exceedance, type CapabilityProfile } from "./capability";
import { edgeSignals, scenicValue, type Signals } from "./signals";
import { climbingTechnical, isFerry, traversalSegments } from "./eligibility";
import { isStreet } from "./tagging";
import { distance } from "../geo/distance";
import type { Attraction, Components, Edge } from "./types";
/** Cost terms that are not a matter of taste, and so sit outside the preference factor. */
export const HARD_TERMS = [
  "slope",
  "technical",
  "roughness",
  "traffic",
  "uncertainty",
  "network",
] as const;
export type HardTerm = (typeof HARD_TERMS)[number];

export const emptyComponents = (): Components => ({
  distanceM: 0,
  base: 0,
  preference: 0,
  slope: 0,
  technical: 0,
  roughness: 0,
  traffic: 0,
  uncertainty: 0,
  network: 0,
  junction: 0,
  walking: 0,
  ferry: 0,
  attraction: 0,
  clamp: 0,
});

/**
 * Where a value sits relative to an ordinary way, from -1 (as low as it goes) through 0
 * (ordinary) to +1 (as high as it goes).
 *
 * The two sides are scaled independently because the reference is rarely in the middle:
 * traffic stress 0.35 is ordinary, so 0 is as quiet as a road gets and 1 is far worse
 * than ordinary, and both deserve to read as a full unit of their kind.
 */
export function deviation(value: number, reference: number): number {
  const d =
    value > reference
      ? (value - reference) / Math.max(1e-6, 1 - reference)
      : (value - reference) / Math.max(1e-6, reference);
  return Math.max(-1, Math.min(1, d));
}

type Rate = {
  net: number;
  hard: number;
  terms: Record<HardTerm, number>;
  /** The effort of the climb, per metre: the part of `slope` a taste may discount. */
  effort: number;
};

/**
 * The hazard of riding in traffic busier than a quiet departmental road, for a rider who
 * avoids it. Zero for anyone neutral or keen, and for any way at or below
 * `ENGINE.traffic_from`.
 */
export function trafficHazard(
  stress: number,
  p: CompiledProfile,
  weights: CompiledProfile["weights"] = p.weights,
): number {
  const w = weights.traffic_stress;
  if (w.sign >= 0) return 0;
  const from = ENGINE.traffic_from;
  const excess = Math.max(0, (stress - from) / (1 - from));
  return ENGINE.traffic * Math.abs(STRENGTH[w.level]) * excess * excess;
}

/** Traffic stress as ridden: road class, calmed where a cycle route is signed. */
export function effectiveStress(edge: Edge): number {
  return edge.cyclingNetwork
    ? edge.stress * ENGINE.network_calming
    : edge.stress;
}

/**
 * Roots and steps ask something of the bike before they exceed the rider's handling
 * limit. Tire volume, suspension and luggage already meet in the surface threshold, so
 * use a conservative share of it as equipment clearance: scale 1 is noticeable on a
 * rigid gravel bike, free on a suspended 60 mm MTB, and increasingly costly when loaded.
 */
export function technicalEquipmentHazard(
  technical: number,
  capability: CapabilityProfile,
  handling: CapabilityProfile["technical_up"],
): number {
  // Past handling comfort the ordinary capability term is already speaking. This term
  // exists only for easy technical grades the rider can handle but the bike cannot shrug
  // off, so it must not recalibrate scale 2/3 routes that already have a real cost.
  if (technical > handling.comfortable_until) return 0;
  const clearance = Math.min(
    1,
    0.35 * capability.surface_roughness.comfortable_until,
  );
  if (technical <= clearance) return 0;
  const excess = (technical - clearance) / Math.max(1e-6, 1 - clearance);
  return ENGINE.technical_equipment * excess * excess;
}

/**
 * Unpaved ground, for a rider who strongly avoids it: a road bike on gravel.
 *
 * The preference alone is capped by the detour budget, and compacted gravel sits below a
 * 28 mm tyre's roughness threshold, so neither kept a road route off a gravel shortcut.
 * Like traffic it is charged outside the budget. Still finite, so nothing becomes
 * unreachable. An untagged street is assumed sealed; an untagged track is not.
 */
export function unpavedHazard(
  edge: Edge,
  s: Signals,
  p: CompiledProfile,
  weights: CompiledProfile["weights"] = p.weights,
): number {
  // Directional: `downhill.unpaved: strongly_avoid` has to reach this charge too, or an
  // override could only move the capped preference and never keep a descent off gravel.
  if (weights.unpaved.level !== "strongly_avoid") return 0;
  if (s.surfaceKnown) return ENGINE.unpaved_hazard * s.unpaved;
  return isStreet(edge)
    ? 0
    : ENGINE.unpaved_hazard * ENGINE.unpaved_guess_share * s.unpaved;
}

/**
 * The attention a change of direction takes at an intersection, for a rider who avoids
 * it. Zero going straight, at a node where fewer than three ways meet (a way split, a
 * waypoint, a hairpin inside one way), across a ferry, or for anyone neutral or keen:
 * a negative cost would break the search, so turns are never rewarded.
 */
export function turnCost(
  previous: Edge | undefined,
  edge: Edge,
  p: CompiledProfile,
  degree: number,
): number {
  const strength = STRENGTH[p.directionChanges];
  if (!previous || strength >= 0 || degree < 3) return 0;
  if (isFerry(previous) || isFerry(edge)) return 0;
  const a = previous.geometry.at(-2)!,
    b = previous.geometry.at(-1)!,
    c = edge.geometry[1] ?? edge.geometry.at(-1)!;
  const k = Math.cos((b[1] * Math.PI) / 180);
  const ux = (b[0] - a[0]) * k,
    uy = b[1] - a[1],
    vx = (c[0] - b[0]) * k,
    vy = c[1] - b[1];
  const norm = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (!norm) return 0;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / norm));
  return ENGINE.turn_meters * -strength * ((1 - cos) / 2);
}

/**
 * Grade outside the band where a rider keeps their momentum.
 *
 * Climbing effort is charged per metre of height, so on its own it is indifferent to how
 * steeply the height is gained or lost, and distance then decides: the steep shortcut
 * always wins. On the Voirons gold standard that was nearly every divergence — a 17-20%
 * residential ramp off a descent on an 11% road, a 16% grade3 track off an 8% climb. The
 * capability ramp is no answer: it prices what the rider cannot do, and the same ride
 * takes short 16-26% ramps where there is no alternative.
 *
 * The band offset is what makes this survive the cancellation. Per metre of length it
 * charges `|grade| - band`, so per metre of *height* it charges `1 - band/grade`, which
 * rises with the gradient — where a term merely proportional to grade is `climb_effort`
 * again, identical on both ways up one hill. It stays linear and mild: a preference for
 * staying in the band, not a limit.
 *
 * It used to scale with `direction_changes`, borrowed because that setting stood for a
 * fluid line and there was nothing better. But that setting vanishes at `neutral`, which
 * both Road and MTB ship, so those two profiles had no opinion about gradient at all —
 * 656 km and 416 km of the Voirons network priced at nothing. `steepness` is the setting
 * this always wanted, and it charges in full at `neutral`.
 */
export function steepnessCost(grade: number, p: CompiledProfile): number {
  const band =
    ENGINE.flow_band *
    (grade > 0
      ? p.capability.uphill_grade.comfortable_until
      : p.capability.downhill_grade.comfortable_until);
  return (
    ENGINE.flow * p.steepnessAversion * Math.max(0, Math.abs(grade) - band)
  );
}

/** Physical cycle infrastructure remains distinguishable from signed route membership. */
export function cycleInfrastructure(edge: Edge): number {
  return Math.max(
    edge.cyclingNetwork ?? 0,
    edge.highway === "cycleway" || edge.tags?.bicycle === "designated"
      ? 0.8
      : 0,
  );
}

/**
 * Score one grade run: how well it matches the rider's preferences, and how far past
 * their capability it is.
 */
function riddenRate(
  edge: Edge,
  p: CompiledProfile,
  s: Signals,
  grade: number | null,
): Rate {
  const k = p.capability;
  const down = grade !== null && grade < 0;
  const technical = down
    ? s.technicalDown
    : climbingTechnical(s.technicalUp, grade, k);

  // Past a false flat, the profile's uphill or downhill preferences take over: the same
  // rider can want good gravel on the way up and smooth tarmac, or singletrack, down.
  const weights =
    grade !== null && grade > ENGINE.grade_from
      ? p.uphillWeights
      : grade !== null && grade < -ENGINE.grade_from
        ? p.downhillWeights
        : p.weights;
  const value: Record<ScoredKey, number> = {
    traffic_stress: effectiveStress(edge),
    unpaved: s.unpaved,
    roughness: s.roughness,
    technicality: technical,
    scenic: scenicValue(edge),
    urbanity: edge.urban ?? 0,
    cycle_infrastructure: edge.cyclingNetwork ?? 0,
  };

  // Off the street network, a way whose ground nobody described is a gamble, and the
  // forest around it says nothing about whether it can be ridden. Its defects are
  // charged in full, but its virtues are only partly believed: full scenic credit
  // made a bare `mtb:scale=1` footpath through a wood the cheapest way on a gravel
  // route near Arthaz — and unrideable when ridden.
  const trust = s.surfaceKnown || isStreet(edge) ? 1 : ENGINE.unsurveyed_credit;
  let sum = 0,
    weight = 0;
  for (const key of Object.keys(value) as ScoredKey[]) {
    // Roughness and technicality share one `surface_difficulty` level but combine by
    // direction. Avoiding it, both defects are charged: rough *and* technical is worse
    // than either, and taking only the larger halved the penalty on a gravel bike's
    // `mtb:scale=2` dirt shortcut. Preferring it, either one is the ground asked for, so
    // the further from its own reference is credited — scored separately, a smooth but
    // technical path was charged for being smooth.
    if (key === "technicality" && weights.technicality.sign > 0) continue;
    let w = weights[key];
    if (w.weight === 0) continue;
    let d = deviation(value[key], w.reference);
    if (key === "roughness" && w.sign > 0) {
      const dt = deviation(value.technicality, weights.technicality.reference);
      if (dt > d) {
        d = dt;
        w = weights.technicality;
      }
    }
    // Positive is worse than an ordinary way in the direction this rider cares about,
    // negative is better. A virtue the rider asked for counts in full; merely lacking
    // a defect they avoid is discounted by `REWARD_SHARE`.
    let badness = -w.sign * d;
    // Avoiding difficult ground, a smooth surface is no virtue on a technical path. The
    // reverse is left alone: most gravel carries no technical tag, and withholding that
    // credit would recalibrate every rough track.
    if (
      key === "roughness" &&
      w.sign < 0 &&
      badness <= 0 &&
      deviation(value.technicality, weights.technicality.reference) > 0
    )
      continue;
    // Nor is lacking a technical tag a virtue. Almost no way carries one, so its absence
    // sits a full unit below the reference and, credited, outweighed real roughness:
    // "avoid difficult ground" priced a rough gravel track below "prefer" it.
    if (key === "technicality" && badness <= 0) continue;
    if (key === "unpaved" && !s.surfaceKnown) {
      // Never reward a guess: with no `surface` tag, "unpaved" is read off the road
      // hierarchy and is not evidence of the gravel the rider came for. Nor is silence
      // tarmac, so a rider avoiding unpaved ground pays a share of the likely penalty.
      if (w.sign >= 0 || badness <= 0) continue;
      badness *= ENGINE.unpaved_guess_share;
    }
    sum +=
      w.weight *
      (badness > 0
        ? badness
        : badness * (w.sign > 0 ? 1 : REWARD_SHARE) * trust);
    weight += w.weight;
  }

  const effort =
    grade !== null && grade > 0
      ? ENGINE.climb_effort * grade * p.climbAversion
      : 0;
  const terms: Record<HardTerm, number> = {
    slope:
      grade === null
        ? 0
        : steepnessCost(grade, p) +
          (grade > 0
            ? effort + ENGINE.threshold_rate * exceedance(grade, k.uphill_grade)
            : // A steep descent on a twisty line is worse than a steep straight one,
              // and this is the only place curvature is used.
              ENGINE.threshold_rate *
              exceedance(-grade, k.downhill_grade) *
              (1 + 0.5 * s.curvature)),
    technical:
      ENGINE.threshold_rate *
        exceedance(technical, down ? k.technical_down : k.technical_up) +
      technicalEquipmentHazard(
        technical,
        k,
        down ? k.technical_down : k.technical_up,
      ),
    roughness:
      ENGINE.threshold_rate * exceedance(s.roughness, k.surface_roughness) +
      unpavedHazard(edge, s, p, weights),
    traffic: trafficHazard(effectiveStress(edge), p, weights),
    uncertainty: ENGINE.uncertainty * edge.uncertainty,
    network: ENGINE.off_network * (1 - edge.utility),
  };
  return {
    net: weight > 0 ? sum / weight : 0,
    hard: HARD_TERMS.reduce((total, key) => total + terms[key], 0),
    terms,
    effort,
  };
}

/**
 * Cost in equivalent metres, at a rate that can fall below 1.
 *
 * The old model charged full distance and then applied capped discounts to the penalty
 * terms only — never to distance itself, as its own comment said. The cheapest possible
 * edge therefore still cost its own length, so a scenic line could never beat a shorter
 * plain one and the router was structurally incapable of detouring however the profile
 * was tuned. Here an edge costs `length x rate`, and a way the rider likes has a rate
 * below 1: it buys distance.
 *
 *     rate = (1 + hard) * budget_ratio ** tanh(net / NET_SCALE)
 *
 * `net` is the weighted mean of how well the edge matches the preferences the rider
 * actually expressed, -1 (ideal) to +1 (exactly wrong), so raising `budget_ratio` to it
 * is what gives `detour` its meaning: at `prefer`, budget 1.5, an ideal edge costs 1/1.5
 * of its length and the router will ride 1.5 km of it rather than 1 km of nothing
 * special. `hard` carries what is not a matter of taste.
 */
/**
 * Cost every edge once per search.
 *
 * `scoreEdge` is called on every relaxation, again for each edge of the finished route,
 * and again for each edge in `buildField`. It reads only the edge and the compiled
 * profile, both immutable for the length of a route, so one pass and a lookup is the
 * same answer for a fraction of the work.
 */
const profileCosts = new WeakMap<CompiledProfile, WeakMap<Edge, Components>>();
export function costCache(
  profile: Profile | CompiledProfile,
  attraction?: Attraction,
) {
  const p = toCompiled(profile);
  // Edge objects survive block reuse; ids alone are unsafe for waypoint splits.
  let cache = !attraction ? profileCosts.get(p) : undefined;
  if (!cache) {
    cache = new WeakMap<Edge, Components>();
    if (!attraction) profileCosts.set(p, cache);
  }
  return (edge: Edge): Components => {
    const hit = cache.get(edge);
    if (hit) return hit;
    const value = scoreEdge(edge, p, attraction);
    cache.set(edge, value);
    return value;
  };
}

export function scoreEdge(
  edge: Edge,
  input: Profile | CompiledProfile,
  attraction?: Attraction,
): Components {
  const p = toCompiled(input);
  const s = edgeSignals(edge);
  const c = emptyComponents();
  const l = edge.length;
  c.distanceM = l;

  if (isFerry(edge)) {
    c.base = l;
    c.ferry =
      edge.ferrySeconds === undefined
        ? l * ENGINE.ferry_meters
        : edge.ferrySeconds * ENGINE.ferry_second_meters;
    c.uncertainty = l * edge.uncertainty * ENGINE.uncertainty;
    return c;
  }

  const segments = traversalSegments(edge, p, s);
  const riddenLength = segments.reduce(
    (sum, seg) => sum + (seg.mode === "ride" ? seg.length : 0),
    0,
  );

  // Price each grade run on its own, so that splitting an edge at a waypoint — which
  // `snapAnchors` does — cannot change what the route costs.
  const terms: Record<HardTerm, number> = {
    slope: 0,
    technical: 0,
    roughness: 0,
    traffic: 0,
    uncertainty: 0,
    network: 0,
  };
  let net = 0,
    effort = 0;
  for (const seg of segments) {
    if (seg.mode === "ferry") continue;
    const r = riddenRate(edge, p, s, seg.grade);
    const walking = seg.mode === "walk";
    if (walking) {
      const stairs = edge.highway === "steps";
      const permitted = stairs ? p.permissions.stairs : p.permissions.push;
      c.walking +=
        seg.length *
        (stairs
          ? permitted
            ? ENGINE.stairs
            : ENGINE.stairs_refused
          : permitted
            ? ENGINE.push
            : ENGINE.push_refused);
    } else if (riddenLength > 0) {
      net += r.net * (seg.length / riddenLength);
    }
    const share = walking ? ENGINE.walk_hard_share : 1;
    for (const key of HARD_TERMS)
      terms[key] += r.terms[key] * seg.length * share;
    effort += r.effort * seg.length * share;
  }

  // The preference factor scales the effort of riding the way — its distance, the climb
  // and the push. Applying it only to the flat reference metre left it with almost no
  // leverage exactly where terrain is interesting: in the mountains climbing dominates,
  // so a rider who said they would happily ride half as far again for a better line got
  // a route barely 3% longer. A rider who loves quiet gravel finds the climb on it more
  // worth doing too, and this says so.
  //
  // What the rider cannot comfortably do is not a matter of taste, and stays outside:
  // past the grade, technical and roughness thresholds, the flow band, traffic and the
  // gamble of undescribed ground. Scaled with the rest, a scenic forest made a 19%
  // `mtb:scale=1` path the cheapest climb up the Voirons at 1.6 per metre, below the
  // village street the gold standard takes to the gravel of the Route du Montauban.
  const preference = p.detour.budget_ratio ** Math.tanh(net / NET_SCALE);
  const taste = riddenLength + c.walking + effort;
  const raw =
    riddenLength + c.walking + HARD_TERMS.reduce((sum, k) => sum + terms[k], 0);
  c.base = riddenLength;
  c.preference = taste * (preference - 1);
  for (const key of HARD_TERMS) c[key] = terms[key];

  // Nothing is ever unroutable, so the whole edge is capped rather than any one term.
  const priced = raw + c.preference;
  c.clamp = Math.min(priced, l * ENGINE.rate_max) - priced;

  c.junction = (edge.junction ?? 0) * ENGINE.junction_meters;

  if (attraction) {
    const mid = edge.geometry[Math.floor(edge.geometry.length / 2)];
    const influence = Math.max(
      0,
      1 - distance(mid, attraction.point) / Math.max(1, attraction.radiusM),
    );
    c.attraction =
      -total(c) * Math.min(0.65, Math.max(0, attraction.strength)) * influence;
  }
  return c;
}

/**
 * The cost of an edge. `distanceM` is a report, not a cost, so it is excluded.
 *
 * Always strictly positive: `base` is the full ridden length, `preference` can subtract
 * at most `1 - 1/budget_ratio` of it, and every other term is non-negative apart from
 * `attraction`, which is capped at 65% of the rest.
 */
export const total = (c: Components) =>
  c.base +
  c.preference +
  c.slope +
  c.technical +
  c.roughness +
  c.traffic +
  c.uncertainty +
  c.network +
  c.junction +
  c.walking +
  c.ferry +
  c.attraction +
  c.clamp;
