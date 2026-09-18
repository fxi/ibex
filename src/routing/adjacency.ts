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
