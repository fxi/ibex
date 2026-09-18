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
import { total } from "./cost";
import { toCompiled } from "./compile";
import type { Components, Edge, Graph, Point, RouteRequest } from "./types";

export type Heuristic = {
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
  graph: Graph,
  snap: { nodes: number[]; points: Point[] },
  request: RouteRequest,
  reverse: Map<number, Edge[]>,
  cost_: (edge: Edge) => Components,
): Heuristic {
  // A fixed projection gives a true Euclidean metric. Bound every graph edge against
  // its endpoint chord, including rounded lengths, then apply the minimum cost rate.
  // Unlike the corridor this cannot exclude a better route outside a guessed area.
  const longitudeScale = Math.cos((snap.points[0][1] * Math.PI) / 180);
  const positions = new Map(graph.nodes.map((node) => [node.id, node.p]));
  const chord = (a: Point, b: Point) =>
    ((6371000 * Math.PI) / 180) *
    Math.hypot((a[0] - b[0]) * longitudeScale, a[1] - b[1]);
  let lengthScale = 1;
  if (request.search !== "dijkstra")
    for (const edge of graph.edges) {
      const from = positions.get(edge.from),
        to = positions.get(edge.to);
      if (!from || !to) {
        // A node without a position leaves nothing to measure against, so no geometric
        // bound is admissible for this graph at all.
        lengthScale = 0;
        break;
      }
      const d = chord(from, to);
      const gradedLength =
        edge.grades?.reduce((sum, [length]) => sum + length, 0) ?? edge.length;
      if (d > 0)
        lengthScale = Math.min(
          lengthScale,
          Math.min(edge.length, gradedLength) / d,
        );
    }
  const floor =
    Math.min(1, toCompiled(request.profile).detour.rate_floor) *
    (request.attraction ? 0.35 : 1) *
    lengthScale *
    0.999999;
  const remaining = new Float64Array(snap.nodes.length);
  for (let i = snap.nodes.length - 2; i >= 0; i--)
    remaining[i] =
      remaining[i + 1] + chord(snap.points[i], snap.points[i + 1]) * floor;
  const estimates = snap.nodes.map(() => new Map<number, number>());
  // A relaxed node graph ignores turn restrictions and transition charges, so its
  // distances are valid lower bounds for the richer search. Stop at the source; nodes
  // not settled yet are at least as far away as the frontier. This is especially
  // effective where a cheap geometric estimate cannot see a mountain or river barrier.
  const potential = new Map<number, number>();
  let frontier = 0;
  let preparedStates: number | undefined;
  if (
    request.search !== "dijkstra" &&
    snap.nodes.length === 2 &&
    graph.edges.length > 10000
  ) {
    const pending = new Map<number, number>([[snap.nodes[1], 0]]);
    const heap = new Heap<number>();
    heap.push(0, snap.nodes[1]);
    const limit = Math.min(
      100000,
      Math.floor((request.maxSettled ?? 1500000) / 4),
    );
    while (heap.size && potential.size < limit) {
      const item = heap.pop()!;
      if (item.key !== pending.get(item.value) || potential.has(item.value))
        continue;
      potential.set(item.value, item.key);
      frontier = item.key;
      if (item.value === snap.nodes[0]) break;
      for (const edge of reverse.get(item.value) ?? []) {
        const next = item.key + total(cost_(edge));
        if (next < (pending.get(edge.from) ?? Infinity)) {
          pending.set(edge.from, next);
          heap.push(next, edge.from);
        }
      }
    }
    preparedStates = potential.size;
  }
  const estimate = (node: number, leg: number) => {
    if (request.search === "dijkstra" || leg >= snap.nodes.length) return 0;
    const cache = estimates[leg];
    const hit = cache.get(node);
    if (hit !== undefined) return hit;
    const point = positions.get(node);
    const geometric = point
      ? chord(point, snap.points[leg]) * floor + remaining[leg]
      : 0;
    const h = Math.max(geometric, potential.get(node) ?? frontier);
    cache.set(node, h);
    return h;
  };
  return { estimate, scale: lengthScale, preparedStates };
}
