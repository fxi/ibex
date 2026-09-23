import { distance } from "../geo/distance";
import { project } from "../geo/project";
import type { Point } from "../routing/types";
import type { RouteIndex } from "./routeIndex";

/** A stretch of the route, `[fromM, toM]`. */
export type Span = [number, number];

/** One query's worth of route: short enough that a busy server still answers it. */
export type Chunk = { fromM: number; toM: number; line: Point[] };

/**
 * The stretches of the route that pass within `radiusM` of `center`, widened by `padM` so a
 * place just past the edge of the circle, still beside the route, is not cut off.
 */
export function circleSpans(
  index: RouteIndex,
  center: Point,
  radiusM: number,
  padM = 0,
): Span[] {
  const g = index.geometry;
  const spans: Span[] = [];
  for (let i = 0; i + 1 < g.length; i++) {
    if (project(center, g[i], g[i + 1]).distance > radiusM) continue;
    const from = Math.max(0, index.meters[i] - padM),
      to = Math.min(index.lengthM, index.meters[i + 1] + padM);
    const last = spans.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else spans.push([from, to]);
  }
  return spans;
}

/** Douglas–Peucker in metres: the fewest points that stay within `toleranceM` of `line`. */
export function simplify(line: Point[], toleranceM: number): Point[] {
  if (line.length < 3) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1,
      worstD = toleranceM;
    for (let i = a + 1; i < b; i++) {
      const d =
        distance(line[a], line[b]) > 0
          ? project(line[i], line[a], line[b]).distance
          : distance(line[i], line[a]);
      if (d > worstD) {
        worst = i;
        worstD = d;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([a, worst], [worst, b]);
  }
  return line.filter((_, i) => keep[i]);
}

/** The spans cut into pieces of at most `chunkM`, each as a simplified line. */
export function routeChunks(
  index: RouteIndex,
  spans: Span[],
  chunkM: number,
  toleranceM: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  for (const [from, to] of spans) {
    const count = Math.max(1, Math.ceil((to - from) / chunkM));
    const step = (to - from) / count;
    for (let i = 0; i < count; i++) {
      const fromM = from + i * step,
        toM = i === count - 1 ? to : from + (i + 1) * step;
      chunks.push({
        fromM,
        toM,
        line: simplify(index.slice(fromM, toM), toleranceM),
      });
    }
  }
  return chunks;
}

/** Whether a distance along the route falls inside any of the spans. */
export const inSpans = (spans: Span[], m: number) =>
  spans.some(([from, to]) => m >= from && m <= to);
