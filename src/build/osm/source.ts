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

  /** The slot a node sits in, or -1. Paired with `lonAt`/`latAt` it reads a position
   * without building the `[lon, lat]` pair `get` returns — which matters when the caller
   * asks about tens of millions of node refs. */
  locate(id: number): number {
    return this.find(id);
  }

  lonAt(at: number): number {
    return this.lons[at];
  }

  latAt(at: number): number {
    return this.lats[at];
  }

  /** Whether a node exists and falls in the box, with no position object built. */
  within(id: number, west: number, south: number, east: number, north: number): boolean {
    const at = this.find(id);
    if (at < 0) return false;
    const lon = this.lons[at];
    const lat = this.lats[at];
    return lon >= west && lon <= east && lat >= south && lat <= north;
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

  /** Every id it holds, in order, for callers merging two indexes. */
  everyId(): Float64Array {
    return this.ids;
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
 * Each way's own bounding box, computed once for a whole extract.
 *
 * `subsetSource` asks whether any node of a way falls in a cell's box, which costs a binary
 * search per node ref — over a country extract that is more than a billion of them, and
 * paying it again for every cell made the subset cost twice the build. These bounds answer
 * "certainly not" for almost every way in constant time, and the exact test then runs only
 * on what survives.
 */
export class WayBounds {
  private constructor(
    private readonly west: Float64Array,
    private readonly south: Float64Array,
    private readonly east: Float64Array,
    private readonly north: Float64Array,
  ) {}

  static of(source: CellSource): WayBounds {
    const n = source.ways.length;
    const west = new Float64Array(n);
    const south = new Float64Array(n);
    const east = new Float64Array(n);
    const north = new Float64Array(n);
    const { positions } = source;
    for (let i = 0; i < n; i++) {
      let w = Infinity;
      let s = Infinity;
      let e = -Infinity;
      let no = -Infinity;
      for (const ref of source.ways[i].refs) {
        const at = positions.locate(ref);
        if (at < 0) continue;
        const lon = positions.lonAt(at);
        const lat = positions.latAt(at);
        if (lon < w) w = lon;
        if (lon > e) e = lon;
        if (lat < s) s = lat;
        if (lat > no) no = lat;
      }
      west[i] = w;
      south[i] = s;
      east[i] = e;
      north[i] = no;
    }
    return new WayBounds(west, south, east, north);
  }

  /** A way whose own box misses the cell's cannot have a node inside it. */
  mayTouch(index: number, bbox: BBox): boolean {
    return (
      this.east[index] >= bbox[0] &&
      this.west[index] <= bbox[2] &&
      this.north[index] >= bbox[1] &&
      this.south[index] <= bbox[3]
    );
  }
}

export function subsetSource(source: CellSource, bbox: BBox, bounds?: WayBounds): CellSource {
  const [west, south, east, north] = bbox;
  const { positions } = source;
  const inBox = (ref: number) => positions.within(ref, west, south, east, north);

  const ways: OsmWay[] = [];
  // Every node of a kept way, in or out of the box. `complete_ways` pulls these in, and a
  // barrier or a village sitting just outside on a road that crosses the boundary is the
  // reason: dropping it changes what the cell sees inside its own halo.
  const reachable = new Set<number>();
  for (let i = 0; i < source.ways.length; i++) {
    if (bounds && !bounds.mayTouch(i, bbox)) continue;
    const way = source.ways[i];
    for (const ref of way.refs)
      if (inBox(ref)) {
        ways.push(way);
        for (const r of way.refs) reachable.add(r);
        break;
      }
  }
  const wayById = new Map(ways.map((way) => [way.id, way]));
  const nodes = source.nodes.filter(
    (n) =>
      reachable.has(n.id) ||
      (n.lon >= west && n.lon <= east && n.lat >= south && n.lat <= north),
  );

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

  // Carry only the positions this cell can ask about, so the subset stands on its own: a
  // cell straddling a border is built by merging one of these per country, and a country
  // extract's whole node index is sixty million entries nobody here needs.
  const wanted = new Doubles();
  const seen = new Set<number>();
  const want = (ref: number) => {
    if (seen.has(ref)) return;
    seen.add(ref);
    wanted.push(ref);
  };
  for (const way of ways) for (const ref of way.refs) want(ref);
  for (const relation of relations)
    for (const m of relation.members) if (m.type === "node") want(m.ref);
  for (const node of nodes) want(node.id);
  const ids = wanted.take();
  ids.sort();
  const lons = new Float64Array(ids.length);
  const lats = new Float64Array(ids.length);
  let held = 0;
  for (let i = 0; i < ids.length; i++) {
    const at = positions.locate(ids[i]);
    if (at < 0) continue;
    ids[held] = ids[i];
    lons[held] = positions.lonAt(at);
    lats[held] = positions.latAt(at);
    held++;
  }

  return {
    nodes,
    ways,
    relations,
    positions: NodeIndex.of(ids.slice(0, held), lons.slice(0, held), lats.slice(0, held)),
    wayById,
  };
}

/**
 * Join subsets of the same cell taken from different extracts.
 *
 * A cell on a border is the union of what each country published for it. Elements repeat
 * where the extracts overlap — Geofabrik buffers each polygon past the boundary — so
 * everything is keyed by its OSM id and the first copy wins.
 */
export function mergeSources(parts: readonly CellSource[]): CellSource {
  if (parts.length === 1) return parts[0];
  const nodes = new Map<number, OsmNode>();
  const wayById = new Map<number, OsmWay>();
  const relations = new Map<number, OsmRelation>();
  const ids = new Doubles();
  const lons = new Doubles();
  const lats = new Doubles();
  const seen = new Set<number>();
  for (const part of parts) {
    for (const node of part.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
    for (const way of part.ways) if (!wayById.has(way.id)) wayById.set(way.id, way);
    for (const relation of part.relations)
      if (!relations.has(relation.id)) relations.set(relation.id, relation);
    for (const id of part.positions.everyId()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const at = part.positions.locate(id);
      ids.push(id);
      lons.push(part.positions.lonAt(at));
      lats.push(part.positions.latAt(at));
    }
  }
  return {
    nodes: [...nodes.values()],
    ways: [...wayById.values()],
    relations: [...relations.values()],
    positions: NodeIndex.from([...ids.take()], [...lons.take()], [...lats.take()]),
    wayById,
  };
}
