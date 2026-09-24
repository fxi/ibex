import { buildHeuristic } from "./heuristic";
import { indexEdges } from "./adjacency";
import { fromGraph, isLegGraph, nodesOf, type LegGraph } from "./legGraph";
import { compileRestrictions, restrictionAllowsBy } from "./restrictions";
import {
  buildField,
  cell,
  center,
  corridorCells,
  fieldPath,
  validateProfileData,
} from "./field";
import {
  costCache,
  cycleInfrastructure,
  deviation,
  emptyComponents,
  HARD_TERMS,
  scoreEdge,
  total,
  trafficHazard,
  turnAngleCost,
  turnCost,
  turnStrength,
  unpavedHazard,
  type HardTerm,
} from "./cost";
import { pointInBounds, project } from "../geo/project";
import { Heap } from "./heap";
import { distance } from "../geo/distance";
import type { Profile } from "./profiles";
import { toCompiled, type CompiledProfile } from "./compile";
import { ENGINE } from "./vocabulary";
import { eligible, isFerry, rideClass, traversalSegments } from "./eligibility";
import { edgeSignals } from "./signals";
import { TRAFFIC_WHY_TAG } from "./types";
import type {
  Components,
  Edge,
  Field,
  Graph,
  Node,
  Point,
  RouteRequest,
  RouteResult,
} from "./types";

// Re-exported: the search, the importer and a dozen scripts all measure with the same one.
export { distance };
// Re-exported: tests drive it directly, and the field raster uses it too.
export { Heap };

// Re-exported: the field is built here for a route and by legs.ts for a comparison.
export { buildField, cell, center, corridorCells, fieldPath };

// Re-exported: the cost model is its own module now, but the engine stays the one import
// every consumer and script already uses.
export {
  costCache,
  cycleInfrastructure,
  deviation,
  emptyComponents,
  HARD_TERMS,
  scoreEdge,
  total,
  trafficHazard,
  turnCost,
  unpavedHazard,
  type HardTerm,
};

// Re-exported: snapping and the map both project onto the same segments.
export { pointInBounds, project };

