import type { ExpressionSpecification } from "maplibre-gl";
import type { Point, RideClass, RouteSegment } from "../routing/types";

/**
 * Colour is identity, pattern is terrain.
 *
 * A track keeps its own colour everywhere it is drawn — map line, elevation curve, track
 * card — so two routes on screen are never confused. What the surface is like rides on
 * top of that colour as a white centre line, the way a road atlas marks an unsealed road:
 * the finer and more broken the line, the worse the going. Paved gets no centre line at
 * all, so a clean line means a clean road and nothing has to be looked up.
 *
 * One table drives the map layers, the elevation hatching and the Symbology tab, so the
 * three can never drift apart.
 */
export type SurfaceStyle = {
  ride: RideClass;
  label: string;
  /** What the class means, and where it comes from — shown in the Symbology tab. */
  note: string;
  /**
   * The white line drawn along the middle of the track, or null to leave it clean.
   * `weight` is a fraction of the track's own line width and `dash` is in multiples of
   * the centre line's width, the way maplibre measures dashes.
   */
  center: { weight: number; dash?: [number, number]; opacity: number } | null;
  /**
   * Fill under the elevation curve. `spacing` and `angle` describe the hatch in SVG user
   * units; `color` overrides the track's colour where a class has to shout.
   */
  profile: { opacity: number; spacing?: number; angle?: number; color?: string };
};

export const SURFACE_STYLE: SurfaceStyle[] = [
  {
    ride: "paved",
    label: "Paved",
    note: "Asphalt, concrete or paving stones — and any street whose surface OSM never recorded, since a residential road is sealed unless something says otherwise.",
    center: null,
    profile: { opacity: 0.18 },
  },
  {
    ride: "gravel",
    label: "Gravel",
    note: "Compacted, fine gravel or unpaved — plus forest and farm tracks, which are unsurfaced by definition, at tracktype grade 1–3.",
    center: { weight: 0.3, opacity: 0.95 },
    profile: { opacity: 0.4, spacing: 5, angle: 45 },
  },
  {
    ride: "rough",
    label: "Rough",
    note: "Dirt, ground, grass, sand, rock, cobbles — and tracktype grade 4–5. Rideable, but loose or broken.",
    center: { weight: 0.45, dash: [2, 2], opacity: 0.95 },
    profile: { opacity: 0.55, spacing: 3.5, angle: 45 },
  },
  {
    ride: "walk",
    label: "Hike-a-bike",
    note: "Pushed, not ridden: steps, dismount-only ways, or terrain past this profile's grade and mtb:scale limits. The rungs run across the track so a carry cannot be mistaken for a ride.",
    center: { weight: 0.7, dash: [1, 1], opacity: 1 },
    profile: { opacity: 0.9, spacing: 2.5, angle: -45, color: "#ff7043" },
  },
  {
    ride: "unknown",
    label: "Surface unknown",
    note: "A path with no surface and no tracktype. Nothing is claimed about it — the faint dots mark exactly that, so it can be treated as a question rather than a promise.",
    center: { weight: 0.28, dash: [1, 3], opacity: 0.6 },
    profile: { opacity: 0.3, spacing: 6, angle: 45 },
  },
  {
    ride: "ferry",
    label: "Ferry",
    note: "A boat, not a road. Check the timetable — the router only knows the crossing exists.",
    center: { weight: 0.5, dash: [4, 3], opacity: 1 },
    profile: { opacity: 0.6, spacing: 4, angle: 0, color: "#8ab4ff" },
  },
];

/** Looked up often enough to be worth an index. */
export const surfaceStyle = (ride: RideClass): SurfaceStyle =>
  SURFACE_STYLE.find((s) => s.ride === ride) ?? SURFACE_STYLE[0];

/** The white of the centre line and the casing, warmed slightly to sit on any colour. */
export const CENTER_COLOR = "#fffdf5";
/** Drawn only if a feature reaches the map without a track colour. */
export const FALLBACK_COLOR = "#8fa3b8";

/**
 * The track's own colour, with a fallback so a feature missing the property cannot take
 * the whole layer down.
 */
