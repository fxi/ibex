/**
 * Which OpenStreetMap downloads a cell has to be built from.
 *
 * Geofabrik publishes `index-v1.json`, a GeoJSON of every extract it offers with the
 * polygon it covers. That is enough to answer the only two questions the builder asks: is
 * there any OSM data under this cell at all, and which files hold it.
 *
 * A cell is not always one country. The border ones are the reason the Geneva cell was
 * built half-empty once: its western half is France and its eastern half Switzerland, and
 * an extract set chosen by a single point silently drops the other side. So coverage is
 * decided by sampling the cell's whole box and taking the union of what answers — a cell on
 * a border reads both files, a cell at sea reads none and is never built.
 */
import type { BBox } from "../../geo/grid";

export type Extract = {
  id: string;
  name: string;
  parent?: string;
  /** The `.osm.pbf` download. */
  url: string;
  bbox: BBox;
  /** Bounding-box area in square degrees; the tie-break for "smallest extract that fits". */
  area: number;
  /**
   * Whether this is a download the builder should ever choose.
   *
   * Two kinds are excluded. A parent (`france`, `europe`) is tiled by its children, and
   * reading 28 GB of continent to build one cell is not a plan. A cross-border convenience
   * extract (`alps`, `dach`, `britain-and-ireland`) overlaps the countries under it and
   * would be read twice over; Geofabrik marks those by sitting directly under a continent
   * with no ISO country code, which is exactly what a real country has.
   */
  usable: boolean;
  /** Whether Geofabrik gave it an ISO country code, which marks a real country. */
  iso: boolean;
  rings: Ring[];
};

type Ring = { points: number[]; west: number; south: number; east: number; north: number };

type Feature = {
  properties?: {
    id?: unknown;
    name?: unknown;
    parent?: unknown;
    "iso3166-1:alpha2"?: unknown;
    urls?: { pbf?: unknown };
  };
  geometry?: { type?: unknown; coordinates?: unknown };
};

function iso(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  return Array.isArray(value) && value.length > 0;
}

/** Rings are flattened to `[lon, lat, lon, lat, …]`: the index holds about 1.5 M vertices. */
function ringOf(points: unknown): Ring | undefined {
  if (!Array.isArray(points) || points.length < 4) return undefined;
  const flat: number[] = [];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of points) {
    if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number") continue;
    flat.push(p[0], p[1]);
    if (p[0] < west) west = p[0];
    if (p[0] > east) east = p[0];
    if (p[1] < south) south = p[1];
    if (p[1] > north) north = p[1];
  }
  return flat.length < 8 ? undefined : { points: flat, west, south, east, north };
}

/** Parse the published index. Anything without a pbf url or a polygon is not a download. */
export function readExtractIndex(document: unknown): Extract[] {
  const features = (document as { features?: unknown })?.features;
  if (!Array.isArray(features)) throw new Error("Extract index has no features");
  const extracts: Extract[] = [];
  for (const feature of features as Feature[]) {
    const id = feature.properties?.id;
    const url = feature.properties?.urls?.pbf;
    const type = feature.geometry?.type;
    if (typeof id !== "string" || typeof url !== "string") continue;
    if (type !== "Polygon" && type !== "MultiPolygon") continue;
    const polygons = (
      type === "Polygon"
        ? [feature.geometry?.coordinates]
        : (feature.geometry?.coordinates as unknown[])
    ) as unknown[];
    const rings: Ring[] = [];
    for (const polygon of polygons)
      if (Array.isArray(polygon))
        for (const ring of polygon) {
          const built = ringOf(ring);
          if (built) rings.push(built);
        }
    if (!rings.length) continue;
    const bbox: BBox = [
      Math.min(...rings.map((r) => r.west)),
      Math.min(...rings.map((r) => r.south)),
      Math.max(...rings.map((r) => r.east)),
      Math.max(...rings.map((r) => r.north)),
    ];
    const parent = feature.properties?.parent;
    extracts.push({
      id,
      name: typeof feature.properties?.name === "string" ? feature.properties.name : id,
      parent: typeof parent === "string" ? parent : undefined,
      url,
      bbox,
      area: (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]),
      usable: true,
      // Published as an array — a country with two codes is still a country.
      iso: iso(feature.properties?.["iso3166-1:alpha2"]),
      rings,
    });
  }
  if (!extracts.length) throw new Error("Extract index held no usable extracts");

  const byId = new Map(extracts.map((e) => [e.id, e]));
  const parents = new Set(extracts.map((e) => e.parent).filter(Boolean));
  for (const extract of extracts) {
    const leaf = !parents.has(extract.id);
    const grandparent = extract.parent ? byId.get(extract.parent)?.parent : undefined;
    // Directly under a continent and not a country: `alps`, `dach`, `britain-and-ireland`.
    const special = extract.parent !== undefined && grandparent === undefined && !extract.iso;
    extract.usable = leaf && !special;
  }
  return extracts;
}