/** Split both directions of the selected physical edge; never invent links between nearby ways. */
export function snapAnchors(
  graph: Graph,
  anchors: Point[],
  /** Ids to number new nodes and edges from, when `graph` is only part of the leg. */
  next?: { node: number; edge: number },
): { graph: Graph; nodes: number[]; points: Point[] } | null {
  const nodes = [...graph.nodes],
    edges = [...graph.edges];
  const snapped: number[] = [],
    points: Point[] = [];
  let nextNode = 0;
  for (const n of nodes) nextNode = Math.max(nextNode, n.id);
  nextNode++;
  let nextEdge = edges.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  if (next) {
    nextNode = next.node;
    nextEdge = next.edge;
  }
  for (const p of anchors) {
    let best:
      | { edge: Edge; index: number; point: Point; along: number; gap: number }
      | undefined;
    for (const edge of edges) {
      let along = 0;
      for (let i = 1; i < edge.geometry.length; i++) {
        const a = edge.geometry[i - 1],
          b = edge.geometry[i],
          projection = project(p, a, b),
          len = distance(a, b);
        // Elevated structures are candidates only near portals, unless the point is very close to their line.
        const penalty =
          (edge.bridge || edge.tunnel) && projection.distance > 8 ? 80 : 0;
        if (!best || projection.distance + penalty < best.gap)
          best = {
            edge,
            index: i,
            point: projection.point,
            along: along + len * projection.t,
            gap: projection.distance + penalty,
          };
        along += len;
      }
    }
    if (!best || best.gap > 250) return null;
    const selected = best.edge,
      geometryLength = selected.geometry
        .slice(1)
        .reduce((s, b, i) => s + distance(selected.geometry[i], b), 0);
    if (best.along < 1) {
      snapped.push(selected.from);
      points.push(selected.geometry[0]);
      continue;
    }
    if (geometryLength - best.along < 1) {
      snapped.push(selected.to);
      points.push(selected.geometry.at(-1)!);
      continue;
    }
    const id = nextNode++;
    let elevation =
      nodes.find((n) => n.id === selected.from)?.elevation ?? null;
    if (elevation !== null && selected.grades) {
      let remaining = (selected.length * best.along) / geometryLength;
      for (const [length, grade] of selected.grades) {
        const take = Math.min(remaining, length);
        elevation += take * grade;
        remaining -= take;
        if (remaining <= 0) break;
      }
    } else elevation = null;
    nodes.push({ id, p: best.point, elevation });
    snapped.push(id);
    points.push(best.point);
    const targets = edges.filter(
      (e) =>
        e === selected ||
        (e.way === selected.way &&
          e.from === selected.to &&
          e.to === selected.from &&
          e.geometry.length === selected.geometry.length &&
          e.geometry.every((p, i) => {
            const q = selected.geometry[selected.geometry.length - 1 - i];
            return p[0] === q[0] && p[1] === q[1];
          })),
    );
    for (const edge of targets) {
      const forward = edge === selected;
      const geom = forward
        ? selected.geometry
        : [...selected.geometry].reverse();
      const index = forward ? best.index : geom.length - best.index;
      const ratio = forward
        ? best.along / geometryLength
        : 1 - best.along / geometryLength;
      const splitGrades = (start: number, end: number) => {
        if (!edge.grades) return null;
        const result: [number, number][] = [];
        let offset = 0;
        for (const [length, grade] of edge.grades) {
          const overlap = Math.max(
            0,
            Math.min(offset + length, end) - Math.max(offset, start),
          );
          if (overlap) result.push([overlap, grade]);
          offset += length;
        }
        return result;
      };
      edges.splice(edges.indexOf(edge), 1);
      edges.push(
        {
          ...edge,
          id: nextEdge++,
          to: id,
          junction: 0,
          length: edge.length * ratio,
          geometry: [...geom.slice(0, index), best.point],
          grades: splitGrades(0, edge.length * ratio),
          ...(edge.ferrySeconds === undefined
            ? {}
            : { ferrySeconds: edge.ferrySeconds * ratio }),
        },
        {
          ...edge,
          id: nextEdge++,
          from: id,
          length: edge.length * (1 - ratio),
          geometry: [best.point, ...geom.slice(index)],
          grades: splitGrades(edge.length * ratio, edge.length),
          ...(edge.ferrySeconds === undefined
            ? {}
            : { ferrySeconds: edge.ferrySeconds * (1 - ratio) }),
        },
      );
    }
  }
  return { graph: { ...graph, nodes, edges }, nodes: snapped, points };
}

export function ferryBoardingCost(
  edge: Edge,
  previous: Edge | undefined,
  profile: Profile | CompiledProfile,
): number {
  if (
    !isFerry(edge) ||
    (previous &&
      isFerry(previous) &&
      (edge.ferryService ?? edge.way) ===
        (previous.ferryService ?? previous.way))
  )
    return 0;
  return toCompiled(profile).permissions.ferry
    ? ENGINE.ferry_boarding_meters
    : 0;
}
/**
 * Search states, by id, in flat arrays.
 *
 * A state is a node in a leg, with the restriction history that brought it there and the
 * node the edge into it left from. It used to be an object under a string key in two
 * Maps, a few hundred bytes each; a long leg keeps millions, and a phone kills the tab
 * long before a desktop notices. `head` holds the latest state at each (node, leg), and
 * `chain` links the few others there that differ in history or departure node.
 */
