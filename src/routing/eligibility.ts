import type { Edge } from "./types";
import {
  resolveProfile,
  type ProfileInput,
  type ResolvedProfile,
} from "./profiles";

const paved = new Set([
  "paved",
  "asphalt",
  "concrete",
  "concrete:plates",
  "paving_stones",
]);
const gravel = new Set([
  "compacted",
  "fine_gravel",
  "gravel",
  "unpaved",
  "pebblestone",
]);
const streets = new Set([
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "service",
  "living_street",
  "cycleway",
]);
export const isFerry = (edge: Edge) =>
  edge.highway === "ferry" || edge.tags?.route === "ferry";
export const isPaved = (edge: Edge) => paved.has(edge.surface);
export const isStreet = (edge: Edge) => streets.has(edge.highway);

const sacLevels = [
  "hiking",
  "mountain_hiking",
  "demanding_mountain_hiking",
  "alpine_hiking",
  "demanding_alpine_hiking",
  "difficult_alpine_hiking",
];
const smoothnessLevels = [
  "excellent",
  "good",
  "intermediate",
  "bad",
  "very_bad",
  "horrible",
  "very_horrible",
  "impassable",
];
function scale(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-6]\+?$/.test(value)) return NaN;
  return Number(value[0]) + (value.endsWith("+") ? 0.5 : 0);
}

/** Segment classification is shared by eligibility, scoring, and reporting. */
export function traversalSegments(edge: Edge, input: ProfileInput) {
  const p = resolveProfile(input);
  return (edge.grades ?? [[edge.length, null]]).map(([length, grade]) => ({
    length: length!,
    grade,
    mode: segmentMode(edge, grade, p),
  }));
}
function segmentMode(
  edge: Edge,
  grade: number | null,
  p: ResolvedProfile,
): "ride" | "walk" | "ferry" | "blocked" {
  if (isFerry(edge)) return p.access.ferry ? "ferry" : "blocked";
  const t = edge.tags ?? {},
    c = p.capabilities;
  const directions: ("up" | "down")[] =
    grade === null || grade === 0
      ? ["up", "down"]
      : grade > 0
        ? ["up"]
        : ["down"];
  const sac =
    t.sac_scale === undefined ? undefined : sacLevels.indexOf(t.sac_scale) + 1;
  if (
    sac === 0 ||
    directions.some((d) => sac !== undefined && sac > c[`max_hike_sac_${d}`])
  )
    return "blocked";
  let walking = t.bicycle === "dismount" || edge.highway === "steps";
  for (const d of directions) {
    const mtb = scale(
      t[`mtb:scale:${d === "up" ? "uphill" : "downhill"}`] ?? t["mtb:scale"],
    );
    if (mtb !== undefined && !Number.isFinite(mtb)) return "blocked";
    // Hiking classification alone establishes walking terrain, not rideability.
    if (
      ["path", "footway", "pedestrian"].includes(edge.highway) &&
      !c.allow_unknown_paths &&
      !isPaved(edge) &&
      !gravel.has(edge.surface) &&
      mtb === undefined
    )
      walking = true;
    const limit = c[`max_grade_${d}`];
    // A configured grade limit cannot be verified against missing elevation.
    if (grade === null && limit !== null && !walking) return "blocked";
    if (
      (mtb ?? 0) > c[`max_mtb_scale_${d}`] ||
      (grade !== null && limit !== null && Math.abs(grade) * 100 > limit)
    )
      walking = true;
  }
  if (!walking) return "ride";
  const documentedWalking =
    edge.highway === "steps" ||
    sac !== undefined ||
    isStreet(edge) ||
    isPaved(edge) ||
    gravel.has(edge.surface);
  if (
    !p.access.hike_a_bike ||
    t.foot === "no" ||
    t.foot === "private" ||
    !documentedWalking
  )
    return "blocked";
  return "walk";
}

export function eligible(edge: Edge, input: ProfileInput): boolean {
  const p = resolveProfile(input),
    c = p.capabilities,
    tags = edge.tags ?? {};
  if (!edge.highway) return false;
  if (
    ["no", "private", "use_sidepath"].includes(
      tags.bicycle ?? tags.access ?? "",
    )
  )
    return false;
  if (edge.highway === "steps" && !p.access.steps) return false;
  if (isFerry(edge)) return p.access.ferry;
  const smoothness = smoothnessLevels.indexOf(tags.smoothness ?? "");
  if (smoothness > c.max_smoothness) return false;
  const track = /^grade([1-5])$/.exec(tags.tracktype ?? "");
  if (track && Number(track[1]) > c.max_track_grade) return false;
  if (!c.allow_rough_surfaces && ["sand", "mud", "rock"].includes(edge.surface))
    return false;
  if (
    edge.highway !== "steps" &&
    c.paved_only &&
    !(isPaved(edge) || (edge.surface === "unknown" && isStreet(edge)))
  )
    return false;
  if (
    !isStreet(edge) &&
    !["track", "steps", "ferry", "path", "footway", "pedestrian"].includes(
      edge.highway,
    )
  )
    return false;
  return traversalSegments(edge, p).every((s) => s.mode !== "blocked");
}
