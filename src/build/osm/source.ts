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
import { keepNode, keepRelation, keepWay } from "./filter";
import type { BBox } from "../../geo/grid";

export type { OsmNode, OsmRelation, OsmWay };
/** Matches `Point` in `src/routing/types`, so geometry flows into the rest of the build. */
export type Position = [number, number];

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
    return NodeIndex.of(Float64Array.from(ids), Float64Array.from(lons), Float64Array.from(lats));
  }

  /** The same, for callers that already hold typed arrays and want no further copy. */
  static of(ids: Float64Array, lons: Float64Array, lats: Float64Array): NodeIndex {
    let sorted = true;
    for (let i = 1; i < ids.length; i++)
      if (ids[i] < ids[i - 1]) {
        sorted = false;
        break;
      }
    if (sorted) return new NodeIndex(ids, lons, lats);
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

/**
 * A growable `Float64Array`. A country extract holds tens of millions of nodes, and
 * collecting them in a JS array first costs the same memory twice over before the copy.
 */
class Doubles {
  private data = new Float64Array(1 << 16);
  private used = 0;
  push(value: number) {
    if (this.used === this.data.length) {
      const next = new Float64Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.used++] = value;
  }
  /** A right-sized copy, so the index does not retain the growth buffer. */
  take(): Float64Array {
    return this.data.slice(0, this.used);
  }
}

export type ReadOptions = {
  /**
   * Drop elements the graph build never reads, the way `clip_region.py`'s `tags-filter`
   * did. A per-cell extract cut by that script is already reduced, so this changes nothing
   * for one; a raw Geofabrik download is mostly elements we do not want.
   */
  filter?: boolean;
};

export async function readSource(
  data: Uint8Array,
  inflate: Inflate,
  options: ReadOptions = {},
): Promise<CellSource> {
  const filter = options.filter ?? false;
  // `osmium tags-filter` keeps the objects a matched object references, and a multipolygon
  // names its outline in ways that usually carry no tags of their own. Ways come before
  // relations in a PBF, so which ones those are is only known after a first pass — without
  // it a forest relation arrives with no rings and the cost surfaces come out empty.
  const referencedWays = new Set<number>();
  const referencedNodes = new Set<number>();
  if (filter)
    await readPbf(
      data,
      {
        relation: (relation) => {
          if (!keepRelation(relation.tags)) return;
          for (const m of relation.members)
            if (m.type === "way") referencedWays.add(m.ref);
            else if (m.type === "node") referencedNodes.add(m.ref);
        },
      },
      inflate,
    );

  const nodes: OsmNode[] = [];
  const ways: OsmWay[] = [];
  const relations: OsmRelation[] = [];
  const ids = new Doubles();
  const lons = new Doubles();
  const lats = new Doubles();

  await readPbf(
    data,
    {
      node: (node) => {
        ids.push(node.id);
        lons.push(node.lon);
        lats.push(node.lat);
        // Untagged nodes exist only to give ways their shape, so they stay in the index
        // but are not elements — the same distinction Overpass `out geom;` made.
        if (Object.keys(node.tags).length === 0) return;
        if (!filter || keepNode(node.tags) || referencedNodes.has(node.id)) nodes.push(node);
      },
      way: (way) => {
        if (!filter || keepWay(way.tags) || referencedWays.has(way.id)) ways.push(way);
      },
      relation: (relation) => {
        if (!filter || keepRelation(relation.tags)) relations.push(relation);
      },
    },
    inflate,
  );

  return {
    nodes,
    ways,
    relations,
    positions: NodeIndex.of(ids.take(), lons.take(), lats.take()),
    wayById: new Map(ways.map((way) => [way.id, way])),
  };
}

/**
 * The part of a larger extract that one cell needs, on the rule `osmium extract
 * --strategy=complete_ways` used: a way is in if any of its nodes is in the box, and it
 * comes in whole.
 *
 * The node index is shared rather than copied, so a way reaching past the box still
 * resolves every coordinate — which is what `complete_ways` was for, and is why building a
 * cell from its country's extract needs no second pass to chase missing nodes.
 */
export function subsetSource(source: CellSource, bbox: BBox): CellSource {
  const [west, south, east, north] = bbox;
  const { positions } = source;
  const inBox = (ref: number): boolean => {
    const p = positions.get(ref);
    return !!p && p[0] >= west && p[0] <= east && p[1] >= south && p[1] <= north;
  };

  const ways: OsmWay[] = [];
  // Every node of a kept way, in or out of the box. `complete_ways` pulls these in, and a
  // barrier or a village sitting just outside on a road that crosses the boundary is the
  // reason: dropping it changes what the cell sees inside its own halo.
  const reachable = new Set<number>();
  for (const way of source.ways)
    for (const ref of way.refs)
      if (inBox(ref)) {
        ways.push(way);
        for (const r of way.refs) reachable.add(r);
        break;
      }
  const wayById = new Map(ways.map((way) => [way.id, way]));
  const nodes = source.nodes.filter((n) => reachable.has(n.id) || inBox(n.id));

  // A relation comes in when a member way is in, or a member node is in the box itself —
  // a restriction whose via node fell outside is not this cell's business, even when the
  // road carrying it reaches in.
  const kept = new Set<number>();
  for (const relation of source.relations)
    if (
      relation.members.some((m) =>
        m.type === "way" ? wayById.has(m.ref) : m.type === "node" && inBox(m.ref),
      )
    )
      kept.add(relation.id);
  // Then the relations that hold those: a EuroVelo superroute names its national parts and
  // no way at all, so without this pass a cell on the route never sees it.
  for (let grew = true; grew; ) {
    grew = false;
    for (const relation of source.relations) {
      if (kept.has(relation.id)) continue;
      if (relation.members.some((m) => m.type === "relation" && kept.has(m.ref))) {
        kept.add(relation.id);
        grew = true;
      }
    }
  }
  const relations = source.relations.filter((relation) => kept.has(relation.id));
  return { nodes, ways, relations, positions, wayById };
}
