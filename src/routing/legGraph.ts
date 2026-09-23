/**
 * A leg's graph without an object per edge.
 *
 * The search used to receive every edge of a leg decoded, about 1.5 KB each, and a 100 km
 * leg holds well over a million: past 2 GB before the search began, which a desktop
 * shrugs off and an iPhone answers by killing the tab. A `LegGraph` holds what the search
 * walks — node positions and each edge's ends — in typed arrays, and hands out an edge
 * only when asked, rebuilt from the packed block (`blockEdge`). Nothing keeps it.
 *
 * A plain `Graph`, as tests and scripts build them, is adapted with `fromGraph`, whose
 * `edge` returns the original objects, so both kinds route through one search.
 */
import type { Edge, Graph, Node, Restriction } from "./types";

export type LegGraph = {
  schemaVersion: 1;
  bbox: Graph["bbox"];
  restrictions: Restriction[];
  /**
   * Nodes by index. A node with NaN position is only referenced by an edge, not
   * described by the graph, as `Graph` allows.
   */
  nodeId: Float64Array;
  lon: Float64Array;
  lat: Float64Array;
  /** NaN where unknown. */
  elevation: Float64Array;
  /** Each edge's ends, as node indices. */
  from: Int32Array;
  to: Int32Array;
  /** Each edge's block, indexing `tiles`. */
  tile: Int32Array;
  tiles: string[];
  way(edge: number): string;
  edge(edge: number): Edge;
};

export const isLegGraph = (graph: Graph | LegGraph): graph is LegGraph =>
  typeof (graph as LegGraph).edge === "function";

export function fromGraph(graph: Graph): LegGraph {
  const of = new Map<number, number>(),
    ids: number[] = [],
    lon: number[] = [],
    lat: number[] = [],
    elevation: number[] = [];
  const add = (id: number) => {
    let i = of.get(id);
    if (i === undefined) {
      i = ids.length;
      of.set(id, i);
      ids.push(id);
      lon.push(NaN);
      lat.push(NaN);
      elevation.push(NaN);
    }
    return i;
  };
  // A repeated id keeps its last description, as the Maps this replaces did.
  for (const node of graph.nodes) {
    const i = add(node.id);
    lon[i] = node.p[0];
    lat[i] = node.p[1];
    elevation[i] = node.elevation ?? NaN;
  }
  const { edges } = graph;
  const from = new Int32Array(edges.length),
    to = new Int32Array(edges.length),
    tile = new Int32Array(edges.length);
  const tiles: string[] = [],
    tileIds = new Map<string, number>();
  for (let e = 0; e < edges.length; e++) {
    from[e] = add(edges[e].from);
    to[e] = add(edges[e].to);
    let t = tileIds.get(edges[e].tile);
    if (t === undefined) {
      t = tiles.length;
      tiles.push(edges[e].tile);
      tileIds.set(edges[e].tile, t);
    }
    tile[e] = t;
  }
  return {
    schemaVersion: 1,
    bbox: graph.bbox,
    restrictions: graph.restrictions,
    nodeId: Float64Array.from(ids),
    lon: Float64Array.from(lon),
    lat: Float64Array.from(lat),
    elevation: Float64Array.from(elevation),
    from,
    to,
    tile,
    tiles,
    way: (e) => edges[e].way,
    edge: (e) => edges[e],
  };
}

/** The nodes the graph describes, as objects. */
export function nodesOf(leg: LegGraph): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < leg.nodeId.length; i++)
    if (!Number.isNaN(leg.lon[i]))
      nodes.push({
        id: leg.nodeId[i],
        p: [leg.lon[i], leg.lat[i]],
        elevation: Number.isNaN(leg.elevation[i]) ? null : leg.elevation[i],
      });
  return nodes;
}

/** Every node and edge as objects, for the audits that still want a whole `Graph`. */
export function toGraph(leg: LegGraph): Graph {
  const nodes = nodesOf(leg);
  const edges: Edge[] = [];
  for (let e = 0; e < leg.from.length; e++) edges.push(leg.edge(e));
  return {
    schemaVersion: 1,
    bbox: leg.bbox,
    nodes,
    edges,
    restrictions: leg.restrictions,
  };
}
