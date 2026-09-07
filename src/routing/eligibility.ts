import type { Edge, Profile } from "./types";

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
export const isPaved = (edge: Edge) => paved.has(edge.surface);
export const isStreet = (edge: Edge) => streets.has(edge.highway);

/** Access permission alone does not establish suitability for a bicycle profile. */
export function eligible(edge: Edge, profile: Profile): boolean {
  if (!edge.highway) return false; // Old packs lack the information needed to route safely.
  const tags = edge.tags ?? {};
  const mtb = Number.parseFloat(tags["mtb:scale"] ?? "0");
  if (mtb > 0 || (tags.sac_scale && tags.sac_scale !== "hiking")) return false;
  if (
    ["very_bad", "horrible", "very_horrible", "impassable"].includes(
      tags.smoothness ?? "",
    )
  )
    return false;
  if (["grade4", "grade5"].includes(tags.tracktype ?? "")) return false;
  if (["sand", "mud", "rock"].includes(edge.surface)) return false;
  if (profile === "road") {
    if (tags.smoothness === "bad") return false;
    return isPaved(edge) || (edge.surface === "unknown" && isStreet(edge));
  }
  if (
    edge.highway === "path" ||
    edge.highway === "footway" ||
    edge.highway === "pedestrian"
  ) {
    // Unknown hiking paths are not assumed rideable. Keep documented smooth connectors.
    return (
      isPaved(edge) || gravel.has(edge.surface) || tags["mtb:scale"] === "0"
    );
  }
  return isStreet(edge) || edge.highway === "track";
}
