/**
 * What OSM tags say about riding a way: whether it may be ridden at all, which way round,
 * and how rewarding its surface is.
 *
 * A direct port of `scripts/build_region.py:41-145`. The rules encode product decisions —
 * which access values deny, which highways need an explicit `bicycle` tag, how surface
 * evidence combines — so they are reproduced as they stand rather than tidied. Changing
 * what any of them decides is a cost-model change and belongs in its own commit, audited
 * against `tests/fixtures/gold/`.
 */
import { roundTo } from "./round";
import type { OsmTags } from "./osm/pbf";

export const DENIED = new Set(["no", "private", "use_sidepath"]);
export const PAVED = new Set(["asphalt", "concrete", "concrete:plates", "paving_stones", "paved"]);

const BLOCKED_HIGHWAYS = new Set(["construction", "proposed", "abandoned", "raceway", "elevator"]);
/** Rideable only where a `bicycle` tag says so explicitly. */
const NEEDS_PERMISSION = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "footway",
  "pedestrian",
]);
const PERMISSIVE = new Set(["yes", "designated", "permissive", "official"]);
const DESIGNATED = new Set(["yes", "designated"]);
const FOOT_DENIED = new Set(["no", "private"]);
const ONEWAY_FORWARD = new Set(["yes", "1", "true"]);

/** A missing tag is not a member of any set; `Set.has(undefined)` would not type-check. */
const isOneOf = (value: string | undefined, set: Set<string>) =>
  value !== undefined && set.has(value);

/**
 * The effective access value: the most specific of `bicycle`, `vehicle`, `access`, else
 * `yes`. Matches the nested `dict.get` defaults in the Python, where a key that is present
 * but empty still wins over the next fallback.
 */
const accessOf = (tags: OsmTags) => tags.bicycle ?? tags.vehicle ?? tags.access ?? "yes";

export function permitted(tags: OsmTags): boolean {
  const access = accessOf(tags);
  if (DENIED.has(access)) return false;
  if (
    "bicycle:conditional" in tags ||
    "access:conditional" in tags ||
    "vehicle:conditional" in tags
  )
    return false;
  const highway = tags.highway ?? "";
  if (BLOCKED_HIGHWAYS.has(highway)) return false;
  if (NEEDS_PERMISSION.has(highway) && !isOneOf(tags.bicycle, PERMISSIVE)) return false;
  if (tags.motorroad === "yes" && !isOneOf(tags.bicycle, DESIGNATED)) return false;
  if (
    (highway === "steps" || access === "dismount") &&
    FOOT_DENIED.has(tags.foot ?? tags.access ?? "yes")
  )
    return false;
  return highway !== "" || tags.route === "ferry";
}

/** Which way round a way may be ridden, as `[forward, backward]`. */
export function directions(tags: OsmTags): [boolean, boolean] {
  let direction =
    tags["oneway:bicycle"] ??
    tags.oneway ??
    (tags.junction === "roundabout" ? "yes" : "no");
  // A contraflow cycle lane undoes the one-way for a bicycle.
  if (
    (tags.cycleway ?? "").startsWith("opposite") ||
    (tags["cycleway:left"] ?? "").startsWith("opposite") ||
    (tags["cycleway:right"] ?? "").startsWith("opposite")
  )
    direction = "no";
  const forward = direction !== "-1" && !isOneOf(tags["bicycle:forward"], DENIED);
  const backward =
    !ONEWAY_FORWARD.has(direction) && !isOneOf(tags["bicycle:backward"], DENIED);
  return [forward, backward];
}

/** Golden-gravel quality: how rewarding a surface is to ride, not just how rideable. */
const SURFACE_QUALITY: Record<string, number> = {
  fine_gravel: 1.0,
  compacted: 0.85,
  gravel: 0.7,
  unpaved: 0.5,
  ground: 0.4,
  dirt: 0.35,
  cobblestone: 0.3,
  grass: 0.2,
  paved: 0.15,
  sand: 0.0,
  mud: 0.0,
  rock: 0.0,
};
const TRACK_QUALITY: Record<string, number> = {
  grade1: 1.0,
  grade2: 0.85,
  grade3: 0.6,
  grade4: 0.2,
  grade5: 0.2,
};
const SMOOTHNESS_QUALITY: Record<string, number> = {
  excellent: 1.0,
  good: 1.0,
  intermediate: 0.85,
  bad: 0.5,
  very_bad: 0.25,
  horrible: 0.05,
  very_horrible: 0.0,
  impassable: 0.0,
};
const QUALITY_HIGHWAYS = new Set(["track", "path", "bridleway"]);

/** A tag that is absent scores nothing; a tag whose value is unknown scores nothing either. */
const score = (table: Record<string, number>, value: string | undefined) =>
  value === undefined ? undefined : table[value];

export function edgeQuality(
  highway: string,
  surface: string,
  tags: OsmTags,
  stress: number,
): number {
  if (!QUALITY_HIGHWAYS.has(highway)) return 0.0;
  // Missing tags are absence of evidence, not mediocre evidence: multiplying three guessed
  // defaults kept a track described only by a good tracktype from ever becoming a quality
  // source. Among facts that are present, the weakest one wins: grade1 never turns mud into
  // a quality surface.
  const evidence = [
    score(SURFACE_QUALITY, surface),
    score(TRACK_QUALITY, tags.tracktype),
    score(SMOOTHNESS_QUALITY, tags.smoothness),
  ].filter((value): value is number => value !== undefined);
  if (evidence.length === 0) return 0.0;
  return roundTo(Math.max(0.0, Math.min(...evidence) * (1 - 0.5 * stress)), 3);
}
