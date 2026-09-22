/**
 * What the builder keeps out of a raw OpenStreetMap extract.
 *
 * `scripts/clip_region.py` ran this once over a region as an `osmium tags-filter`, so the
 * per-cell extracts the builder used were already reduced. Building straight from a
 * Geofabrik download means doing it here instead: a country extract holds millions of ways
 * the graph never looks at, and each one costs an object and a refs array.
 *
 * The rules are the `FILTERS` list from that script, verbatim in intent. A node's *location*
 * is never filtered — ways need the shape of nodes that carry no tags at all — so this only
 * decides which elements become `CellSource.nodes`, `.ways` and `.relations`.
 */
import type { OsmTags } from "./pbf";

const LANDUSE = new Set([
  "forest",
  "residential",
  "commercial",
  "industrial",
  "retail",
  "garages",
  "construction",
]);
const PLACES = new Set(["city", "town", "village"]);
/** Small things people put where a place is worth stopping; they cluster into attractors. */
const AMENITIES = new Set(["bench", "drinking_water", "fountain", "shelter", "water_point"]);
const TOURISM = new Set(["viewpoint", "picnic_site", "information"]);
const NATURAL_POINTS = new Set(["peak", "saddle"]);
const CYCLING_ROUTES = new Set(["bicycle", "mtb"]);

/** The road network, ferries, water, and the land use the cost surfaces are painted from. */
export function keepWay(tags: OsmTags): boolean {
  if ("highway" in tags) return true;
  if (tags.route === "ferry") return true;
  if (tags.natural === "water" || tags.natural === "wood") return true;
  if ("waterway" in tags) return true;
  return tags.landuse !== undefined && LANDUSE.has(tags.landuse);
}

/** Turn restrictions, ferry and cycling route membership, and multipolygon land use. */
export function keepRelation(tags: OsmTags): boolean {
  if (tags.type === "restriction") return true;
  if (tags.route === "ferry") return true;
  if (tags.type === "route" && tags.route !== undefined && CYCLING_ROUTES.has(tags.route))
    return true;
  if (tags.natural === "water" || tags.natural === "wood") return true;
  return tags.landuse !== undefined && LANDUSE.has(tags.landuse);
}

/**
 * Barriers, settlement seeds, and the reward and attractor seeds.
 *
 * `barrier` is kept on any node rather than only on road nodes: which nodes a road uses is
 * not known until the ways are read, and a barrier tag is rare enough to keep wholesale.
 */
export function keepNode(tags: OsmTags): boolean {
  if ("barrier" in tags) return true;
  if (tags.mountain_pass === "yes") return true;
  if (tags.leisure === "picnic_table") return true;
  if (tags.place !== undefined && PLACES.has(tags.place)) return true;
  if (tags.tourism !== undefined && TOURISM.has(tags.tourism)) return true;
  if (tags.natural !== undefined && NATURAL_POINTS.has(tags.natural)) return true;
  return tags.amenity !== undefined && AMENITIES.has(tags.amenity);
}
