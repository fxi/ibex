import type { Edge } from "./types";

/**
 * Tag predicates shared by signal extraction, eligibility and display.
 *
 * Separate from both so `signals.ts` and `eligibility.ts` can depend on it without
 * depending on each other.
 */
export const PAVED_SURFACES = new Set([
  "paved",
  "asphalt",
  "concrete",
  "concrete:plates",
  "paving_stones",
]);

export const GRAVEL_SURFACES = new Set([
  "compacted",
  "fine_gravel",
  "gravel",
  "unpaved",
  "pebblestone",
]);

/**
 * Rideable, but loose, broken or slow. Setts and cobbles are paved in OSM's sense and
 * rough under a wheel: this table describes the ride, not the tagging.
 */
export const ROUGH_SURFACES = new Set([
  "dirt",
  "ground",
  "earth",
  "grass",
  "grass_paver",
  "mud",
  "sand",
  "rock",
  "stone",
  "woodchips",
  "sett",
  "cobblestone",
  "unhewn_cobblestone",
  "metal",
  "wood",
]);

export const STREETS = new Set([
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

/** Ways a bicycle may be on at all, ridden or pushed. */
export const RIDEABLE_HIGHWAYS = new Set([
  "track",
  "steps",
  "ferry",
  "path",
  "footway",
  "pedestrian",
  "bridleway",
]);

export const isFerry = (edge: Edge) =>
  edge.highway === "ferry" || edge.tags?.route === "ferry";
export const isPaved = (edge: Edge) => PAVED_SURFACES.has(edge.surface);
export const isStreet = (edge: Edge) => STREETS.has(edge.highway);

export const SAC_LEVELS = [
  "hiking",
  "mountain_hiking",
  "demanding_mountain_hiking",
  "alpine_hiking",
  "demanding_alpine_hiking",
  "difficult_alpine_hiking",
];

/** Legally barred from walking, which is the only thing that can stop a rider pushing. */
export const footBarred = (edge: Edge) =>
  edge.tags?.foot === "no" || edge.tags?.foot === "private";
