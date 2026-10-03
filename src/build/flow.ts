/**
 * How much motor traffic a road carries, estimated by routing trips on the car network.
 *
 * Class and speed say what a road is built for, not what it carries. A valley's only road
 * carries the whole valley, a minor road that saves drivers five minutes carries what the
 * navigation apps send down it, and a tertiary beside an arterial carries almost nothing
 * (docs/issues.md R6). Population near a road does not tell these apart — BRouter's
 * gravity estimate got both of the user's reference roads backwards — but where the
 * fastest trips between the places around it go does. Time-weighted betweenness explains
 * measured traffic counts well (Kazerani & Winter 2009; Gao et al. 2013).
 *
 * So: every settlement trips to every other within reach, in proportion to the product of
 * their populations over the square of the driving time (gravity, in time not distance),
 * each trip takes the fastest path, and the trips are summed per road. Through traffic
 * enters and leaves where main roads cross the edge of the area. The result is a relative
 * volume, comparable within a run and, roughly, between runs over similar areas.
 *
 * The search is one bounded Dijkstra per origin over typed arrays, accumulated backwards
 * along its shortest-path tree, as Brandes' betweenness does.
 */
import { distance } from "../geo/distance";
import type { CellSource } from "./osm/source";
import { geometry } from "./osm/source";
import type { OsmTags } from "./osm/pbf";
import type { BBox } from "./surface";

/** Roads that carry through traffic. Service roads and tracks only reach somewhere. */
const CAR_ROADS = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
  "residential", "living_street", "road",
]);
/**
 * A typical free-flow speed by class, km/h: what a driver actually manages, not the sign.
 * A tagged limit replaces it where lower, so a 30 zone is slow whatever its class.
 */
const CLASS_KMH: Record<string, number> = {
  motorway: 115, motorway_link: 60, trunk: 95, trunk_link: 50,
  primary: 75, primary_link: 45, secondary: 65, secondary_link: 40,
  tertiary: 55, tertiary_link: 35, unclassified: 45, residential: 28,
  living_street: 12, road: 30,
};
const PLACE_POPULATION: Record<string, number> = { city: 60000, town: 8000, village: 800 };
/** How far a place's people live from its centre, by kind: they leave from all over it. */
const PLACE_SPREAD_M: Record<string, number> = { city: 4000, town: 1500, village: 400 };
/** One origin per this many people, so a town's own streets carry its trips. */
const PEOPLE_PER_ORIGIN = 1500;
const MAX_ORIGINS_PER_PLACE = 40;
/** Through traffic entering at the area's edge, as if from a place this big beyond it. */
const GATEWAY_POPULATION: Record<string, number> = {
  motorway: 40000, trunk: 20000, primary: 8000, secondary: 2000,
};
/** Trips longer than this are few, and the search cost grows with its square. */
const CUTOFF_S = 40 * 60;
/** Below this a trip is local; it keeps neighbouring villages from dominating. */
const MIN_TRIP_S = 5 * 60;
/** How far a place may sit from the road it is reached by. */
const SNAP_M = 1500;
/** A gateway is a main road with a node this close to the area's edge. */
const EDGE_M = 1500;

const ONEWAY_YES = new Set(["yes", "1", "true"]);

function parseKmh(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(mph)?$/.exec(value.trim());
  if (!match) return undefined;
  return Number(match[1]) * (match[2] ? 1.609 : 1);
}

export function driveable(tags: OsmTags): boolean {
  if (!CAR_ROADS.has(tags.highway ?? "")) return false;
  if (tags.area === "yes") return false;
  for (const key of ["motor_vehicle", "motorcar", "vehicle", "access"]) {
    const value = tags[key];
    if (value === undefined) continue;
    return !(value === "no" || value === "private" || value === "agricultural" || value === "forestry");
  }
  return true;
}

function kmh(tags: OsmTags): number {
  const base = CLASS_KMH[tags.highway ?? ""] ?? 30;
  const tagged = parseKmh(tags.maxspeed);
  return tagged ? Math.min(base, tagged * 0.9) : base;
}

