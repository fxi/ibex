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
 * Yellow through red: the half of the palette reserved for how hard or how busy a stretch
 * is.
 *
 * The track colours in `src/tracks.ts` are deliberately all cool, so a warm tint anywhere
 * on screen means difficulty and never identity. Hike-a-bike's existing orange is the
 * third stop rather than a fifth warm hex, which makes the profile's cross-hatch and a
 * fully-charged difficulty band the same colour by construction instead of by luck.
 */
export const WARM_RAMP = ["#e8c35a", "#f0a43c", "#ff7043", "#e0463a"] as const;

/**
 * What the route is read for: what it is made of, how steep it is, or how busy. The map's
 * centre line, the chart's fill, the composition bar and the warnings all follow one lens.
 */
export type Lens = "surface" | "steep" | "traffic";
export const LENSES: { lens: Lens; label: string }[] = [
  { lens: "surface", label: "Surface" },
  { lens: "steep", label: "Steepness" },
  { lens: "traffic", label: "Traffic" },
];

/**
 * How much a stretch asks of the rider under the steepness or traffic lens: 0 is nothing
 * worth drawing, 3 as bad as the scale goes. Three steps rather than a continuous ramp, so
 * a colour on the map can be matched to a line of the legend.
 */
export type Level = 0 | 1 | 2 | 3;
/** Yellow, orange, red: the ramp's ends and hike-a-bike's orange between them. */
export const LEVEL_COLORS: Record<Exclude<Level, 0>, string> = {
  1: WARM_RAMP[0],
  2: WARM_RAMP[2],
  3: WARM_RAMP[3],
};

const channel = (hex: string, at: number) =>
  parseInt(hex.slice(at, at + 2), 16);

/** Linear in sRGB. The stops are close enough together that a fancier space buys nothing. */
const mix = (from: string, to: string, t: number) =>
  `#${[1, 3, 5]
    .map((i) =>
      Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/**
 * A point on `WARM_RAMP`, from 0 (only just worth mentioning) to 1 (as bad as the scale
 * goes). Clamped, so a signal that runs past its own ceiling simply saturates.
 */
export function warmColor(t: number): string {
  const scaled = Math.max(0, Math.min(1, t)) * (WARM_RAMP.length - 1);
  const low = Math.floor(scaled);
  if (low >= WARM_RAMP.length - 1) return WARM_RAMP[WARM_RAMP.length - 1];
  return mix(WARM_RAMP[low], WARM_RAMP[low + 1], scaled - low);
}

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
  const bands: { ride: RideClass; startM: number; endM: number }[] = [];
  for (const { segment, startM, endM } of segmentSpans(segments, distanceM)) {
    const last = bands[bands.length - 1];
    if (last && last.ride === segment.ride) last.endM = endM;
    else bands.push({ ride: segment.ride, startM, endM });
  }
  return bands;
}

export type Span = { startM: number; endM: number };
export type SegmentSpan = Span & { segment: RouteSegment; index: number };

/**
 * Every segment's own stretch of the route, in metres — the one place vertex indices become
 * distances.
 *
 * `RouteSegment` addresses `geometry` by vertex while `elevationProfile` is measured in
 * metres, and the two disagree: segment lengths are summed from straight-line spans
 * between vertices, which drifts from the router's own distance. Rescaling by
 * `distanceM / Σ lengthM` lands the last segment exactly on `distanceM`, so anything drawn
 * from segments lines up with the profile drawn from the other. Keeping that in one
 * function means a band, a warning and a pin cannot each round it differently.
 */
export function segmentSpans(
  segments: RouteSegment[],
  distanceM: number,
): SegmentSpan[] {
  const total = segments.reduce((sum, s) => sum + s.lengthM, 0);
  if (!total || !distanceM) return [];
  const scale = distanceM / total;
  const spans: SegmentSpan[] = [];
  let cursor = 0;
  for (const [index, segment] of segments.entries()) {
    const endM = cursor + segment.lengthM * scale;
    spans.push({ segment, index, startM: cursor, endM });
    cursor = endM;
  }
  return spans;
}
