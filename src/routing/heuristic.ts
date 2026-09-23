/**
 * The A* lower bound: how little it could possibly cost to get from a node to the end.
 *
 * Two sources, whichever is higher. A Euclidean chord to the next waypoint times the
 * cheapest rate any edge in this graph is priced at, which is admissible by construction;
 * and, for a single-leg search over a large graph, a bounded backward Dijkstra from the
 * destination, which sees barriers a straight line cannot — a valley wall, a river with one
 * bridge.
 *
 * Every bound here must stay *under* the true cost. That is why `scale` is not clamped when
 * it collapses (see below): raising a lower bound above the truth would make the search
 * return cheaper-looking routes than the best one, which is worse than being slow.
 */
import { Heap } from "./heap";
import { toCompiled } from "./compile";
import type { GraphIndex } from "./adjacency";
import type { Point, RouteRequest } from "./types";

export type Heuristic = {
  /** Lower bound from node `node` (a `GraphIndex` index) to the end, in leg `leg`. */
  estimate: (node: number, leg: number) => number;
  /**
   * The rate the bound was scaled by, in [0, 1]. 1 means every edge is priced at least as
   * dearly as its straight-line length; near 0 means some edge is not, and the bound is
   * weak enough that the search degrades towards Dijkstra. It is reported rather than
   * clamped so a 10x slowdown from one odd edge shows up in the metrics instead of just
   * being slow, which is how it went unnoticed.
   */
  scale: number;
  preparedStates?: number;
};

export function buildHeuristic(
  index: GraphIndex,
  /** Snapped anchors, as `index` indices. */
  snap: { nodes: number[]; points: Point[] },
  request: RouteRequest,
  /** Total cost of search edge `e`. */
  costOf: (e: number) => number,
  /** Per search edge, the shorter of its length and its graded length. */
  span: Float64Array,
): Heuristic {
  // A fixed projection gives a true Euclidean metric. Bound every graph edge against
  // its endpoint chord, including rounded lengths, then apply the minimum cost rate.
  // Unlike the corridor this cannot exclude a better route outside a guessed area.
  const longitudeScale = Math.cos((snap.points[0][1] * Math.PI) / 180);
  const { lon, lat } = index;
  const n = lon.length,
    edgeCount = index.from.length;
  const chord = (ax: number, ay: number, bx: number, by: number) =>
    ((6371000 * Math.PI) / 180) * Math.hypot((ax - bx) * longitudeScale, ay - by);
  let lengthScale = 1;
  if (request.search !== "dijkstra")
    for (let e = 0; e < edgeCount; e++) {
      const a = index.from[e],
        b = index.to[e];
      if (Number.isNaN(lon[a]) || Number.isNaN(lon[b])) {
        // A node without a position leaves nothing to measure against, so no geometric
        // bound is admissible for this graph at all.
        lengthScale = 0;
        break;
      }
      const d = chord(lon[a], lat[a], lon[b], lat[b]);
      if (d > 0) lengthScale = Math.min(lengthScale, span[e] / d);
    }
  const floor =
    Math.min(1, toCompiled(request.profile).detour.rate_floor) *
    (request.attraction ? 0.35 : 1) *
    lengthScale *
    0.999999;
  const remaining = new Float64Array(snap.nodes.length);
  for (let i = snap.nodes.length - 2; i >= 0; i--)
    remaining[i] =
      remaining[i + 1] +
      chord(
        snap.points[i][0],
        snap.points[i][1],
        snap.points[i + 1][0],
        snap.points[i + 1][1],
      ) *
        floor;
  // One cache per leg, NaN until a node is first asked for.
  const estimates: (Float64Array | undefined)[] = [];
  // A relaxed node graph ignores turn restrictions and transition charges, so its
  // distances are valid lower bounds for the richer search. Stop at the source; nodes
  // not settled yet are at least as far away as the frontier. This is especially
  // effective where a cheap geometric estimate cannot see a mountain or river barrier.
  let potential: Float64Array | undefined;
  let frontier = 0;
  let preparedStates: number | undefined;
  if (
    request.search !== "dijkstra" &&
    snap.nodes.length === 2 &&
    edgeCount > 10000
  ) {
    potential = new Float64Array(n).fill(NaN);
    const pending = new Float64Array(n).fill(Infinity);
    pending[snap.nodes[1]] = 0;
    const heap = new Heap<number>();
    heap.push(0, snap.nodes[1]);
    const limit = Math.min(
      100000,
      Math.floor((request.maxSettled ?? 1500000) / 4),
    );
    let settled = 0;
    while (heap.size && settled < limit) {
      const item = heap.pop()!;
      if (item.key !== pending[item.value] || !Number.isNaN(potential[item.value]))
        continue;
      potential[item.value] = item.key;
      settled++;
      frontier = item.key;
      if (item.value === snap.nodes[0]) break;
      for (let k = index.inStart[item.value]; k < index.inStart[item.value + 1]; k++) {
        const e = index.inEdges[k],
          origin = index.from[e];
        const next = item.key + costOf(e);
        if (next < pending[origin]) {
          pending[origin] = next;
          heap.push(next, origin);
        }
      }
    }
    preparedStates = settled;
  }
  const estimate = (node: number, leg: number) => {
    if (request.search === "dijkstra" || leg >= snap.nodes.length) return 0;
    const cache = (estimates[leg] ??= new Float64Array(n).fill(NaN));
    const hit = cache[node];
    if (!Number.isNaN(hit)) return hit;
    const geometric = Number.isNaN(lon[node])
      ? 0
      : chord(lon[node], lat[node], snap.points[leg][0], snap.points[leg][1]) *
          floor +
        remaining[leg];
    const known = potential?.[node];
    const h = Math.max(
      geometric,
      known === undefined || Number.isNaN(known) ? frontier : known,
    );
    cache[node] = h;
    return h;
  };
  return { estimate, scale: lengthScale, preparedStates };
}
