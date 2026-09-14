import type { Edge, Point } from "./types";
import { isFerry, isStreet, PAVED_SURFACES, SAC_LEVELS } from "./tagging";

/**
 * What a way is like under a wheel, read once from its tags.
 *
 * The cost function needs continuous quantities — how rough, how technical, how twisty —
 * and OSM offers overlapping, partly contradictory categorical evidence. Turning that
 * into numbers is a separate job from deciding what to do with them, and it is the same
 * job for eligibility, scoring and the capability model, so it lives here.
 */
export type Signals = {
  /** 0 (tarmac) to 1 (sand). */
  roughness: number;
  /** Normalized technical difficulty, per direction of travel. */
  technicalUp: number;
  technicalDown: number;
  /** 0 (certainly sealed) to 1 (certainly not). Inferred where the tag is missing. */
  unpaved: number;
  /** Whether `unpaved` rests on an actual `surface` tag or on the road hierarchy. */
  surfaceKnown: boolean;
  /** Mean turn per metre, normalized. Amplifies descent cost; harmless uphill. */
  curvature: number;
};

const SURFACE_ROUGHNESS: Record<string, number> = {
  paved: 0.02,
  asphalt: 0.02,
  concrete: 0.05,
  "concrete:plates": 0.12,
  paving_stones: 0.14,
  compacted: 0.15,
  fine_gravel: 0.22,
  pebblestone: 0.38,
  gravel: 0.45,
  unpaved: 0.5,
  sett: 0.5,
  wood: 0.5,
  metal: 0.5,
  cobblestone: 0.6,
  unhewn_cobblestone: 0.68,
  ground: 0.6,
  earth: 0.6,
  dirt: 0.6,
  woodchips: 0.65,
  grass: 0.7,
  grass_paver: 0.55,
  rock: 0.9,
  stone: 0.85,
  sand: 0.95,
  mud: 0.95,
};

const SMOOTHNESS_ROUGHNESS: Record<string, number> = {
  excellent: 0.02,
  good: 0.1,
  intermediate: 0.25,
  bad: 0.45,
  very_bad: 0.65,
  horrible: 0.85,
  very_horrible: 0.95,
  impassable: 1,
};

const TRACKTYPE_ROUGHNESS: Record<string, number> = {
  grade1: 0.12,
  grade2: 0.28,
  grade3: 0.45,
  grade4: 0.65,
  grade5: 0.85,
};

/** `mtb:scale` 0-6, with `+` reading as half a level. */
const MTB_SCALE = [0, 0.18, 0.36, 0.55, 0.72, 0.88, 1];
/** `sac_scale` T1-T6. Hiking difficulty is not MTB difficulty, but it bounds it. */
const SAC_SCALE = [0.15, 0.35, 0.55, 0.75, 0.9, 1];

function interpolate(table: number[], value: number): number {
  const low = Math.floor(value),
    high = Math.min(table.length - 1, low + 1);
  if (low >= table.length - 1) return table[table.length - 1];
  return table[low] + (table[high] - table[low]) * (value - low);
}

function mtbScale(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-6]\+?$/.test(value)) return undefined;
  return interpolate(
    MTB_SCALE,
    Number(value[0]) + (value.endsWith("+") ? 0.5 : 0),
  );
}

function sacScale(value: string | undefined): number | undefined {
  const index = value === undefined ? -1 : SAC_LEVELS.indexOf(value);
  return index < 0 ? undefined : SAC_SCALE[index];
}

/**
 * How much a line turns, per metre, normalized so a genuinely twisty descent reads near 1.
 *
 * Only the interior vertices carry a turn, so a straight two-point edge is 0. This is
 * deliberately crude: it exists to keep a rider off a steep road that also happens to be
 * a series of blind hairpins, not to model cornering.
 */
function curvature(geometry: Point[], length: number): number {
  if (geometry.length < 3 || length <= 0) return 0;
  let turned = 0;
  for (let i = 1; i < geometry.length - 1; i++) {
    const [ax, ay] = geometry[i - 1],
      [bx, by] = geometry[i],
      [cx, cy] = geometry[i + 1];
    // Longitude shrinks with latitude; at these scales one cosine for the edge is plenty.
    const k = Math.cos((by * Math.PI) / 180);
    const a = Math.atan2(by - ay, (bx - ax) * k),
      b = Math.atan2(cy - by, (cx - bx) * k);
    let d = Math.abs(b - a);
    if (d > Math.PI) d = 2 * Math.PI - d;
    turned += d;
  }
  // 0.02 rad/m — about one right angle every 80 m — is as twisty as this needs to read.
  return Math.min(1, turned / length / 0.02);
}

