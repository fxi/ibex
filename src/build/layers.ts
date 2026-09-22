/**
 * The OSM layers that paint the cell's surfaces.
 *
 * Each is a rasterised answer to one question: is this ground wooded, is it built up. Rings
 * come straight from closed ways and from multipolygon relations, and go into the raster as
 * they are — no union, no buffering, no prepared geometry, because the fill is even-odd
 * over every ring at once and overlapping woods simply paint the same pixels twice.
 */
import { Surface, type BBox } from "./surface";
import type { Cluster } from "./attractors";
import { geometry, type CellSource } from "./osm/source";
import type { OsmTags } from "./osm/pbf";
import type { Point } from "../routing/types";

const URBAN_LANDUSE = new Set([
  "residential",
  "commercial",
  "industrial",
  "retail",
  "garages",
  "construction",
]);
/** How far a named place spreads, by size. */
const PLACE_RADIUS: Record<string, number> = { city: 1500, town: 700, village: 250 };
/** The gap between plots that is still town: streets, verges, the space around a building. */
const URBAN_SPREAD_M = 40;

export const isForest = (tags: OsmTags) => tags.landuse === "forest" || tags.natural === "wood";
export const isUrban = (tags: OsmTags) => URBAN_LANDUSE.has(tags.landuse ?? "");

const sameEnd = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];

/**
 * Chain line fragments into closed rings.
 *
 * A multipolygon's outer edge is usually split across several ways, given in no order and
 * either direction. Filling each fragment as if it closed on itself paints areas that are
 * not there, so fragments are joined end to end and anything that never closes is dropped.
 */
function chainRings(lines: Point[][]): Point[][] {
  const rings: Point[][] = [];
  const open: Point[][] = [];
  for (const line of lines)
    (line.length > 3 && sameEnd(line[0], line[line.length - 1]) ? rings : open).push(line);

  const used = new Array<boolean>(open.length).fill(false);
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const chain = [...open[i]];
    for (let joined = true; joined && !sameEnd(chain[0], chain[chain.length - 1]); ) {
      joined = false;
      for (let j = 0; j < open.length; j++) {
        if (used[j]) continue;
        const next = open[j];
        const head = chain[chain.length - 1];
        if (sameEnd(head, next[0])) chain.push(...next.slice(1));
        else if (sameEnd(head, next[next.length - 1])) chain.push(...next.slice(0, -1).reverse());
        else continue;
        used[j] = true;
        joined = true;
        break;
      }
    }
    if (chain.length > 3 && sameEnd(chain[0], chain[chain.length - 1])) rings.push(chain);
  }
  return rings;
}

/**
 * Every ring of every element whose tags match: closed ways, and relation members chained
 * into rings. Holes need no special handling — an inner ring is just another ring, and the
 * even-odd fill leaves it empty.
 */
export function matchingRings(
  source: CellSource,
  matches: (tags: OsmTags) => boolean,
): Point[][] {
  const rings: Point[][] = [];
  for (const way of source.ways) {
    if (!matches(way.tags)) continue;
    const ring = geometry(way, source.positions);
    if (ring && ring.length > 3 && sameEnd(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  for (const relation of source.relations) {
    if (!matches(relation.tags)) continue;
    const fragments: Point[][] = [];
    for (const member of relation.members) {
      if (member.type !== "way") continue;
      const way = source.wayById.get(member.ref);
      if (!way) continue;
      const coords = geometry(way, source.positions);
      if (coords && coords.length > 1) fragments.push(coords);
    }
    rings.push(...chainRings(fragments));
  }
  return rings;
}

export function forestSurface(source: CellSource, bbox: BBox, metresPerPixel?: number): Surface {
  const surface = new Surface(bbox, metresPerPixel);
  surface.fill(matchingRings(source, isForest));
  return surface;
}

export function urbanSurface(source: CellSource, bbox: BBox, metresPerPixel?: number): Surface {
  const surface = new Surface(bbox, metresPerPixel);
  surface.fill(matchingRings(source, isUrban));
  surface.dilate(URBAN_SPREAD_M);
  for (const node of source.nodes) {
    const radius = PLACE_RADIUS[node.tags.place ?? ""];
    if (radius) surface.stamp([node.lon, node.lat], radius);
  }
  return surface;
}

/**
 * How far a cluster's pull reaches. A way passing within this of one is drawn to it.
 *
 * The vector builder searched for the strongest cluster within 60 m of any point on the
 * way; stamping the same radius and taking the strongest pixel the way crosses says the
 * same thing, and costs one pass instead of a search per way.
 */
const ATTRACTION_RADIUS_M = 60;

export function attractionSurface(
  clusters: readonly Cluster[],
  bbox: BBox,
  metresPerPixel?: number,
): Surface {
  const surface = new Surface(bbox, metresPerPixel);
  // Strongest wins where clusters overlap, rather than whichever was painted last.
  for (const [lon, lat, strength] of clusters)
    surface.stamp([lon, lat], ATTRACTION_RADIUS_M, strength, "max");
  return surface;
}

/**
 * How much of a way runs through town.
 *
 * A residential or living street is town by definition, whatever the land use around it
 * says — the tag is the stronger evidence.
 */
export function urbanFraction(
  coords: readonly Point[],
  tags: OsmTags,
  urban: Surface,
): number {
  if (tags.highway === "residential" || tags.highway === "living_street") return 1.0;
  return urban.sampleLine(coords);
}