/**
 * Even-odd containment against the flattened rings.
 *
 * A multipolygon's holes and islands both fall out of the same test, which is why the
 * rings are pooled rather than kept per polygon.
 */
function contains(extract: Extract, lon: number, lat: number): boolean {
  const { bbox } = extract;
  if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) return false;
  let inside = false;
  for (const ring of extract.rings) {
    if (lon < ring.west || lon > ring.east || lat < ring.south || lat > ring.north) continue;
    const { points } = ring;
    for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      const xi = points[i];
      const yi = points[i + 1];
      const xj = points[j];
      const yj = points[j + 1];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
  }
  return inside;
}

/**
 * Whether any vertex of the extract's outline falls inside the box.
 *
 * This is what catches a border crossing the cell. Containment alone does not: Geofabrik
 * buffers each polygon past its administrative boundary, so a point in Geneva reads as
 * inside Rhône-Alpes as well as inside Switzerland, and picking only the smallest match
 * silently drops the Swiss half of the cell. That is how a Geneva cell was once published
 * with no Geneva in it.
 */
function crosses(extract: Extract, bbox: BBox): boolean {
  const [west, south, east, north] = bbox;
  if (extract.bbox[2] < west || extract.bbox[0] > east) return false;
  if (extract.bbox[3] < south || extract.bbox[1] > north) return false;
  for (const ring of extract.rings) {
    if (ring.east < west || ring.west > east || ring.north < south || ring.south > north)
      continue;
    const { points } = ring;
    for (let i = 0; i < points.length; i += 2)
      if (
        points[i] >= west &&
        points[i] <= east &&
        points[i + 1] >= south &&
        points[i + 1] <= north
      )
        return true;
  }
  return false;
}

/** The smallest usable extract holding a point, or nothing where there is no download. */
export function extractAt(
  extracts: readonly Extract[],
  lon: number,
  lat: number,
): Extract | undefined {
  let best: Extract | undefined;
  for (const extract of extracts)
    if (extract.usable && (!best || extract.area < best.area) && contains(extract, lon, lat))
      best = extract;
  return best;
}

/**
 * Every download a box needs: all of them, not the best one.
 *
 * An extract is in if it covers any sampled point or if its outline passes through the box
 * at all. Over-reading a neighbour at a border costs one more file; under-reading it loses
 * half a city.
 *
 * `samples` is per side. Eight over a z9 cell puts a probe every 7 km, and no Geofabrik
 * extract is small enough to hide between them.
 */
export function extractsFor(extracts: readonly Extract[], bbox: BBox, samples = 8): Extract[] {
  const found = new Map<string, Extract>();
  const [west, south, east, north] = bbox;
  for (const extract of extracts) {
    if (!extract.usable) continue;
    if (crosses(extract, bbox)) {
      found.set(extract.id, extract);
      continue;
    }
    for (let iy = 0; iy < samples && !found.has(extract.id); iy++) {
      const lat = south + ((north - south) * (iy + 0.5)) / samples;
      for (let ix = 0; ix < samples; ix++) {
        const lon = west + ((east - west) * (ix + 0.5)) / samples;
        if (contains(extract, lon, lat)) {
          found.set(extract.id, extract);
          break;
        }
      }
    }
  }
  // Largest first, so a caller reading them in order meets the heavy one while it is fresh.
  return [...found.values()].sort((a, b) => b.area - a.area);
}

/** A stable name for a set of extracts, so cells needing the same files group together. */
export function extractKey(extracts: readonly Extract[]): string {
  return extracts
    .map((e) => e.id)
    .sort()
    .join("+");
}
