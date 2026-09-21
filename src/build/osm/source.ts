/**
 * One cell's OSM extract, in the shape the graph build needs.
 *
 * `scripts/osm_source.py` reproduces Overpass `out geom;` output: every way carries a
 * parallel array of `{lon, lat}` objects, and every relation member repeats its way's. On
 * the dense Geneva cell that is 3.5 million coordinate objects, and it is the largest part
 * of the Python builder's 3.8 GB. Here a way keeps only its node refs and geometry is
 * looked up on demand, so the positions cost three typed arrays instead.
 *
 * What is kept otherwise matches the Python reader exactly, because the graph build is
 * being ported against it: node *elements* are the tagged nodes only, as Overpass emitted,
 * while every node's location stays available for way geometry.
 */
import { readPbf, type Inflate, type OsmNode, type OsmRelation, type OsmWay } from "./pbf";

export type { OsmNode, OsmRelation, OsmWay };
export type Position = readonly [number, number];

/**
 * Every node's location, as sorted typed arrays with a binary search.
 *
 * A `Map` of three million entries costs a few hundred megabytes in object headers alone;
 * three `Float64Array`s cost 24 bytes per node flat. Ids are doubles because OSM passed
 * 2^32 long ago and stayed well inside 2^53.
 */
export class NodeIndex {
  private constructor(
    private readonly ids: Float64Array,
    private readonly lons: Float64Array,
    private readonly lats: Float64Array,
  ) {}

  static from(ids: number[], lons: number[], lats: number[]): NodeIndex {
    let sorted = true;
    for (let i = 1; i < ids.length; i++)
      if (ids[i] < ids[i - 1]) {
        sorted = false;
        break;
      }
    if (sorted)
      return new NodeIndex(Float64Array.from(ids), Float64Array.from(lons), Float64Array.from(lats));
    // PBF writers emit elements in id order, so this is a fallback rather than the path.
    const order = Array.from(ids, (_, i) => i).sort((a, b) => ids[a] - ids[b]);
    const n = order.length;
    const sortedIds = new Float64Array(n);
    const sortedLons = new Float64Array(n);
    const sortedLats = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      sortedIds[i] = ids[order[i]];
      sortedLons[i] = lons[order[i]];
      sortedLats[i] = lats[order[i]];
    }
    return new NodeIndex(sortedIds, sortedLons, sortedLats);
  }

  private find(id: number): number {
    let low = 0;
    let high = this.ids.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const value = this.ids[mid];
      if (value === id) return mid;
      if (value < id) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }

  has(id: number): boolean {
    return this.find(id) >= 0;
  }

  /** `undefined` rather than a placeholder: the caller decides what a missing node means. */
  get(id: number): Position | undefined {
    const at = this.find(id);
    return at < 0 ? undefined : [this.lons[at], this.lats[at]];
  }

  get size(): number {
    return this.ids.length;
  }
}

export type CellSource = {
  /** Tagged nodes only, as Overpass emitted them and the Python builder expects. */
  nodes: OsmNode[];
  ways: OsmWay[];
  relations: OsmRelation[];
  /** Every node in the extract, including the untagged ones ways are made of. */
  positions: NodeIndex;
  wayById: Map<number, OsmWay>;
};

/**
 * A way's coordinates, or `undefined` if any node is missing.
 *
 * `complete_ways` extracts should supply every location; the Python reader emits an empty
 * placeholder and the build then discards the whole way (`waysMissingPositions`). Returning
 * `undefined` for the way says the same thing without the per-node object.
 */
export function geometry(way: OsmWay, positions: NodeIndex): Position[] | undefined {
  const coords: Position[] = [];
  for (const ref of way.refs) {
    const p = positions.get(ref);
    if (!p) return undefined;
    coords.push(p);
  }
  return coords;
}

export async function readSource(data: Uint8Array, inflate: Inflate): Promise<CellSource> {
  const nodes: OsmNode[] = [];
  const ways: OsmWay[] = [];
  const relations: OsmRelation[] = [];
  const ids: number[] = [];
  const lons: number[] = [];
  const lats: number[] = [];

  await readPbf(
    data,
    {
      node: (node) => {
        ids.push(node.id);
        lons.push(node.lon);
        lats.push(node.lat);
        // Untagged nodes exist only to give ways their shape, so they stay in the index
        // but are not elements — the same distinction Overpass `out geom;` made.
        if (Object.keys(node.tags).length > 0) nodes.push(node);
      },
      way: (way) => ways.push(way),
      relation: (relation) => relations.push(relation),
    },
    inflate,
  );

  return {
    nodes,
    ways,
    relations,
    positions: NodeIndex.from(ids, lons, lats),
    wayById: new Map(ways.map((way) => [way.id, way])),
  };
}
