import type { Edge } from "./types";

/**
 * Edges indexed by the node they leave from, and by the node they arrive at.
 *
 * The forward index is what the search relaxes over; the reverse one is what the backward
 * pre-pass and the reachability check walk. Both are built in one pass because a leg graph
 * is large enough that a second iteration over every edge is worth avoiding.
 */
export function buildAdjacency(edges: Edge[]): {
  adjacency: Map<number, Edge[]>;
  reverse: Map<number, Edge[]>;
} {
  const adjacency = new Map<number, Edge[]>();
  const reverse = new Map<number, Edge[]>();
  for (const edge of edges) {
    const out = adjacency.get(edge.from);
    if (out) out.push(edge);
    else adjacency.set(edge.from, [edge]);
    const into = reverse.get(edge.to);
    if (into) into.push(edge);
    else reverse.set(edge.to, [edge]);
  }
  return { adjacency, reverse };
}

/**
 * A leg's search graph by dense node index.
 *
 * Node ids are OSM ids, well past 2^31, so every Map keyed by them boxes its keys, and
 * the search used to keep several such maps the size of the graph at once. Here nodes
 * are indices, positions are flat arrays, and adjacency is CSR over edge indices. Edges
 * keep their order in `from`/`to`, so the search relaxes them in the order
 * `buildAdjacency` gave and ties break as they always did.
 */
export type GraphIndex = {
  /** Position by node index; NaN for a node no graph node describes. */
  lon: Float64Array;
  lat: Float64Array;
  from: Int32Array;
  to: Int32Array;
  /** Edges leaving node i are `outEdges[outStart[i] .. outStart[i + 1])`; likewise into. */
  outStart: Int32Array;
  outEdges: Int32Array;
  inStart: Int32Array;
  inEdges: Int32Array;
};

export function indexEdges(
  lon: Float64Array,
  lat: Float64Array,
  from: Int32Array,
  to: Int32Array,
): GraphIndex {
  const n = lon.length;
  const csr = (ends: Int32Array) => {
    const start = new Int32Array(n + 1);
    for (let e = 0; e < ends.length; e++) start[ends[e] + 1]++;
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const fill = start.slice(0, n),
      list = new Int32Array(ends.length);
    for (let e = 0; e < ends.length; e++) list[fill[ends[e]]++] = e;
    return { start, list };
  };
  const out = csr(from),
    into = csr(to);
  return {
    lon,
    lat,
    from,
    to,
    outStart: out.start,
    outEdges: out.list,
    inStart: into.start,
    inEdges: into.list,
  };
}