export const trackColorExpression = (): ExpressionSpecification =>
  ["to-color", ["get", "trackColor"], FALLBACK_COLOR] as ExpressionSpecification;

/**
 * One zoom interpolation whose stops branch on the active track, rather than two
 * interpolations inside a case: maplibre permits only a single zoom-based subexpression
 * per expression and rejects the whole layer otherwise.
 *
 * `scale` shrinks the stops for the centre-line layers, which have to stay a fixed
 * fraction of the track line at every zoom.
 */
export const trackWidthExpression = (scale = 1): ExpressionSpecification =>
  [
    "interpolate",
    ["linear"],
    ["zoom"],
    5,
    ["case", ["get", "active"], 4 * scale, 3 * scale],
    14,
    ["case", ["get", "active"], 9 * scale, 6 * scale],
  ] as unknown as ExpressionSpecification;

export type RideMeta = {
  trackId: string;
  trackColor: string;
  active: boolean;
  stale: boolean;
};
export type RideFeature = {
  type: "Feature";
  properties: RideMeta & { ride: RideClass; lengthM: number };
  geometry: { type: "LineString"; coordinates: Point[] };
};

/**
 * Merge consecutive segments that ride the same way into one feature.
 *
 * A route can hold hundreds of edge-level segments; drawing each as its own feature puts
 * a round cap at every join and makes the line look beaded. Merging first collapses that
 * to a handful of features and leaves clean joins.
 */
export function rideFeatures(
  segments: RouteSegment[],
  geometry: Point[],
  meta: RideMeta,
): RideFeature[] {
  const features: RideFeature[] = [];
  let current: RideFeature | undefined;

  for (const segment of segments) {
    // `end` is inclusive, so a segment's polyline runs to end + 1.
    const part = geometry.slice(segment.start, segment.end + 1);
    if (part.length < 2) continue;
    if (current && current.properties.ride === segment.ride) {
      // Consecutive segments share their boundary vertex; drop the repeat.
      current.geometry.coordinates.push(...part.slice(1));
      current.properties.lengthM += segment.lengthM;
      continue;
    }
    current = {
      type: "Feature",
      properties: { ride: segment.ride, lengthM: segment.lengthM, ...meta },
      geometry: { type: "LineString", coordinates: [...part] },
    };
    features.push(current);
  }
  // A result computed before segments existed still has to draw. It is drawn unclassified
  // rather than dropped off the map, and "unknown" is the honest class for it.
  if (!features.length && geometry.length >= 2)
    features.push({
      type: "Feature",
      properties: { ride: "unknown", lengthM: 0, ...meta },
      geometry: { type: "LineString", coordinates: [...geometry] },
    });
  return features;
}

/** Distance ridden in each class, for the legend beside a track. */
export function rideTotals(segments: RouteSegment[]): Map<RideClass, number> {
  const totals = new Map<RideClass, number>();
  for (const s of segments)
    totals.set(s.ride, (totals.get(s.ride) ?? 0) + s.lengthM);
  return totals;
}

/**
 * Where each surface class starts and ends along the route, in metres.
 *
 * Segment lengths are summed from straight-line spans between geometry vertices, which
 * drifts a little from the router's own distance; the bands are rescaled to end exactly
 * at `distanceM` so they line up with an elevation profile measured the other way.
 */
export function surfaceBands(
  segments: RouteSegment[],
  distanceM: number,
): { ride: RideClass; startM: number; endM: number }[] {
  const total = segments.reduce((sum, s) => sum + s.lengthM, 0);
  if (!total || !distanceM) return [];
  const scale = distanceM / total;
  const bands: { ride: RideClass; startM: number; endM: number }[] = [];
  let cursor = 0;
  for (const s of segments) {
    const end = cursor + s.lengthM * scale;
    const last = bands[bands.length - 1];
    if (last && last.ride === s.ride) last.endM = end;
    else bands.push({ ride: s.ride, startM: cursor, endM: end });
    cursor = end;
  }
  return bands;
}
