import type { Bike, Rider, Setup } from "./profiles";

/**
 * What this rider on this bike can actually do.
 *
 * Replaces the hand-set `max_grade_up` / `max_mtb_scale_up` limits. Those were both
 * unanswerable ("what grade can I ride?" depends on the gear you have) and dangerous:
 * they deleted edges from the graph, so a preference could make a route impossible. Here
 * every threshold is soft. `comfortable_until` is where cost starts to rise at all;
 * `high_cost_at` is where it becomes a strong deterrent. Neither blocks anything.
 */
export const CAPABILITY_VERSION = "capability-v1";

export type Threshold = { comfortable_until: number; high_cost_at: number };

export type CapabilityProfile = {
  version: typeof CAPABILITY_VERSION;
  /** Fractional grade, positive. 0.1 is 10%. */
  uphill_grade: Threshold;
  downhill_grade: Threshold;
  /** Normalized 0..1 technical difficulty, directional. */
  technical_up: Threshold;
  technical_down: Threshold;
  /** Normalized 0..1 surface roughness. */
  surface_roughness: Threshold;
  /** Derived speeds, reported so the form can explain the grades above. */
  climb: {
    comfortable_speed_kmh: number;
    grinding_speed_kmh: number;
    sustained_watts: number;
  };
};

const G = 9.80665;
const AIR_DENSITY = 1.225;
/** Upright on a climb. At 6 km/h drag is about one watt, so precision here is wasted. */
const CDA = 0.32;
const DRIVETRAIN = 0.97;
/** Comfortable spinning, and the slowest cadence that still turns over smoothly. */
const CADENCE_COMFORTABLE = 60;
const CADENCE_GRINDING = 40;
/** Nobody stays upright below this, whatever the gearing says. */
const BALANCE_SPEED = 3.5 / 3.6;
/** A climb ridden at full sustained power is survivable, not comfortable. */
const COMFORTABLE_EFFORT = 0.75;

/** 622 mm rim plus tire, twice over. */
export const wheelCircumferenceM = (tire_mm: number) =>
  Math.PI * (0.622 + 2 * (tire_mm / 1000));

/**
 * Rolling resistance on good tarmac. Wider is slower here and faster everywhere else;
 * the surface penalty in `scoreEdge` carries the everywhere-else half.
 */
export const rollingResistance = (tire_mm: number) =>
  0.004 + 0.00008 * (tire_mm - 25);

const suspensionFactor = (s: Bike["suspension"]) =>
  s === "full" ? 1 : s === "front" ? 0.5 : 0;

/** Speed the lowest gear delivers at a given cadence — the floor, not the ceiling. */
export function gearSpeed(bike: Bike, cadence: number): number {
  return (
    (bike.lowest_gear_ratio * wheelCircumferenceM(bike.tire_mm) * cadence) / 60
  );
}

/**
 * Watts needed to hold `v` up a slope of fractional `grade`, at the pedals.
 *
 * The steady-state balance: lifting the mass, rolling it, and pushing air. Grade is a
 * rise over run, so the angle is `atan(grade)` and gravity splits by its sine.
 */
export function powerRequired(
  v: number,
  grade: number,
  mass: number,
  crr: number,
): number {
  const theta = Math.atan(grade);
  const resistance = mass * G * (Math.sin(theta) + crr * Math.cos(theta));
  return (v * resistance + 0.5 * AIR_DENSITY * CDA * v ** 3) / DRIVETRAIN;
}

/**
 * The grade at which `watts` buys exactly `v`.
 *
 * Power rises monotonically with grade at fixed speed, so bisection is both correct and
 * fast enough to run once per compiled profile.
 */
