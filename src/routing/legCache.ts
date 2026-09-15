/**
 * Finished legs, remembered so an edit only routes the legs it touched.
 *
 * A leg is keyed by everything its result depends on — its two waypoints, the compiled
 * profile, and the installed data under its search area — so a key is valid for as long
 * as it can be computed, whichever track or revision produced it. Appending a waypoint
 * routes one leg; moving one routes the two legs that meet there; inserting one routes the
 * two halves of the leg it splits.
 *
 * The cache lives in memory. Routing code changes reload the module, which empties it, so
 * a result from an older engine is never served.
 */
import { bboxIntersects, type BBox } from "../geo/grid";
import type { Installed } from "../offline/store";
import { toCompiled } from "./compile";
import { joinComparison, type LegComparison } from "./legs";
import { searchArea } from "./provider";
import {
  COST_MODEL_VERSION,
  type Comparison,
  type Point,
  type RouteRequest,
} from "./types";

/** Bump when leg routing changes in a way the key cannot see. */
const LEG_FORMAT = 2;

/** Installed data a leg can read: the release and the version of every cell under its area. */
export function legData(
  release: string,
  packs: Installed[],
  cells: { id: string; bbox: BBox }[],
  area: BBox,
): string {
  const bboxes = new Map(cells.map((c) => [c.id, c.bbox]));
  const under = packs
    .filter((p) => {
      const bbox = bboxes.get(p.manifest.id);
      return !bbox || bboxIntersects(bbox, area);
    })
    .map((p) => `${p.manifest.id}@${String(p.manifest.version)}`)
    .sort();
  return `${release}|${under.join(",")}`;
}

export function legKey(
  request: Pick<
    RouteRequest,
    "profile" | "attraction" | "maxSettled" | "diagnostics" | "search"
  >,
  from: Point,
  to: Point,
  data: string,
): string {
  return JSON.stringify([
    LEG_FORMAT,
    COST_MODEL_VERSION,
    from,
    to,
    toCompiled(request.profile),
    request.attraction ?? null,
    request.maxSettled ?? null,
    request.diagnostics ?? false,
    request.search ?? "astar",
    data,
  ]);
}

/** Keys for every leg of a request, from the installed data each leg would read. */
export function legKeys(
  request: RouteRequest,
  release: string,
  packs: Installed[],
  cells: { id: string; bbox: BBox }[],
): string[] {
  const compiled = { ...request, profile: toCompiled(request.profile) };
  return request.anchors.slice(1).map((to, i) => {
    const from = request.anchors[i];
    return legKey(
      compiled,
      from,
      to,
      legData(release, packs, cells, searchArea([from, to])),
    );
  });
}

/** Least-recently-used, bounded by entry count. A long leg's result is a few megabytes. */
export class LegCache<T> {
  private readonly entries = new Map<string, T>();
  constructor(public limit = 24) {}

  /** Grow to hold at least `count` legs, so a long route never evicts its own. */
  reserve(count: number): void {
    this.limit = Math.max(this.limit, count);
  }

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit)
      this.entries.delete(this.entries.keys().next().value!);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** One-based legs whose keys the cache does not hold. */
export function missingLegs(
  keys: string[],
  cache: LegCache<LegComparison>,
): number[] {
  return keys.flatMap((key, i) => (cache.has(key) ? [] : [i + 1]));
}

/**
 * Join the route from cached and freshly routed legs. A failed leg ends the route there,
 * as it does when routing; a leg that is simply absent means the run did not finish, and
 * no route is made up from the rest.
 */
export function assembleLegs(
  keys: string[],
  anchors: Point[],
  cache: LegCache<LegComparison>,
  routed: Map<number, LegComparison>,
): Comparison | undefined {
  const legs: LegComparison[] = [];
  for (const [i, key] of keys.entries()) {
    const value = routed.get(i + 1) ?? cache.get(key);
    if (!value) return undefined;
    legs.push(value);
    if (value.exploration.status !== "ok") break;
  }
  return joinComparison(legs, anchors);
}