/** Population a place node stands for. */
function population(tags: OsmTags): number {
  const tagged = Number((tags.population ?? "").replace(/[ ,.']/g, ""));
  if (Number.isFinite(tagged) && tagged > 0) return tagged;
  return PLACE_POPULATION[tags.place ?? ""] ?? 0;
}

/** A binary min-heap of node indices keyed by float, with lazy deletion. */
class IndexHeap {
  private keys = new Float64Array(1024);
  private items = new Int32Array(1024);
  size = 0;
  push(key: number, item: number) {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.keys = keys;
      const items = new Int32Array(this.size * 2);
      items.set(this.items);
      this.items = items;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[i] = this.keys[parent];
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.keys[i] = key;
    this.items[i] = item;
  }
  /** Pops into `top`; false when empty. */
  pop(top: { key: number; item: number }): boolean {
    if (!this.size) return false;
    top.key = this.keys[0];
    top.item = this.items[0];
    const n = --this.size;
    const key = this.keys[n],
      item = this.items[n];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= key) break;
      this.keys[i] = this.keys[child];
      this.items[i] = this.items[child];
      i = child;
    }
    this.keys[i] = key;
    this.items[i] = item;
    return true;
  }
}

export type FlowResult = {
  /** Trips per OSM way id, both directions together: the busiest stretch of the way. */
  byWay: Map<number, number>;
  counts: { nodes: number; arcs: number; origins: number; gateways: number; ms: number };
};

/**
 * Relative motor traffic on every driveable way in `source`.
 *
 * `area` is the box trips start and end in; the source should cover it. Only origins
 * inside `origins` (default: the whole area) are routed from, which lets a cell route from
 * its neighbourhood alone while still receiving trips from further away — every pair is
 * routed once from each end, so trips into the core from outside are seen from the core.
 */
export function trafficFlow(
  source: CellSource,
  area: BBox,
  options: { origins?: BBox; cutoffS?: number } = {},
): FlowResult {
  const started = Date.now();
  const cutoff = options.cutoffS ?? CUTOFF_S;
  const ways = source.ways.filter((w) => w.refs.length > 1 && driveable(w.tags));

  // Nodes are cut where car roads meet or end, so arcs are whole road stretches.
  const usage = new Map<number, number>();
  for (const way of ways)
    for (const ref of way.refs) usage.set(ref, (usage.get(ref) ?? 0) + 1);
  const index = new Map<number, number>();
  const lon: number[] = [];
  const lat: number[] = [];
  const nodeOf = (ref: number, p: [number, number]) => {
    let i = index.get(ref);
    if (i === undefined) {
      i = lon.length;
      index.set(ref, i);
      lon.push(p[0]);
      lat.push(p[1]);
    }
    return i;
  };

  const from: number[] = [];
  const to: number[] = [];
  const seconds: number[] = [];
  const wayOf: number[] = [];
  /** The arc the other way along the same stretch, or -1 on a one-way road. */
  const twin: number[] = [];
  const mainAt = new Map<number, { highway: string; way: number }>();
  for (const way of ways) {
    const coords = geometry(way, source.positions);
    if (!coords) continue;
    const tags = way.tags;
    const speed = kmh(tags) / 3.6;
    const highway = tags.highway!;
    const oneway =
      ONEWAY_YES.has(tags.oneway ?? "") ||
      tags.junction === "roundabout" ||
      ((highway === "motorway" || highway === "motorway_link") && tags.oneway !== "no");
    const reverse = tags.oneway === "-1";
    let start = 0;
    let length = 0;
    for (let i = 1; i < way.refs.length; i++) {
      length += distance(coords[i - 1], coords[i]);
      if (i < way.refs.length - 1 && (usage.get(way.refs[i]) ?? 0) < 2) continue;
      const a = nodeOf(way.refs[start], coords[start]);
      const b = nodeOf(way.refs[i], coords[i]);
      const t = length / speed;
      const forward = !reverse;
      const backward = reverse || !oneway;
      const k = from.length;
      const arc = (x: number, y: number) => {
        from.push(x);
        to.push(y);
        seconds.push(t);
        wayOf.push(way.id);
        twin.push(-1);
      };
      if (forward) arc(a, b);
      if (backward) arc(b, a);
      if (forward && backward) {
        twin[k] = k + 1;
        twin[k + 1] = k;
      }
      if (GATEWAY_POPULATION[highway] !== undefined)
        for (const n of [a, b]) {
          const held = mainAt.get(n);
          if (!held || GATEWAY_POPULATION[highway] > GATEWAY_POPULATION[held.highway])
            mainAt.set(n, { highway, way: way.id });
        }
      start = i;
      length = 0;
    }
  }

  const n = lon.length;
  const arcs = from.length;
  // Outgoing arcs per node, CSR.
  const first = new Int32Array(n + 1);
  for (let e = 0; e < arcs; e++) first[from[e] + 1]++;
  for (let i = 0; i < n; i++) first[i + 1] += first[i];
  const out = new Int32Array(arcs);
  const fill = first.slice(0, n);
  for (let e = 0; e < arcs; e++) out[fill[from[e]]++] = e;
  const head = Int32Array.from(to);
  const cost = Float64Array.from(seconds);

  // Places, snapped to the nearest node on a car road.
  const BUCKET = 0.01;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.floor(lon[i] / BUCKET)}:${Math.floor(lat[i] / BUCKET)}`;
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  }
  const nearest = (p: [number, number]) => {
    let best = -1,
      bestD = SNAP_M;
    const cx = Math.floor(p[0] / BUCKET),
      cy = Math.floor(p[1] / BUCKET);
    for (let x = cx - 2; x <= cx + 2; x++)
      for (let y = cy - 2; y <= cy + 2; y++)
        for (const i of grid.get(`${x}:${y}`) ?? []) {
          const d = distance(p, [lon[i], lat[i]]);
          if (d < bestD) [best, bestD] = [i, d];
        }
    return best;
  };
  const within = (p: [number, number], radius: number) => {
    const found: number[] = [];
    const reach = Math.ceil(radius / 700) + 1;
    const cx = Math.floor(p[0] / BUCKET),
      cy = Math.floor(p[1] / BUCKET);
    for (let x = cx - reach; x <= cx + reach; x++)
      for (let y = cy - reach; y <= cy + reach; y++)
        for (const i of grid.get(`${x}:${y}`) ?? [])
          if (distance(p, [lon[i], lat[i]]) <= radius) found.push(i);
    return found;
  };
  const inBox = (b: BBox, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

  const weight = new Float64Array(n);
  let gateways = 0;
  for (const node of source.nodes) {
    const people = population(node.tags);
    if (!people || !inBox(area, node.lon, node.lat)) continue;
    // The road nodes within the place's spread, nearest first, take its people in equal
    // shares; a hamlet with one road takes them all at that road.
    const spread = PLACE_SPREAD_M[node.tags.place ?? ""] ?? 400;
    const share = Math.max(1, Math.min(MAX_ORIGINS_PER_PLACE, Math.round(people / PEOPLE_PER_ORIGIN)));
    const around = within([node.lon, node.lat], spread);
    if (!around.length) {
      const at = nearest([node.lon, node.lat]);
      if (at >= 0) weight[at] += people;
      continue;
    }
    // Evenly through the list, which is in no spatial order, so the shares scatter.
    const step = Math.max(1, Math.floor(around.length / share));
    const picked = around.filter((_, i) => i % step === 0).slice(0, share);
    for (const at of picked) weight[at] += people / picked.length;
  }
  // Through traffic: one gateway per main way that reaches the edge, at its outermost node.
  const edgeDeg = EDGE_M / 111_320;
  const outermost = new Map<number, { node: number; gap: number; highway: string }>();
  for (const [node, { highway, way }] of mainAt) {
    const [x, y] = [lon[node], lat[node]];
    if (!inBox(area, x, y)) continue;
    const k = Math.cos((y * Math.PI) / 180);
    const gap = Math.min((x - area[0]) * k, (area[2] - x) * k, y - area[1], area[3] - y);
    if (gap > edgeDeg) continue;
    const held = outermost.get(way);
    if (!held || gap < held.gap) outermost.set(way, { node, gap, highway });
  }
  for (const { node, highway } of outermost.values()) {
    weight[node] += GATEWAY_POPULATION[highway];
    gateways++;
  }

  const origins: number[] = [];
  const core = options.origins ?? area;
  for (let i = 0; i < n; i++) if (weight[i] > 0 && inBox(core, lon[i], lat[i])) origins.push(i);

  const flow = new Float64Array(arcs);
  const dist = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const acc = new Float64Array(n);
  const order = new Int32Array(n);
  const heap = new IndexHeap();
  const top = { key: 0, item: 0 };
  for (const origin of origins) {
    let settled = 0;
    dist[origin] = 0;
    heap.push(0, origin);
    while (heap.pop(top)) {
      const u = top.item;
      if (top.key > dist[u]) continue;
      order[settled++] = u;
      for (let k = first[u]; k < first[u + 1]; k++) {
        const e = out[k];
        const v = head[e];
        const d = top.key + cost[e];
        if (d < dist[v] && d <= cutoff) {
          dist[v] = d;
          parent[v] = e;
          heap.push(d, v);
        }
      }
    }
    // Backwards along the tree: each node's trips pass through its parent arc.
    const source_ = weight[origin];
    for (let s = settled - 1; s >= 0; s--) {
      const v = order[s];
      if (v !== origin && weight[v] > 0) {
        const t = Math.max(dist[v], MIN_TRIP_S);
        acc[v] += (source_ * weight[v]) / (t * t);
      }
      const e = parent[v];
      if (e >= 0) {
        flow[e] += acc[v];
        acc[from[e]] += acc[v];
      }
    }
    for (let s = 0; s < settled; s++) {
      const v = order[s];
      dist[v] = Infinity;
      parent[v] = -1;
      acc[v] = 0;
    }
  }

  const byWay = new Map<number, number>();
  for (let e = 0; e < arcs; e++) {
    const both = flow[e] + (twin[e] >= 0 ? flow[twin[e]] : 0);
    const way = wayOf[e];
    if (both > (byWay.get(way) ?? 0)) byWay.set(way, both);
  }
  return {
    byWay,
    counts: { nodes: n, arcs, origins: origins.length, gateways, ms: Date.now() - started },
  };
}

/** How far around a cell trips are routed: about 40 minutes' drive on main roads. */
export const FLOW_HALO_KM = 40;

/** The box a cell's traffic is estimated over: the cell and `FLOW_HALO_KM` around it. */
export function flowBox(bbox: BBox): BBox {
  const lat = (bbox[1] + bbox[3]) / 2;
  const dx = FLOW_HALO_KM / (111.32 * Math.cos((lat * Math.PI) / 180));
  const dy = FLOW_HALO_KM / 111.32;
  return [bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy];
}

/**
 * What the estimate reads from an extract: the driveable roads and the places. A wide box
 * of everything would hold tens of millions of nodes; this is a small part of that.
 */
export function carNetwork(source: CellSource): CellSource {
  return {
    ...source,
    nodes: source.nodes.filter((n) => population(n.tags) > 0),
    ways: source.ways.filter((w) => driveable(w.tags)),
    relations: [],
  };
}

/**
 * Traffic on a way as the stress model reads it: log10 of one plus its trips. Undefined
 * for a way cars cannot use, or when no estimate was made.
 */
export function wayVolume(
  flow: ReadonlyMap<number, number> | undefined,
  id: number,
  tags: OsmTags,
): number | undefined {
  if (!flow || !driveable(tags)) return undefined;
  return Math.log10(1 + (flow.get(id) ?? 0));
}
