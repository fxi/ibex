/**
 * How much of a way runs beside a motorway, a trunk or a four-lane road.
 *
 * A frontage lane along a dual carriageway is quiet by its own class and anything but by
 * experience: the noise, the fumes, the lorries a few metres off. BRouter grades that as
 * `estimated_noise_class`, the share of a way inside a 32 m buffer either side of the
 * busiest roads. This started as the same measure, the share within `NEAR_M`; it now
 * fades out to `FAR_M` instead of stopping dead, because a service road 80 m off a
 * motorway is still breathing it. Near-road pollution falls to background somewhere
 * between 150 and 570 m (Karner, Eisinger & Niemeier 2010, a review of 41 studies), and
 * 670 km of riding beside the A8 and the Grenoble ring said the 40 m cut was too short
 * (2026-10). The result pulls traffic stress up.
 *
 * Vector, not raster: the busy roads in a cell are few, so bucketing their segments and
 * sampling each edge every `STEP_M` is cheap, where one more cell-sized surface would be
 * another 160 MB.
 */
import type { CellSource } from "./osm/source";
import { geometry } from "./osm/source";
import type { OsmTags } from "./osm/pbf";
import type { Point } from "../routing/types";

/** Within this of the busy road's centre line counts as wholly beside it: half a carriageway and BRouter's 32 m. */
export const NEAR_M = 40;
/** Past this nothing counts. Between the two, exposure fades by `FADE_M` per e-fold. */
export const FAR_M = 250;
const FADE_M = 90;
const STEP_M = 15;
const BUCKET_DEG = 0.002;
const M_PER_DEG = 111_319.49;

const MOTORWAYS = new Set(["motorway", "motorway_link", "trunk", "trunk_link"]);

/** Motorways and trunks, and any main road with two or more lanes each way. */
export function isMajorRoad(tags: OsmTags): boolean {
  const highway = tags.highway ?? "";
  if (MOTORWAYS.has(highway)) return true;
  if (highway !== "primary" && highway !== "secondary") return false;
  const lanes = Number(tags.lanes);
  const oneway = tags.oneway === "yes" || tags.oneway === "-1";
  return Number.isFinite(lanes) && (oneway ? lanes >= 2 : lanes >= 4);
}

type Segment = [number, number, number, number];

/**
 * A function giving, for a line, its mean exposure to the major roads in the source: the
 * share of it within `NEAR_M` of one, plus what fades in up to `FAR_M` — every one, including those bikes may not use, since those are the loud ones.
 * The major roads themselves are the caller's to skip.
 */
export function majorRoadProximity(source: CellSource): (coords: readonly Point[]) => number {
  const buckets = new Map<string, Segment[]>();
  const key = (x: number, y: number) => `${Math.floor(x / BUCKET_DEG)},${Math.floor(y / BUCKET_DEG)}`;
  for (const way of source.ways) {
    if (!isMajorRoad(way.tags)) continue;
    const coords = geometry(way, source.positions);
    if (!coords) continue;
    for (let i = 0; i + 1 < coords.length; i++) {
      const [a, b] = [coords[i], coords[i + 1]];
      const segment: Segment = [a[0], a[1], b[0], b[1]];
      const pad = (FAR_M / M_PER_DEG) * 2;
      for (let x = Math.min(a[0], b[0]) - pad; x <= Math.max(a[0], b[0]) + pad + BUCKET_DEG; x += BUCKET_DEG)
        for (let y = Math.min(a[1], b[1]) - pad; y <= Math.max(a[1], b[1]) + pad + BUCKET_DEG; y += BUCKET_DEG) {
          const k = key(x, y);
          const list = buckets.get(k);
          if (list) list.push(segment);
          else buckets.set(k, [segment]);
        }
    }
  }
  if (!buckets.size) return () => 0;

  /** How exposed a point is: 1 beside a major road, fading to 0 at `FAR_M`. */
  const exposure = (p: Point) => {
    const segments = buckets.get(key(p[0], p[1]));
    if (!segments) return 0;
    const k = Math.cos((p[1] * Math.PI) / 180);
    let nearest = Infinity;
    for (const [ax, ay, bx, by] of segments) {
      const [dx, dy] = [(bx - ax) * k, by - ay];
      const [px, py] = [(p[0] - ax) * k, p[1] - ay];
      const length2 = dx * dx + dy * dy;
      const t = length2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / length2)) : 0;
      const [ex, ey] = [px - t * dx, py - t * dy];
      nearest = Math.min(nearest, Math.sqrt(ex * ex + ey * ey) * M_PER_DEG);
      if (nearest <= NEAR_M) return 1;
    }
    return nearest >= FAR_M ? 0 : Math.exp(-(nearest - NEAR_M) / FADE_M);
  };

  return (coords) => {
    let exposed = 0;
    let samples = 0;
    for (let i = 0; i + 1 < coords.length; i++) {
      const [a, b] = [coords[i], coords[i + 1]];
      const k = Math.cos((a[1] * Math.PI) / 180);
      const length = Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * M_PER_DEG;
      const steps = Math.max(1, Math.round(length / STEP_M));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        samples++;
        exposed += exposure([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    return samples ? exposed / samples : 0;
  };
}
