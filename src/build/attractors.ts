/**
 * Places worth riding to, read from what people built there.
 *
 * Nobody puts two benches, a guidepost and a viewpoint at random: each is a small
 * investment someone made because the spot deserved it, so together they say more than any
 * one of them. A viewpoint, peak or pass is a full source on its own; the small amenities
 * add up towards one, and without one they only count once two kinds agree, since a single
 * bench is on every village square.
 *
 * A direct port of `scripts/build_region.py:172-292`. The weights and radii are product
 * decisions and are reproduced as they stand.
 */
import { distance } from "../geo/distance";
import { roundTo } from "./round";
import type { OsmTags } from "./osm/pbf";
import type { Point } from "../routing/types";

export type AttractorKind =
  | "viewpoint"
  | "peak"
  | "pass"
  | "bench"
  | "water"
  | "picnic"
  | "shelter"
  | "guidepost"
  | "board";

/** `[lon, lat, kind]`, as the builder collects them from tagged nodes. */
export type AttractorPoint = [number, number, AttractorKind];
/** `[lon, lat, strength]` at a cluster's centroid. */
export type Cluster = [number, number, number];

const SUMMIT_KINDS = new Set<AttractorKind>(["viewpoint", "peak", "pass"]);
const AMENITY_WEIGHT: Record<AttractorKind, number> = {
  viewpoint: 1.0,
  peak: 1.0,
  pass: 1.0,
  bench: 0.3,
  water: 0.3,
  picnic: 0.3,
  shelter: 0.3,
  guidepost: 0.2,
  board: 0.2,
};
/** A second bench still says something; a promenade lined with them does not say more. */
const BENCHES_COUNTED = 2;
/**
 * As strong as a source gets: the field is a scenic signal per way, not a destination
 * value, and more than a viewpoint's strength spread credit over a whole village.
 */
const ATTRACTOR_MAX = 1.0;
const CLUSTER_RADIUS_M = 100;

export function attractorKind(tags: OsmTags): AttractorKind | undefined {
  if (tags.tourism === "viewpoint") return "viewpoint";
  if (tags.natural === "peak") return "peak";
  if (tags.natural === "saddle" || tags.mountain_pass === "yes") return "pass";
  const amenity = tags.amenity;
  if (amenity === "bench") return "bench";
  if (amenity === "drinking_water" || amenity === "fountain" || amenity === "water_point")
    return "water";
  if (amenity === "shelter") return "shelter";
  if (tags.tourism === "picnic_site" || tags.leisure === "picnic_table") return "picnic";
  if (tags.tourism === "information")
    return tags.information === "guidepost"
      ? "guidepost"
      : tags.information === "board"
        ? "board"
        : undefined;
  return undefined;
}

/** How strongly a cluster of amenity kinds draws a rider, 0 when it does not. */
export function clusterStrength(kinds: AttractorKind[]): number {
  // Insertion-ordered like Python's Counter, because the weights are summed in this order
  // and floating-point addition is not associative.
  const counts = new Map<AttractorKind, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  let summit = false;
  for (const kind of counts.keys()) if (SUMMIT_KINDS.has(kind)) summit = true;
  if (!summit && counts.size < 2) return 0.0;
  let total = 0;
  for (const [kind, n] of counts)
    total += AMENITY_WEIGHT[kind] * (kind === "bench" ? Math.min(n, BENCHES_COUNTED) : 1);
  return roundTo(Math.min(ATTRACTOR_MAX, total), 3);
}

/**
 * Group points within `radiusM` of each other, single-linkage, at their centroid.
 *
 * A uniform grid bounds the neighbour search and union-find joins the chains, so a ridge
 * of benches 90 m apart becomes one cluster rather than several.
 */
export function attractorClusters(
  points: AttractorPoint[],
  radiusM = CLUSTER_RADIUS_M,
  cell = 0.002,
): Cluster[] {
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${x},${y}`;
  for (let i = 0; i < points.length; i++) {
    const k = key(Math.floor(points[i][0] / cell), Math.floor(points[i][1] / cell));
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }

  const parent = Array.from(points, (_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  for (let i = 0; i < points.length; i++) {
    const cx = Math.floor(points[i][0] / cell);
    const cy = Math.floor(points[i][1] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(key(cx + dx, cy + dy)) ?? [])
          if (
            j > i &&
            distance([points[i][0], points[i][1]], [points[j][0], points[j][1]]) <= radiusM
          )
            parent[root(j)] = root(i);
  }

  // Members are gathered in index order so the centroid sums in the same order as Python's.
  const members = new Map<number, AttractorPoint[]>();
  for (let i = 0; i < points.length; i++) {
    const r = root(i);
    const group = members.get(r);
    if (group) group.push(points[i]);
    else members.set(r, [points[i]]);
  }

  const clusters: Cluster[] = [];
  for (const group of members.values()) {
    const strength = clusterStrength(group.map((p) => p[2]));
    if (strength > 0) {
      let lon = 0;
      let lat = 0;
      for (const p of group) {
        lon += p[0];
        lat += p[1];
      }
      clusters.push([lon / group.length, lat / group.length, strength]);
    }
  }
  return clusters;
}

/**
 * Collect the attractor points a cell's tagged nodes describe, in file order.
 *
 * Order matters: single-linkage grouping and the centroid mean both depend on it, so this
 * walks the nodes as the extract presents them.
 */
export function attractorPoints(nodes: readonly { lon: number; lat: number; tags: OsmTags }[]) {
  const points: AttractorPoint[] = [];
  for (const node of nodes) {
    const kind = attractorKind(node.tags);
    if (kind) points.push([node.lon, node.lat, kind]);
  }
  return points;
}

/** Point at fraction `t` (0..1) along a polyline, by arc length. */
export function interpolatePolyline(
  coords: readonly Point[],
  t: number,
  totalLength: number,
): Point {
  if (coords.length === 1 || totalLength <= 0) return coords[0];
  const target = t * totalLength;
  let covered = 0.0;
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const seg = distance(a, b);
    if (seg === 0) continue;
    if (covered + seg >= target) {
      const frac = (target - covered) / seg;
      return [a[0] + frac * (b[0] - a[0]), a[1] + frac * (b[1] - a[1])];
    }
    covered += seg;
  }
  return coords[coords.length - 1];
}