class SearchStates {
  size = 0;
  node = new Int32Array(1024);
  leg = new Int32Array(1024);
  history = new Int32Array(1024);
  from = new Int32Array(1024);
  previous = new Int32Array(1024);
  chain = new Int32Array(1024);
  cost = new Float64Array(1024);
  /** The search edge the state was reached by, or -1. */
  edge = new Int32Array(1024);
  private readonly head: Int32Array;
  constructor(
    nodes: number,
    private readonly legs: number,
  ) {
    this.head = new Int32Array(nodes * legs).fill(-1);
  }
  find(node: number, leg: number, history: number, from: number): number {
    for (let s = this.head[node * this.legs + leg]; s !== -1; s = this.chain[s])
      if (this.history[s] === history && this.from[s] === from) return s;
    return -1;
  }
  add(node: number, leg: number, history: number, from: number): number {
    if (this.size === this.node.length) this.grow();
    const s = this.size++,
      slot = node * this.legs + leg;
    this.node[s] = node;
    this.leg[s] = leg;
    this.history[s] = history;
    this.from[s] = from;
    this.previous[s] = -1;
    this.cost[s] = Infinity;
    this.edge[s] = -1;
    this.chain[s] = this.head[slot];
    this.head[slot] = s;
    return s;
  }
  private grow() {
    const double = <A extends Int32Array | Float64Array>(a: A): A => {
      const b = new (a.constructor as new (n: number) => A)(a.length * 2);
      b.set(a);
      return b;
    };
    this.node = double(this.node);
    this.leg = double(this.leg);
    this.history = double(this.history);
    this.from = double(this.from);
    this.previous = double(this.previous);
    this.chain = double(this.chain);
    this.cost = double(this.cost);
    this.edge = double(this.edge);
  }
}
/**
 * Describe one edge as one or more uniform stretches, appended to the running result.
 *
 * `traversalSegments` splits an edge by grade run, which need not line up with its
 * geometry vertices, so each geometry span is classified by the run covering its
 * midpoint and consecutive spans of the same class are merged. Segments therefore always
 * start and end on real vertices, which is what the map needs to draw them.
 */
function appendSegments(
  result: RouteResult,
  edge: Edge,
  profile: Profile | CompiledProfile,
  base: number,
) {
  const points = edge.geometry;
  if (points.length < 2) return;
  const runs = traversalSegments(edge, profile);
  const spans: number[] = [];
  let geometryLength = 0;
  for (let i = 1; i < points.length; i++) {
    const d = distance(points[i - 1], points[i]);
    spans.push(d);
    geometryLength += d;
  }
  // Runs measure the edge's own length, which can differ slightly from the sum of its
  // straight-line spans; rescale so a midpoint lands in the run the builder intended.
  const runLength = runs.reduce((sum, r) => sum + r.length, 0);
  const scale =
    geometryLength > 0 && runLength > 0 ? runLength / geometryLength : 1;
  const runAt = (meters: number) => {
    let acc = 0;
    for (const run of runs) {
      acc += run.length;
      if (meters <= acc) return run;
    }
    return runs[runs.length - 1];
  };

  const sac = edge.tags?.sac_scale;
  const trafficWhy = edge.tags?.[TRAFFIC_WHY_TAG];
  let cursor = 0;
  let startIndex = 0;
  let startRun = runAt(spans[0] / 2);
  let ride = rideClass(edge, startRun.mode);
  let lengthM = 0;
  const flush = (endIndex: number) => {
    result.segments.push({
      start: base + startIndex,
      end: base + endIndex,
      ride,
      surface: edge.surface,
      highway: edge.highway,
      ...(sac === undefined ? {} : { sac }),
      grade: startRun.grade,
      // Constant per edge, so segments split out of one edge share it. Two decimals because
      // stress is an estimate: more digits would be noise in every stored route.
      stress: Math.round(edge.stress * 100) / 100,
      ...(trafficWhy === undefined ? {} : { trafficWhy }),
      roughness: Math.round(edgeSignals(edge).roughness * 100) / 100,
      lengthM,
    });
  };
  for (let i = 0; i < spans.length; i++) {
    const run = runAt(cursor + spans[i] / 2);
    const next = rideClass(edge, run.mode);
    if (i > 0 && next !== ride) {
      flush(i);
      startIndex = i;
      startRun = run;
      ride = next;
      lengthM = 0;
    }
    lengthM += spans[i];
    cursor += spans[i] * scale;
  }
  flush(spans.length);
}

/** The shorter of an edge's length and its graded length, which the A* bound divides. */
const spanOf = (edge: Edge) =>
  Math.min(
    edge.length,
    edge.grades?.reduce((sum, [length]) => sum + length, 0) ?? edge.length,
  );

/** Whether any segment of `edge` lies within `meters` of `p`, measured as snapping does. */
function reaches(edge: Edge, p: Point, meters: number): boolean {
  for (let i = 1; i < edge.geometry.length; i++)
    if (project(p, edge.geometry[i - 1], edge.geometry[i]).distance <= meters)
      return true;
  return false;
}