function gradeAtPower(
  v: number,
  watts: number,
  mass: number,
  crr: number,
): number {
  let low = 0,
    high = 0.6;
  if (powerRequired(v, low, mass, crr) > watts) return 0;
  if (powerRequired(v, high, mass, crr) < watts) return high;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (powerRequired(v, mid, mass, crr) < watts) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Uphill capability, from the power balance.
 *
 * Two limits meet here. Power sets the fastest you can go up a grade; the lowest gear
 * sets the slowest you can go at all. Comfort ends where 75% effort no longer spins the
 * lowest gear at 60 rpm; the high-cost grade is where full effort drops you to a 40 rpm
 * grind. This is why a loaded tourer at 0.6 and an MTB at 0.52 behave differently on the
 * same hill even at identical fitness — which is exactly what `max_grade_up` could not say.
 */
function uphill(
  bike: Bike,
  rider: Rider,
): {
  threshold: Threshold;
  comfortable_speed_kmh: number;
  grinding_speed_kmh: number;
  sustained_watts: number;
} {
  const mass = rider.mass_kg + bike.mass_kg + bike.load_kg;
  const crr = rollingResistance(bike.tire_mm);
  const watts = rider.sustained_w_per_kg * rider.mass_kg;
  const vComfortable = Math.max(
    gearSpeed(bike, CADENCE_COMFORTABLE),
    BALANCE_SPEED,
  );
  const vGrinding = Math.max(gearSpeed(bike, CADENCE_GRINDING), BALANCE_SPEED);
  const comfortable = gradeAtPower(
    vComfortable,
    watts * COMFORTABLE_EFFORT,
    mass,
    crr,
  );
  const high = gradeAtPower(vGrinding, watts, mass, crr);
  return {
    threshold: {
      comfortable_until: comfortable,
      // A bike geared so low that grinding buys nothing still needs the two apart.
      high_cost_at: Math.max(high, comfortable + 0.02),
    },
    comfortable_speed_kmh: vComfortable * 3.6,
    grinding_speed_kmh: vGrinding * 3.6,
    sustained_watts: watts,
  };
}

/**
 * Downhill, technical and roughness tolerance — calibrated heuristics, not physics.
 *
 * There is no honest power balance for "how steep a descent will this rider commit to".
 * It is nerve, tires, suspension and how much luggage is trying to overtake the rider.
 * These are fitted so that the shipped presets land where experienced riders put them,
 * and they are labelled heuristics so nobody mistakes the fit for a derivation.
 */
function heuristics(bike: Bike, rider: Rider) {
  const susp = suspensionFactor(bike.suspension);
  // 25 mm is nothing underneath you, 60 mm is a lot. Everything wider saturates.
  const tire = Math.min(1, Math.max(0, (bike.tire_mm - 25) / 35));
  // Luggage punishes rough and technical ground far more than it punishes a gradient.
  const load = 1 / (1 + bike.load_kg / 60);
  const nerve = (rider.tech_skill + rider.descend_confidence) / 2;
  return {
    downhill_grade: {
      comfortable_until:
        0.07 + 0.08 * rider.descend_confidence + 0.03 * susp + 0.025 * tire,
      high_cost_at:
        0.12 + 0.13 * rider.descend_confidence + 0.05 * susp + 0.04 * tire,
    },
    technical_up: {
      comfortable_until: (0.05 + 0.22 * rider.tech_skill) * load,
      high_cost_at: (0.15 + 0.43 * rider.tech_skill) * load,
    },
    technical_down: {
      comfortable_until: (0.08 + 0.31 * nerve + 0.06 * susp) * load,
      high_cost_at: (0.18 + 0.6 * nerve + 0.1 * susp) * load,
    },
    surface_roughness: {
      comfortable_until: (0.22 + 0.35 * tire + 0.15 * susp) * load,
      high_cost_at: (0.45 + 0.66 * tire + 0.2 * susp) * load,
    },
  };
}

export function deriveCapability(setup: Setup): CapabilityProfile {
  const { bike, rider } = setup;
  const climb = uphill(bike, rider);
  const h = heuristics(bike, rider);
  return Object.freeze({
    version: CAPABILITY_VERSION,
    uphill_grade: Object.freeze(climb.threshold),
    downhill_grade: Object.freeze(h.downhill_grade),
    technical_up: Object.freeze(h.technical_up),
    technical_down: Object.freeze(h.technical_down),
    surface_roughness: Object.freeze(h.surface_roughness),
    climb: Object.freeze({
      comfortable_speed_kmh: climb.comfortable_speed_kmh,
      grinding_speed_kmh: climb.grinding_speed_kmh,
      sustained_watts: climb.sustained_watts,
    }),
  });
}

/**
 * How far past comfort a value sits: 0 at `comfortable_until`, 1 at `high_cost_at`.
 *
 * Quartic up to `high_cost_at` so the onset is barely felt and the far side climbs hard —
 * the same shape as the old `(excess / reference) ** 4` slope term, which was the one
 * part of the previous cost model that behaved well. Beyond it the ramp straightens out
 * at the slope it arrived with, which keeps it continuous while stopping a fourth power
 * from running away: left unbounded it drove every genuinely bad edge into the rate
 * ceiling, where a 45% scree slope and a rough 20% track priced identically and the
 * router could no longer tell them apart. It still rises forever, so absurd ground is
 * strongly discouraged, and it stays finite, so nothing is ever impossible.
 */
export function exceedance(value: number, t: Threshold): number {
  if (value <= t.comfortable_until) return 0;
  const span = Math.max(1e-6, t.high_cost_at - t.comfortable_until);
  const over = (value - t.comfortable_until) / span;
  return over <= 1 ? over ** 4 : 1 + (over - 1) * 4;
}
