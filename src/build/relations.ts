/**
 * What OSM relations say about a way: that it carries a signed cycling route, or that it is
 * a scheduled ferry.
 *
 * Ported from `scripts/profile_features.py`. Both answers come from relations rather than
 * from the way's own tags, which is why they are here and not in `tags.ts`.
 */
import { distance } from "../geo/distance";
import { geometry, type CellSource, type OsmWay } from "./osm/source";
import type { OsmTags } from "./osm/pbf";

export type Direction = "forward" | "backward";

const BOTH: Direction[] = ["forward", "backward"];
/** A route that is not built yet, or not signed, is not a network to follow. */
const UNBUILT = new Set(["proposed", "planned", "construction"]);

/**
 * Which ways carry a signed cycling route, and in which direction.
 *
 * Member roles are relative to OSM way direction, and routes nest — a national route is
 * often a relation of relations — so this walks sub-relations, narrowing the directions it
 * carries as it goes, and guards against a cycle in the membership graph.
 */
export function cyclingMemberships(source: CellSource): Map<number, Set<Direction>> {
  const memberships = new Map<number, Set<Direction>>();
  const relations = new Map(source.relations.map((r) => [r.id, r]));

  const visit = (id: number, directions: readonly Direction[], seen: Set<number>) => {
    if (seen.has(id)) return;
    const relation = relations.get(id);
    if (!relation) return;
    const inner = new Set(seen).add(id);
    for (const member of relation.members) {
      const role = member.role;
      const allowed =
        role === "forward" || role === "backward"
          ? directions.filter((d) => d === role)
          : directions;
      if (member.type === "way") {
        const set = memberships.get(member.ref) ?? new Set<Direction>();
        for (const d of allowed) set.add(d);
        memberships.set(member.ref, set);
      } else if (member.type === "relation") {
        visit(member.ref, allowed, inner);
      }
    }
  };

  for (const relation of source.relations) {
    const tags = relation.tags;
    if (
      tags.type === "route" &&
      (tags.route === "bicycle" || tags.route === "mtb") &&
      !UNBUILT.has(tags.state ?? "") &&
      tags.signposted !== "no"
    )
      visit(relation.id, BOTH, new Set());
  }
  return memberships;
}

const LEGACY_NETWORK_KEYS = ["lcn", "rcn", "ncn", "icn"] as const;

/** 1 when a way carries a cycling network in this direction, 0 otherwise. */
export function onCyclingNetwork(
  way: OsmWay,
  direction: Direction,
  memberships: ReadonlyMap<number, Set<Direction>>,
): number {
  const legacy = LEGACY_NETWORK_KEYS.some(
    (key) => way.tags[key] === "yes" || Boolean(way.tags[`${key}_ref`]),
  );
  return legacy || memberships.get(way.id)?.has(direction) ? 1 : 0;
}

/** Python's `int()`: whitespace and a sign are fine, a decimal point is not. */
function strictInt(text: string): number | undefined {
  if (!/^\s*[+-]?\d+\s*$/.test(text)) return undefined;
  return Number(text);
}

/**
 * An OSM `duration` as seconds: `MM`, `HH:MM` or `HH:MM:SS`.
 *
 * Anything longer than a week, zero, or negative is not a crossing time; it is a typo, and
 * a wrong ferry duration is worse than none.
 */
export function durationSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.split(":").map(strictInt);
  if (parts.some((p) => p === undefined)) return undefined;
  const numbers = parts as number[];
  if (numbers.length > 3 || numbers.some((p) => p < 0)) return undefined;
  const seconds =
    numbers.length === 1
      ? numbers[0] * 60
      : numbers[0] * 3600 + numbers[1] * 60 + (numbers.length === 3 ? numbers[2] : 0);
  return seconds > 0 && seconds <= 7 * 86400 ? seconds : undefined;
}

export type FerryInfo = { tags: OsmTags; source: string; seconds: number | undefined };

/**
 * Ferry ways, with the metadata their relation carries.
 *
 * Relation metadata applies only to the water crossing, never to the road approaches that
 * are also members — otherwise a ferry's duration would be charged to the slipway. A
 * relation's total duration is split between its ways by length, and relations are visited
 * in id order so a way named by two of them takes the same one every build.
 */
export function ferryWays(source: CellSource): Map<number, FerryInfo> {
  const metadata = new Map<number, FerryInfo>();
  const routes = source.relations
    .filter((relation) => relation.tags.route === "ferry")
    .sort((a, b) => a.id - b.id);

  for (const relation of routes) {
    const members: OsmWay[] = [];
    for (const member of relation.members) {
      if (member.type !== "way") continue;
      const way = source.wayById.get(member.ref);
      // Water only: a member that is a road is an approach, not the crossing.
      if (way && (way.tags.route === "ferry" || !("highway" in way.tags))) members.push(way);
    }
    const lengths = new Map<number, number>();
    for (const way of members) {
      const coords = geometry(way, source.positions) ?? [];
      let length = 0;
      for (let i = 0; i + 1 < coords.length; i++) length += distance(coords[i], coords[i + 1]);
      lengths.set(way.id, length);
    }
    let total = 0;
    for (const length of lengths.values()) total += length;
    const duration = durationSeconds(relation.tags.duration);

    for (const way of members) {
      if (metadata.has(way.id)) continue;
      const tags = { ...relation.tags, ...way.tags, route: "ferry" };
      let seconds = durationSeconds(way.tags.duration);
      if (seconds === undefined && duration && total)
        seconds = (duration * lengths.get(way.id)!) / total;
      metadata.set(way.id, { tags, source: `relation/${relation.id}`, seconds });
    }
  }

  // A ferry way that no relation claims still crosses water.
  for (const way of source.ways)
    if (way.tags.route === "ferry" && !metadata.has(way.id))
      metadata.set(way.id, {
        tags: way.tags,
        source: `way/${way.id}`,
        seconds: durationSeconds(way.tags.duration),
      });
  return metadata;
}