export function edgeSignals(edge: Edge): Signals {
  if (edge.semantics?.version === 1) return edge.semantics;
  const tags = edge.tags ?? {};
  if (isFerry(edge))
    return {
      roughness: 0,
      technicalUp: 0,
      technicalDown: 0,
      unpaved: 0,
      surfaceKnown: true,
      curvature: 0,
    };

  const surfaceRoughness = SURFACE_ROUGHNESS[edge.surface];
  const mtb = mtbScale(tags["mtb:scale"]);
  // `smoothness` names a vehicle class rather than the ground, and `very_bad` ("MTB,
  // tractor") is routinely put on any unsealed track. `mtb:scale=0` is the more specific
  // claim — firm ground, no obstacles — so it bounds what smoothness may say. Without
  // this the Ancienne Voie du Tram above Seyssins, `mtb:scale=0` and `tracktype=grade2`,
  // read as broken ground and lost to the hairpin road beside it.
  const smoothness = SMOOTHNESS_ROUGHNESS[tags.smoothness ?? ""];
  const candidates = [
    surfaceRoughness,
    smoothness !== undefined && mtb !== undefined && mtb < MTB_SCALE[1]
      ? Math.min(smoothness, SURFACE_ROUGHNESS.gravel)
      : smoothness,
    TRACKTYPE_ROUGHNESS[tags.tracktype ?? ""],
  ].filter((v): v is number => v !== undefined);
  // The worst credible evidence wins. `smoothness=excellent` on sand describes the
  // grading, not the sand, and a narrow tire still sinks.
  const roughness = candidates.length
    ? Math.max(...candidates)
    : isStreet(edge)
      ? 0.1
      : edge.highway === "track"
        ? 0.35
        : 0.45;

  const sac = sacScale(tags.sac_scale);
  const unknownPath =
    ["path", "footway", "pedestrian", "bridleway"].includes(edge.highway) &&
    mtb === undefined &&
    sac === undefined &&
    !PAVED_SURFACES.has(edge.surface)
      ? // An unsurveyed path is not assumed easy and not assumed impossible. It used to be
        // `allow_unknown_paths`, a boolean that either deleted every one of them or none.
        0.25
      : 0;
  const technical = (direction: "uphill" | "downhill") =>
    Math.max(
      mtbScale(tags[`mtb:scale:${direction}`]) ?? mtb ?? 0,
      sac ?? 0,
      unknownPath,
    );

  const tagged = edge.surface !== "unknown" && edge.surface !== undefined;
  // `tracktype` grade2 and worse describes the ground itself — gravel, earth, grass — so
  // it is evidence of unpaved ground as much as `surface` is. grade1 is "solid", which
  // is as often asphalt as compacted gravel, and stays a guess. Around Geneva most farm
  // and forest tracks carry a tracktype and no surface, and without this none of them
  // could ever earn the credit a gravel rider is looking for.
  const graded = !tagged && UNPAVED_TRACKTYPES.has(tags.tracktype ?? "");
  const known = tagged || graded;
  const unpaved = tagged
    ? PAVED_SURFACES.has(edge.surface)
      ? 0
      : 1
    : graded
      ? 1
      : isStreet(edge)
        ? 0.1
        : edge.highway === "track"
          ? 0.8
          : 0.7;

  return {
    roughness,
    technicalUp: technical("uphill"),
    technicalDown: technical("downhill"),
    unpaved,
    surfaceKnown: known,
    curvature: curvature(edge.geometry, edge.length),
  };
}

const UNPAVED_TRACKTYPES = new Set(["grade2", "grade3", "grade4", "grade5"]);

/**
 * How good the surroundings of a way are, 0 to 1.
 *
 * `reward` is decayed distance to the nearest attractor ahead, which is right for
 * discounting a hard section with something good after it, and wrong on its own for
 * telling lines apart: with forest a 0.5-strength source, every road within a few hundred
 * metres of a wood reads about the same as the path through it. The way's own forest
 * cover and gravel quality say what riding *this* line is like, so the better of the
 * three is used.
 */
export const scenicValue = (edge: Edge): number =>
  Math.max(edge.reward ?? 0, edge.forest ?? 0, edge.quality ?? 0);
