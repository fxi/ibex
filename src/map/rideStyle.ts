import type { ExpressionSpecification } from "maplibre-gl";
import type { Point, RideClass, RouteSegment } from "../routing/types";

/**
 * One table drives the line colour, the legend and the dash overlays, so the map and the
 * key beside it can never drift apart. Colours stay in the app's existing palette rather
 * than a separate ramp.
 */
export const RIDE_STYLE: {
  ride: RideClass;
  color: string;
  label: string;
  /** Dash pattern of the white overlay drawn on top, if any. */
  dash?: [number, number];
}[] = [
  { ride: "paved", color: "#2485ff", label: "Paved" },
  { ride: "gravel", color: "#54d5ba", label: "Gravel", dash: [8, 4] },
  { ride: "rough", color: "#ffb34d", label: "Rough", dash: [2, 2] },
  { ride: "walk", color: "#ed42ed", label: "Hike-a-bike", dash: [1, 2] },
  { ride: "ferry", color: "#b29aff", label: "Ferry", dash: [4, 4] },
];

const FALLBACK = "#8fa3b8";

/** `["case", cond, colour, …, fallback]`, generated so a new class cannot be missed. */
export function rideColorExpression(): ExpressionSpecification {
  const cases: unknown[] = ["case"];
  for (const { ride, color } of RIDE_STYLE) {
    cases.push(["==", ["get", "ride"], ride], color);
  }
  cases.push(FALLBACK);
  return cases as unknown as ExpressionSpecification;
}

/**
 * One zoom interpolation whose stops branch on the active track, rather than two
 * interpolations inside a case: maplibre permits only a single zoom-based subexpression
 * per expression and rejects the whole layer otherwise.
 */
export const rideWidthExpression = (): ExpressionSpecification =>
  [
    "interpolate",
    ["linear"],
    ["zoom"],
    5,
    ["case", ["get", "active"], 4, 3],
    14,
    ["case", ["get", "active"], 9, 6],
  ] as unknown as ExpressionSpecification;

export type RideMeta = {
  trackId: string;
  trackColor: string;
  active: boolean;
  stale: boolean;
};
export type RideFeature = {
  type: "Feature";
  properties: RideMeta & { ride: RideClass; color: string; lengthM: number };
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
  const colorOf = (ride: RideClass) =>
    RIDE_STYLE.find((s) => s.ride === ride)?.color ?? FALLBACK;

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
      properties: {
        ride: segment.ride,
        color: colorOf(segment.ride),
        lengthM: segment.lengthM,
        ...meta,
      },
      geometry: { type: "LineString", coordinates: [...part] },
    };
    features.push(current);
  }
  // A result computed before segments existed still has to draw; treat it as one
  // unclassified line rather than dropping the track off the map.
  if (!features.length && geometry.length >= 2)
    features.push({
      type: "Feature",
      properties: {
        ride: "paved",
        color: colorOf("paved"),
        lengthM: 0,
        ...meta,
      },
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