export function route(
  input: Graph | LegGraph,
  request: RouteRequest,
  mode: "reference" | "corridor",
  providedField?: Field,
  fixedRadius?: number,
): RouteResult {
  request = { ...request, profile: toCompiled(request.profile) };
  if (!isLegGraph(input)) validateProfileData(input);
  const graph = isLegGraph(input) ? input : fromGraph(input);
  const startTime = performance.now();
  const result: RouteResult = {
    status: "no-path",
    mode,
    geometry: [],
    anchors: [],
    cost: 0,
    components: emptyComponents(),
    distanceM: 0,
    hikeABikeM: 0,
    ferryM: 0,
    ascentM: null,
    descentM: null,
    elevationProfile: [],
    edgeIds: [],
    segments: [],
    surfaceM: {},
    uncertainM: 0,
    metrics: {
      durationMs: 0,
      explored: 0,
      expansions: 0,
      tiles: 0,
      loadedBytes: 0,
    },
  };
  const finish = () => {
    result.metrics.durationMs = performance.now() - startTime;
    return result;
  };
  if (
    request.anchors.length < 2 ||
    request.anchors.some((p) => !pointInBounds(p, graph.bbox))
  ) {
    result.status = "outside-coverage";
    return finish();
  }
  // One pass over the leg, each edge decoded once and let go: which edges this profile
  // may ride, and which lie near enough an anchor to be snapped to. A snap never lands
  // farther than 250 m, so only those edges need to exist as objects for `snapAnchors`,
  // and it sees them in the order the whole graph would have shown them.
  const edgeCount = graph.from.length;
  const keep: number[] = [],
    near: Edge[] = [],
    nearRefs: number[] = [];
  let span: Float64Array | undefined = new Float64Array(edgeCount);
  let maxEdgeId = 0;
  for (let e = 0; e < edgeCount; e++) {
    const edge = graph.edge(e);
    if (!eligible(edge, request.profile)) continue;
    keep.push(e);
    maxEdgeId = Math.max(maxEdgeId, edge.id);
    span[e] = spanOf(edge);
    if (request.anchors.some((p) => reaches(edge, p, 250))) {
      near.push(edge);
      nearRefs.push(e);
    }
  }
  const baseNodes = graph.nodeId.length;
  let maxNodeId = 0;
  for (let i = 0; i < baseNodes; i++)
    if (!Number.isNaN(graph.lon[i]))
      maxNodeId = Math.max(maxNodeId, graph.nodeId[i]);
  const ends = new Map<number, number>();
  for (const ref of nearRefs) {
    ends.set(graph.nodeId[graph.from[ref]], graph.from[ref]);
    ends.set(graph.nodeId[graph.to[ref]], graph.to[ref]);
  }
  const nearNodes: Node[] = [];
  for (const i of ends.values())
    if (!Number.isNaN(graph.lon[i]))
      nearNodes.push({
        id: graph.nodeId[i],
        p: [graph.lon[i], graph.lat[i]],
        elevation: Number.isNaN(graph.elevation[i]) ? null : graph.elevation[i],
      });
  const snap = snapAnchors(
    {
      schemaVersion: 1,
      bbox: graph.bbox,
      nodes: nearNodes,
      edges: near,
      restrictions: [],
    },
    request.anchors,
    { node: maxNodeId + 1, edge: maxEdgeId + 1 },
  );
  if (!snap) {
    result.status = "snap-failed";
    return finish();
  }
  result.anchors = snap.points;

  // The search graph: the eligible edges, less those a snap split, plus the pieces it
  // split them into, in that order — the order the split used to leave the edge list in.
  const survived = new Set(snap.graph.edges),
    nearSet = new Set(near);
  const removed = new Set(nearRefs.filter((_, k) => !survived.has(near[k])));
  const extras = snap.graph.edges.filter((e) => !nearSet.has(e));
  const extraNodes = snap.graph.nodes.slice(nearNodes.length);
  const nodeCount = baseNodes + extraNodes.length;
  const nodeIds = new Float64Array(nodeCount),
    lon = new Float64Array(nodeCount),
    lat = new Float64Array(nodeCount),
    elevation = new Float64Array(nodeCount);
  nodeIds.set(graph.nodeId);
  lon.set(graph.lon);
  lat.set(graph.lat);
  elevation.set(graph.elevation);
  for (const [j, node] of extraNodes.entries()) {
    const i = baseNodes + j;
    ends.set(node.id, i);
    nodeIds[i] = node.id;
    lon[i] = node.p[0];
    lat[i] = node.p[1];
    elevation[i] = node.elevation ?? NaN;
  }
  const searchCount = keep.length - removed.size + extras.length;
  const refs = new Int32Array(searchCount),
    from = new Int32Array(searchCount),
    to = new Int32Array(searchCount),
    spans = new Float64Array(searchCount);
  let k = 0;
  for (const e of keep) {
    if (removed.has(e)) continue;
    refs[k] = e;
    from[k] = graph.from[e];
    to[k] = graph.to[e];
    spans[k] = span[e];
    k++;
  }
  span = undefined;
  const extraTiles = new Map<string, number>(graph.tiles.map((t, i) => [t, i]));
  for (const [x, edge] of extras.entries()) {
    refs[k] = edgeCount + x;
    from[k] = ends.get(edge.from)!;
    to[k] = ends.get(edge.to)!;
    spans[k] = spanOf(edge);
    if (!extraTiles.has(edge.tile)) extraTiles.set(edge.tile, extraTiles.size);
    k++;
  }
  const edgeAt = (s: number): Edge =>
    refs[s] < edgeCount ? graph.edge(refs[s]) : extras[refs[s] - edgeCount];
  const wayOf = (s: number): string =>
    refs[s] < edgeCount ? graph.way(refs[s]) : extras[refs[s] - edgeCount].way;
  const tileOf = (s: number): number =>
    refs[s] < edgeCount
      ? graph.tile[refs[s]]
      : extraTiles.get(extras[refs[s] - edgeCount].tile)!;
  const index = indexEdges(lon, lat, from, to);
  const targets = snap.nodes.map((id) => ends.get(id)!);
  // Distinct neighbours of a node, for `turnCost`: three or more is a real intersection.
  const degrees = new Int32Array(nodeCount).fill(-1);
  const degree = (node: number) => {
    let d = degrees[node];
    if (d < 0) {
      const neighbours = new Set<number>();
      for (let k = index.outStart[node]; k < index.outStart[node + 1]; k++)
        neighbours.add(index.to[index.outEdges[k]]);
      for (let k = index.inStart[node]; k < index.inStart[node + 1]; k++)
        neighbours.add(index.from[index.inEdges[k]]);
      d = degrees[node] = neighbours.size;
    }
    return d;
  };
  const turnProfile = toCompiled(request.profile);
  const reachability = new Map<number, Uint8Array>();
  const canReach = targets.map((target, leg) => {
    if (leg === 0) return new Uint8Array(0);
    const cached = reachability.get(target);
    if (cached) return cached;
    const seen = new Uint8Array(nodeCount),
      queue = new Int32Array(nodeCount);
    seen[target] = 1;
    queue[0] = target;
    let tail = 1;
    for (let i = 0; i < tail; i++)
      for (let k = index.inStart[queue[i]]; k < index.inStart[queue[i] + 1]; k++) {
        const origin = index.from[index.inEdges[k]];
        if (seen[origin]) continue;
        seen[origin] = 1;
        queue[tail++] = origin;
      }
    reachability.set(target, seen);
    return seen;
  });
  for (let leg = 1; leg < targets.length; leg++) {
    if (!canReach[leg][targets[leg - 1]]) {
      result.failedLeg = leg;
      return finish();
    }
  }
  const f =
    mode === "corridor"
      ? (providedField ??
        buildField(
          {
            schemaVersion: 1,
            bbox: graph.bbox,
            nodes: [
              ...nodesOf(graph),
              ...extraNodes,
            ],
            edges: Array.from(refs, (_, s) => edgeAt(s)),
            restrictions: graph.restrictions,
          },
          { ...request, anchors: snap.points },
        ))
      : undefined;
  if (f) result.corridor = f.paths.map((p) => p.map((id) => center(f, id)));
  const { byWay: rulesByWay, nextHistory } = compileRestrictions(
    graph.restrictions,
  );
  const tiles = new Set<number>();
  // The corridor used to be a fixed [2, 5, 12] ladder that only widened when the search
  // failed, never because a better line lay just outside it — a second, independent
  // reason routes came out direct. It now opens as wide as the rider asked to wander,
  // and still falls back to the whole graph so no setting can cause a failure.
  const corridor = toCompiled(request.profile).detour.corridor_cells;
  const cost_ = costCache(request.profile, request.attraction);
  // What the search needs of an edge beyond its ends, filled the first time it is priced
  // and kept as numbers: the cost, whether and which ferry it is, and the three points a
  // turn onto or off it is measured with.
  const strength = turnStrength(turnProfile);
  const priced = new Float64Array(searchCount).fill(NaN),
    ferry = new Int32Array(searchCount),
    turnPoints = strength < 0 ? new Float64Array(searchCount * 6) : undefined;
  const ferries = new Map<string, number>();
  const costOf = (s: number) => {
    let c = priced[s];
    if (Number.isNaN(c)) {
      const edge = edgeAt(s);
      c = priced[s] = total(scoreEdge(edge, turnProfile, request.attraction));
      if (isFerry(edge)) {
        const key = edge.ferryService ?? edge.way;
        let id = ferries.get(key);
        if (id === undefined) ferries.set(key, (id = ferries.size));
        ferry[s] = id;
      } else ferry[s] = -1;
      if (turnPoints) {
        const g = edge.geometry,
          a = g.at(-2)!,
          b = g.at(-1)!,
          c2 = g[1] ?? g.at(-1)!;
        turnPoints.set([a[0], a[1], b[0], b[1], c2[0], c2[1]], s * 6);
      }
    }
    return c;
  };
  const boarding = turnProfile.permissions.ferry
    ? ENGINE.ferry_boarding_meters
    : 0;
  const radii = f
    ? fixedRadius !== undefined
      ? [fixedRadius]
      : [corridor, corridor * 2.5, Infinity]
    : [Infinity];
  const {
    estimate,
    scale: heuristicScale,
    preparedStates,
  } = buildHeuristic(
    index,
    { nodes: targets, points: snap.points },
    request,
    costOf,
    spans,
  );
  result.metrics.heuristicScale = +heuristicScale.toFixed(6);
  if (preparedStates !== undefined)
    result.metrics.preparedStates = preparedStates;
  // Histories by content, so two equal ones reached by different paths are one state.
  const histories: string[][] = [],
    historyIds = new Map<string, number>();
  const historyId = (history: string[]) => {
    const key = history.join(",");
    let id = historyIds.get(key);
    if (id === undefined) {
      id = histories.length;
      histories.push(history);
      historyIds.set(key, id);
    }
    return id;
  };
  for (const radius of radii) {
    const allowed =
      f && Number.isFinite(radius) ? corridorCells(f, radius) : undefined;
    const q = new Heap<number>(),
      states = new SearchStates(nodeCount, targets.length);
    const initial = states.add(targets[0], 1, historyId([]), -1);
    states.cost[initial] = 0;
    q.push(estimate(targets[0], 1), initial);
    let final: number | undefined;
    while (q.size) {
      const item = q.pop()!;
      const id = item.value,
        node = states.node[id];
      const settledCost = states.cost[id];
      if (item.key !== settledCost + estimate(node, states.leg[id])) continue;
      if (
        ++result.metrics.explored + (result.metrics.preparedStates ?? 0) >
        (request.maxSettled ?? 1500000)
      ) {
        result.status = "budget-exceeded";
        result.metrics.tiles = tiles.size;
        return finish();
      }
      let leg = states.leg[id];
      while (leg < targets.length && node === targets[leg]) leg++;
      if (leg === targets.length) {
        final = id;
        break;
      }
      const history = histories[states.history[id]],
        arrived = states.edge[id];
      const rules = rulesByWay.get(history.at(-1) ?? "") ?? [];
      for (let k = index.outStart[node]; k < index.outStart[node + 1]; k++) {
        const e = index.outEdges[k],
          to = index.to[e];
        if (!canReach[leg][to]) continue;
        if (
          allowed &&
          f &&
          !edgeAt(e).geometry.every((p) => allowed.has(cell(f, p)))
        )
          continue;
        const way = wayOf(e);
        if (
          rules.length &&
          !restrictionAllowsBy(
            rules,
            history,
            nodeIds[node],
            way,
            nodeIds[to],
            arrived === -1 ? undefined : nodeIds[index.from[arrived]],
          )
        )
          continue;
        tiles.add(tileOf(e));
        const edgeCost = costOf(e);
        let turn = 0;
        if (
          turnPoints &&
          arrived !== -1 &&
          degree(node) >= 3 &&
          ferry[arrived] === -1 &&
          ferry[e] === -1
        ) {
          const a = arrived * 6,
            c = e * 6;
          turn = turnAngleCost(
            turnPoints[a],
            turnPoints[a + 1],
            turnPoints[a + 2],
            turnPoints[a + 3],
            turnPoints[c + 4],
            turnPoints[c + 5],
            strength,
          );
        }
        const nextHistoryId = historyId(nextHistory(history, way)),
          newCost =
            settledCost +
            edgeCost +
            // Turn and ferry-boarding charges need the edge arrived on. The state key
            // carries that edge's *departure* node, not its identity, so two parallel
            // edges between the same pair of nodes — a service road beside a street, a
            // split carriageway — share one state and only the cheaper survives. A turn at
            // such a junction can therefore be priced against the wrong one of the two.
            // Deliberate: widening the key with the edge id multiplies the state space
            // everywhere to fix a difference of a few metres at a handful of junctions.
            turn +
            (ferry[e] === -1 || (arrived !== -1 && ferry[arrived] === ferry[e])
              ? 0
              : boarding);
        let next = states.find(to, leg, nextHistoryId, node);
        if (newCost < (next < 0 ? Infinity : states.cost[next])) {
          if (next < 0) next = states.add(to, leg, nextHistoryId, node);
          states.cost[next] = newCost;
          states.previous[next] = id;
          states.edge[next] = e;
          q.push(newCost + estimate(to, leg), next);
        }
      }
    }
    if (final !== undefined) {
      const path: number[] = [];
      for (let k = final; k !== -1; k = states.previous[k])
        if (states.edge[k] !== -1) path.push(states.edge[k]);
      path.reverse();
      const edges = path.map(edgeAt);
      let ascent = 0,
        descent = 0,
        completeElevation = true;
      let previousEdge: Edge | undefined;
      for (const [step, edge] of edges.entries()) {
        const start = elevation[from[path[step]]];
        let height = Number.isNaN(start) ? null : start;
        let meters = result.distanceM;
        result.elevationProfile.push([meters, edge.grades ? height : null]);
        if (edge.grades && height !== null) {
          for (const [length, grade] of edge.grades) {
            meters += length;
            height += length * grade;
            result.elevationProfile.push([meters, height]);
          }
        } else result.elevationProfile.push([meters + edge.length, null]);
        result.edgeIds.push(edge.id);
        // The first vertex of every edge after the first repeats the previous edge's
        // last vertex, so segment indices are taken before the geometry grows.
        const base = result.geometry.length ? result.geometry.length - 1 : 0;
        result.geometry.push(
          ...(result.geometry.length ? edge.geometry.slice(1) : edge.geometry),
        );
        appendSegments(result, edge, request.profile, base);
        result.distanceM += edge.length;
        if (isFerry(edge)) result.ferryM += edge.length;
        result.hikeABikeM += traversalSegments(edge, request.profile)
          .filter((s) => s.mode === "walk")
          .reduce((sum, s) => sum + s.length, 0);
        const c = { ...cost_(edge) };
        c.junction += turnCost(
          previousEdge,
          edge,
          turnProfile,
          degree(from[path[step]]),
        );
        c.ferry += ferryBoardingCost(edge, previousEdge, request.profile);
        previousEdge = edge;
        for (const k of Object.keys(c) as (keyof Components)[])
          result.components[k] += c[k];
        result.surfaceM[edge.surface] =
          (result.surfaceM[edge.surface] ?? 0) + edge.length;
        if (edge.uncertainty > 0.5) result.uncertainM += edge.length;
        if (isFerry(edge)) continue;
        if (!edge.grades) completeElevation = false;
        else
          for (const [length, grade] of edge.grades) {
            if (grade > 0) ascent += length * grade;
            else descent -= length * grade;
          }
      }
      if (!result.geometry.length)
        result.geometry = [snap.points[0], snap.points[0]];
      result.ascentM = completeElevation ? ascent : null;
      result.descentM = completeElevation ? descent : null;
      result.cost = total(result.components);
      result.status = "ok";
      result.metrics.tiles = tiles.size;
      return finish();
    }
    if (radius !== radii.at(-1)) result.metrics.expansions++;
  }
  return finish();
}
