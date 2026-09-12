import type { Edge } from "./types";
import type { CompiledProfile } from "./compile";
import { toCompiled } from "./compile";
import type { Profile } from "./profiles";
import { edgeSignals, type Signals } from "./signals";
import { exceedance } from "./capability";
import {
  footBarred,
  GRAVEL_SURFACES,
  isFerry,
  isPaved,
  isStreet,
  RIDEABLE_HIGHWAYS,
  ROUGH_SURFACES,
} from "./tagging";

export {
  isFerry,
  isPaved,
  isStreet,
  GRAVEL_SURFACES,
  ROUGH_SURFACES,
} from "./tagging";

/**
 * What a rider is not allowed to do — and nothing about what they would rather not do.
 *
 * This file used to decide both. `max_grade_up`, `max_mtb_scale_*`, `max_smoothness`,
 * `max_track_grade`, `paved_only` and `allow_rough_surfaces` all deleted edges from the
 * graph, so a preference could return `no-path`: three unsampled bridges once stranded
 * the whole Voirons massif from every profile that set a grade limit. All of those are
 * now cost, in `scoreEdge`, where being steep or loose makes a way expensive and never
 * makes it disappear. What remains here is only what a rider genuinely may not do: legal
 * access, and the three things they explicitly opted into or out of.
 */

/**
 * How a stretch of road will feel under the wheels, for the map.
 *
 * This is presentation, not cost: the router already decided to come this way, and the
 * point of the classification is to make that decision inspectable. A kilometre of
 * `walk` or `rough` in the middle of a route is the signal that the chosen line is not
 * what the rider had in mind.
 */
export type RideClass =
  "paved" | "gravel" | "rough" | "walk" | "ferry" | "unknown";

export function rideClass(
  edge: Edge,
  mode: "ride" | "walk" | "ferry" | "blocked",
): RideClass {
  if (mode === "ferry" || isFerry(edge)) return "ferry";
  // Blocked segments cannot appear in a finished route, but if one ever did it would be
  // pushed rather than ridden, so it reads the same way.
  if (mode === "walk" || mode === "blocked") return "walk";
  if (isPaved(edge)) return "paved";
  if (GRAVEL_SURFACES.has(edge.surface)) return "gravel";
  if (ROUGH_SURFACES.has(edge.surface)) return "rough";
  // Most ways carry no `surface` at all — three quarters of the Voirons network — so the
  // old fallback to "rough" turned that silence into a claim and drew broken ground over
  // ordinary tarmac. Read the hierarchy instead, and only say "unknown" when the
  // hierarchy is silent too.
  if (isStreet(edge)) return "paved";
  const track = /^grade([1-5])$/.exec(edge.tags?.tracktype ?? "");
  if (track) return Number(track[1]) <= 3 ? "gravel" : "rough";
  // A `highway=track` is an unsurfaced farm or forest road by definition. An untagged
  // path genuinely could be anything, and says so.
  if (edge.highway === "track") return "gravel";
  return "unknown";
}

export type TraversalSegment = {
  length: number;
  grade: number | null;
  mode: "ride" | "walk" | "ferry" | "blocked";
};

/**
 * Split an edge by grade run and decide, for each run, whether it is ridden or pushed.
 *
 * "Pushed" is not a judgement about difficulty — cost handles that — it is the point
 * where the capability model says the pedals stop turning. `high_cost_at` is derived as
 * exactly that: the grade at which full effort in the lowest gear falls to a 40 rpm
 * grind, which is where walking stops being slower. Past it, the rider is on foot, and
 * whether that is allowed is `permissions.push`.
 */
export function traversalSegments(
  edge: Edge,
  input: Profile | CompiledProfile,
  signals?: Signals,
): TraversalSegment[] {
  const p = toCompiled(input);
  const s = signals ?? edgeSignals(edge);
  return (edge.grades ?? [[edge.length, null]]).map(([length, grade]) => ({
    length: length!,
    grade,
    mode: segmentMode(edge, grade, p, s),
  }));
}

function segmentMode(
  edge: Edge,
  grade: number | null,
  p: CompiledProfile,
  s: Signals,
): TraversalSegment["mode"] {
  if (isFerry(edge)) return p.permissions.ferry ? "ferry" : "blocked";
  const tags = edge.tags ?? {};
  const k = p.capability;

  let walking = tags.bicycle === "dismount" || edge.highway === "steps";
  if (!walking) {
    const technical =
      grade !== null && grade < 0
        ? exceedance(s.technicalDown, k.technical_down)
        : exceedance(s.technicalUp, k.technical_up);
    // An unmeasured grade is a gap in the terrain data, never evidence that the way is
    // impassable. Bridges and tunnels are deliberately left unsampled — the DEM reads the
    // ground under a deck and the mountain over a bore — so treating a missing grade as
    // unrideable deletes cut vertices. Treat it as flat and let cost decide.
    const slope =
      grade === null
        ? 0
        : grade > 0
          ? exceedance(grade, k.uphill_grade)
          : exceedance(-grade, k.downhill_grade);
    walking = technical >= 1 || slope >= 1;
  }
  if (!walking) return "ride";

  // Refusing to push is a strong preference, not a physical impossibility: a rider can
  // always get off and walk, they just very much do not want to. Pricing it instead of
  // blocking it is what keeps a preference from ever returning "no-path" — and it is what
  // the spec meant by a permission, which may be used "with its normal large penalty".
  // Only the law stops a rider here.
  return footBarred(edge) ? "blocked" : "walk";
}

/**
 * The hard gate. Legal access, the highway whitelist, and the three permissions.
 *
 * Everything a profile used to exclude for being too rough, too steep or too technical
 * now survives this function and is priced instead.
 */
export function eligible(
  edge: Edge,
  input: Profile | CompiledProfile,
): boolean {
  const p = toCompiled(input);
  const tags = edge.tags ?? {};
  if (!edge.highway) return false;
  if (
    ["no", "private", "use_sidepath"].includes(
      tags.bicycle ?? tags.access ?? "",
    )
  )
    return false;
  // Stairs a rider did not permit are priced as a last resort in `scoreEdge`, not removed.
  if (edge.highway === "steps" && footBarred(edge)) return false;
  if (isFerry(edge)) return p.permissions.ferry;
  if (!isStreet(edge) && !RIDEABLE_HIGHWAYS.has(edge.highway)) return false;
  // Surfaces tagged `impassable` are not a preference anyone can hold.
  if (tags.smoothness === "impassable") return false;
  return traversalSegments(edge, p).every((s) => s.mode !== "blocked");
}
