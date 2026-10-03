/**
 * Ground a bicycle may not cross because the army holds it.
 *
 * OSM tags the area, not every way inside it: a firing range such as Canjuers, above the
 * Verdon, is a `military=danger_area` polygon whose tracks carry no access tag at all, so
 * a router that reads way tags alone plans through it (field report, 2026-10). Here a minor
 * way that runs mostly inside such an area is dropped unless it says itself that bicycles
 * may use it. Public roads that cross a range, unclassified and up, stay: they are open
 * outside firing days and they are how anyone gets past at all.
 *
 * Vector, like `proximity.ts`: the areas in a cell are few, so testing sample points
 * against their rings is cheaper than another cell-sized raster.
 */
import { matchingRings } from "./layers";
import { isMilitary } from "./osm/filter";
import type { CellSource } from "./osm/source";
import type { OsmTags } from "./osm/pbf";
import type { Point } from "../routing/types";

/** Ways a range keeps for itself; anything classified as a road is left to its own tags. */
const MINOR = new Set([
  "track",
  "path",
  "footway",
  "bridleway",
  "cycleway",
  "service",
  "steps",
  "pedestrian",
]);
const OPEN = new Set(["yes", "permissive", "designated"]);
const STEP_M = 25;
const M_PER_DEG = 111_319.49;

/** Whether a way says itself that a bicycle may use it, whatever the ground around it. */
const openToBicycles = (tags: OsmTags) =>
  OPEN.has(tags.bicycle ?? "") || OPEN.has(tags.access ?? "");

type Ring = { points: Point[]; box: [number, number, number, number] };

function inRing(p: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/**
 * A predicate for the cell: whether a segment of a way with these tags is closed by a
 * military area. Even-odd over every ring at once, as the surfaces fill, so an inner ring
 * (a hole) leaves its ground open.
 */
export function militaryClosure(
  source: CellSource,
): (highway: string, tags: OsmTags, coords: readonly Point[]) => boolean {
  const rings: Ring[] = matchingRings(source, isMilitary).map((points) => {
    const box: Ring["box"] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of points) {
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x);
      box[3] = Math.max(box[3], y);
    }
    return { points, box };
  });
  if (!rings.length) return () => false;

  const inside = (p: Point) => {
    let count = 0;
    for (const { points, box } of rings)
      if (
        p[0] >= box[0] &&
        p[0] <= box[2] &&
        p[1] >= box[1] &&
        p[1] <= box[3] &&
        inRing(p, points)
      )
        count++;
    return count % 2 === 1;
  };

  return (highway, tags, coords) => {
    if (!MINOR.has(highway) || openToBicycles(tags)) return false;
    let hits = 0;
    let samples = 0;
    for (let i = 0; i + 1 < coords.length; i++) {
      const [a, b] = [coords[i], coords[i + 1]];
      const k = Math.cos((a[1] * Math.PI) / 180);
      const length = Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * M_PER_DEG;
      const steps = Math.max(1, Math.round(length / STEP_M));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        samples++;
        if (inside([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]))
          hits++;
      }
    }
    // Mostly inside: a track that only clips a range's corner is not on the range.
    return samples > 0 && hits * 2 > samples;
  };
}
