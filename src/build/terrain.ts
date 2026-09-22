/**
 * Continuous way profiles: short topology edges must not become DEM pixel steps.
 *
 * A direct port of `scripts/terrain_profile.py`. The smoothing window and the clamp are
 * routing decisions with scars behind them — the comments say which — so they are
 * reproduced as they stand.
 *
 * Tiles arrive here already decoded to heights. Turning a Terrarium WebP into that grid is
 * the one thing that differs between Node and a browser, so it lives in `platform/`.
 */
import { distance } from "../geo/distance";
import { roundTo } from "./round";
import type { Point } from "../routing/types";

/** A decoded DEM tile: heights in metres, row-major. */
export type HeightTile = { width: number; height: number; data: Float32Array };

/** One `[start, end, grade]` run along a way, in metres from its first node. */
export type GradeSample = [number, number, number];
/** One `[metres, grade]` pair as the edge encoder stores it. */
export type Grade = [number, number];

const DEGREES_TO_RADIANS = Math.PI / 180;
/** Grades are smoothed over this window so DEM pixel noise does not become a wall. */
const WINDOW = 80;
const CLAMP = 0.45;

/** Terrarium RGB encodes height; the decoded heights are interpolated, never the colours. */
export function bilinearHeight(tile: HeightTile, px: number, py: number): number {
  const x = Math.max(0, Math.min(tile.width - 1, px - 0.5));
  const y = Math.max(0, Math.min(tile.height - 1, py - 0.5));
  const x0 = Math.trunc(x);
  const y0 = Math.trunc(y);
  const dx = x - x0;
  const dy = y - y0;
  const x1 = Math.min(x0 + 1, tile.width - 1);
  const y1 = Math.min(y0 + 1, tile.height - 1);
  const at = (a: number, b: number) => tile.data[b * tile.width + a];
  return (
    (1 - dy) * ((1 - dx) * at(x0, y0) + dx * at(x1, y0)) +
    dy * ((1 - dx) * at(x0, y1) + dx * at(x1, y1))
  );
}

/** Terrarium's encoding, for a decoder to apply per pixel. */
export const terrariumHeight = (red: number, green: number, blue: number) =>
  red * 256 + green + blue / 256 - 32768;

/**
 * A number the way Python's `float()` reads one, which refuses what `Number()` accepts.
 *
 * `Number("")` and `Number(" ")` are both 0, so an incline of `"%"` — the unit with the
 * value missing — would otherwise read as flat rather than as no information at all.
 */
function pythonFloat(text: string): number | undefined {
  if (!/\S/.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** The OSM incline tag as a grade, in the way's coordinate direction, or undefined. */
export function numericIncline(incline: string | undefined): number | undefined {
  const text = (incline ?? "").trim();
  let grade: number | undefined;
  if (text.endsWith("°")) {
    const degrees = pythonFloat(text.slice(0, -1));
    // `degrees * (pi/180)`, not `(degrees * pi) / 180`: Python's math.radians scales by the
    // single rounded constant, and the two disagree in the last bit.
    grade = degrees === undefined ? undefined : Math.tan(degrees * DEGREES_TO_RADIANS);
  } else {
    const percent = pythonFloat(text.replace(/%+$/, ""));
    grade = percent === undefined ? undefined : percent / 100;
  }
  if (grade === undefined || !Number.isFinite(grade)) return undefined;
  return Math.max(-CLAMP, Math.min(CLAMP, grade));
}

/**
 * One constant grade across a bridge or tunnel.
 *
 * A DEM sees the valley below a bridge and the mountain above a tunnel, including at
 * portals that fall inside the same coarse terrain pixel. Only an explicit numeric OSM
 * incline can describe the structure itself; without one, flat is the safe routing model.
 */
export function structureGrade(incline?: string): number {
  return numericIncline(incline) ?? 0.0;
}

/**
 * Largest index whose key is at most `value`, or -1. Python's `bisect_right(..) - 1`.
 *
 * The key is read through an accessor so a list of samples can be searched by its start
 * offset without first projecting it to an array — this runs once per edge.
 */
function lastAtMost<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (key(items[mid]) <= value) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

const identity = (value: number) => value;

export type Profile = { offsets: number[]; samples: GradeSample[] | undefined };

export function wayProfile(
  ids: readonly number[],
  positions: ReadonlyMap<number, Point>,
  elevations: ReadonlyMap<number, number>,
  incline?: string,
): Profile {
  const offsets = [0.0];
  for (let i = 0; i + 1 < ids.length; i++)
    offsets.push(offsets[offsets.length - 1] + distance(positions.get(ids[i])!, positions.get(ids[i + 1])!));
  const length = offsets[offsets.length - 1];
  if (length < 0.1) return { offsets, samples: undefined };

  // Numeric incline tags are often unsigned steepness in practice. Where the DEM can
  // describe the road, prefer its direction and shape; keep the tag only as a fallback for
  // missing terrain.
  if (ids.some((id) => !elevations.has(id))) {
    const tagged = numericIncline(incline);
    return { offsets, samples: tagged === undefined ? undefined : [[0.0, length, tagged]] };
  }

  const heightAt = (at: number): number => {
    const index = Math.min(ids.length - 2, Math.max(0, lastAtMost(offsets, at, identity)));
    const span = offsets[index + 1] - offsets[index];
    const t = span ? (at - offsets[index]) / span : 0;
    return elevations.get(ids[index])! * (1 - t) + elevations.get(ids[index + 1])! * t;
  };

  const samples: GradeSample[] = [];
  let start = 0.0;
  while (start < length) {
    const end = Math.min(length, start + 20);
    const middle = (start + end) / 2;
    // Shift the full window at way ends instead of creating a tiny tail.
    const low = Math.max(0, Math.min(length - WINDOW, middle - WINDOW / 2));
    const high = Math.min(length, low + WINDOW);
    // A way shorter than the window spreads its rise over the window, as a structure does:
    // dividing 4 m of DEM noise at a tunnel portal by a 12 m way invented a 31% wall that,
    // on a `foot=no` road, deleted the edge and closed the Col de Rousset.
    const grade = (heightAt(high) - heightAt(low)) / Math.max(high - low, WINDOW);
    samples.push([start, end, Math.max(-CLAMP, Math.min(CLAMP, grade))]);
    start = end;
  }
  return { offsets, samples };
}

/** The part of a way's profile covering one edge, as the encoder's `[metres, grade]` runs. */
export function sliceProfile(
  samples: GradeSample[] | undefined,
  start: number,
  end: number,
): Grade[] | undefined {
  if (!samples) return undefined;
  // Start near the selected edge, avoiding a scan of every sample on long ways.
  const first = Math.max(0, lastAtMost(samples, start, (sample) => sample[0]));
  const result: Grade[] = [];
  for (let i = first; i < samples.length; i++) {
    const [a, b, grade] = samples[i];
    if (a >= end) break;
    const metres = Math.min(end, b) - Math.max(start, a);
    if (metres > 0.001) result.push([roundTo(metres, 3), roundTo(grade, 5)]);
  }
  return result.length > 0 ? result : undefined;
}
