import { buildHeuristic } from "./heuristic";
import { buildAdjacency } from "./adjacency";
import { compileRestrictions, restrictionAllows } from "./restrictions";
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
  effectiveStress,
  emptyComponents,
  HARD_TERMS,
  scoreEdge,
  total,
  trafficHazard,
  turnCost,
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
import type {
  Components,
  Edge,
  Field,
  Graph,
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
  effectiveStress,
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
): { graph: Graph; nodes: number[]; points: Point[] } | null {
  const nodes = [...graph.nodes],
    edges = [...graph.edges];
  const snapped: number[] = [],
    points: Point[] = [];
  let nextNode = 0;
  for (const n of nodes) nextNode = Math.max(nextNode, n.id);
  nextNode++;
  let nextEdge = edges.reduce((m, e) => Math.max(m, e.id), 0) + 1;
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
type SearchState = {
  node: number;
  history: string[];
  leg: number;
  edge?: Edge;
  previous?: string;
};
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
      // stress is a road-class proxy: more digits would be noise in every stored route.
      stress: Math.round(effectiveStress(edge) * 100) / 100,
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

export function route(
  graph: Graph,
  request: RouteRequest,
  mode: "reference" | "corridor",
  providedField?: Field,
  fixedRadius?: number,
): RouteResult {
  request = { ...request, profile: toCompiled(request.profile) };
  validateProfileData(graph);
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
  graph = {
    ...graph,
    edges: graph.edges.filter((edge) => eligible(edge, request.profile)),
  };
  const snap = snapAnchors(graph, request.anchors);
  if (!snap) {
    result.status = "snap-failed";
    return finish();
  }
  graph = snap.graph;
  result.anchors = snap.points;
  const { adjacency, reverse } = buildAdjacency(graph.edges);
  // Distinct neighbours of a node, for `turnCost`: three or more is a real intersection.
  const degrees = new Map<number, number>();
  const degree = (node: number) => {
    let d = degrees.get(node);
    if (d === undefined) {
      d = new Set([
        ...(adjacency.get(node) ?? []).map((e) => e.to),
        ...(reverse.get(node) ?? []).map((e) => e.from),
      ]).size;
      degrees.set(node, d);
    }
    return d;
  };
  const turnProfile = toCompiled(request.profile);
  const reachability = new Map<number, Set<number>>();
  const canReach = snap.nodes.map((target, leg) => {
    if (leg === 0) return new Set<number>();
    const cached = reachability.get(target);
    if (cached) return cached;
    const seen = new Set([target]),
      queue = [target];
    for (let i = 0; i < queue.length; i++) {
      for (const edge of reverse.get(queue[i]) ?? []) {
        const origin = edge.from;
        if (seen.has(origin)) continue;
        seen.add(origin);
        queue.push(origin);
      }
    }
    reachability.set(target, seen);
    return seen;
  });
  for (let leg = 1; leg < snap.nodes.length; leg++) {
    if (!canReach[leg].has(snap.nodes[leg - 1])) {
      result.failedLeg = leg;
      return finish();
    }
  }
  const f =
    mode === "corridor"
      ? (providedField ??
        buildField(graph, { ...request, anchors: snap.points }))
      : undefined;
  if (f) result.corridor = f.paths.map((p) => p.map((id) => center(f, id)));
  const { byWay: rulesByWay, nextHistory } = compileRestrictions(
    graph.restrictions,
  );
  const tiles = new Set<string>();
  // The corridor used to be a fixed [2, 5, 12] ladder that only widened when the search
  // failed, never because a better line lay just outside it — a second, independent
  // reason routes came out direct. It now opens as wide as the rider asked to wander,
  // and still falls back to the whole graph so no setting can cause a failure.
  const corridor = toCompiled(request.profile).detour.corridor_cells;
  const cost_ = costCache(request.profile, request.attraction);
  const radii = f
    ? fixedRadius !== undefined
      ? [fixedRadius]
      : [corridor, corridor * 2.5, Infinity]
    : [Infinity];
  const { estimate, scale: heuristicScale, preparedStates } = buildHeuristic(
    graph,
    snap,
    request,
    reverse,
    cost_,
  );
  result.metrics.heuristicScale = +heuristicScale.toFixed(6);
  if (preparedStates !== undefined)
    result.metrics.preparedStates = preparedStates;
  for (const radius of radii) {
    const allowed =
      f && Number.isFinite(radius) ? corridorCells(f, radius) : undefined;
    const q = new Heap<string>(),
      cost = new Map<string, number>(),
      states = new Map<string, SearchState>();
    const keyOf = (s: SearchState) =>
      `${s.node}|${s.leg}|${s.history.join(",")}|${s.edge?.from ?? ""}`;
    const initial: SearchState = { node: snap.nodes[0], history: [], leg: 1 };
    const key = keyOf(initial);
    states.set(key, initial);
    cost.set(key, 0);
    q.push(estimate(initial.node, initial.leg), key);
    let final: string | undefined;
    while (q.size) {
      const item = q.pop()!;
      const state = states.get(item.value)!;
      const settledCost = cost.get(item.value)!;
      if (item.key !== settledCost + estimate(state.node, state.leg)) continue;
      if (
        ++result.metrics.explored + (result.metrics.preparedStates ?? 0) >
        (request.maxSettled ?? 1500000)
      ) {
        result.status = "budget-exceeded";
        result.metrics.tiles = tiles.size;
        return finish();
      }
      let leg = state.leg;
      while (leg < snap.nodes.length && state.node === snap.nodes[leg]) leg++;
      if (leg === snap.nodes.length) {
        final = item.value;
        break;
      }
      for (const edge of adjacency.get(state.node) || []) {
        if (!canReach[leg].has(edge.to)) continue;
        if (
          allowed &&
          f &&
          !edge.geometry.every((p) => allowed.has(cell(f, p)))
        )
          continue;
        if (
          !restrictionAllows(
            rulesByWay.get(state.history.at(-1) ?? "") ?? [],
            state.history,
            state.node,
            edge,
            state.edge,
          )
        )
          continue;
        tiles.add(edge.tile);
        const history = nextHistory(state.history, edge.way);
        const next: SearchState = {
          node: edge.to,
          history,
          leg,
          edge,
          previous: item.value,
        };
        const nextKey = keyOf(next),
          newCost =
            settledCost +
            total(cost_(edge)) +
            // Turn and ferry-boarding charges need the edge arrived on. The state key
            // carries that edge's *departure* node, not its identity, so two parallel
            // edges between the same pair of nodes — a service road beside a street, a
            // split carriageway — share one state and only the cheaper survives. A turn at
            // such a junction can therefore be priced against the wrong one of the two.
            // Deliberate: widening the key with the edge id multiplies the state space
            // everywhere to fix a difference of a few metres at a handful of junctions.
            turnCost(state.edge, edge, turnProfile, degree(state.node)) +
            ferryBoardingCost(edge, state.edge, request.profile);
        if (newCost < (cost.get(nextKey) ?? Infinity)) {
          cost.set(nextKey, newCost);
          states.set(nextKey, next);
          q.push(newCost + estimate(next.node, next.leg), nextKey);
        }
      }
    }
    if (final !== undefined) {
      const edges: Edge[] = [];
      for (let k: string | undefined = final; k;) {
        const state: SearchState = states.get(k)!;
        if (state.edge) edges.push(state.edge);
        k = state.previous;
      }
      edges.reverse();
      let ascent = 0,
        descent = 0,
        completeElevation = true;
      const elevations = new Map(graph.nodes.map((n) => [n.id, n.elevation]));
      let previousEdge: Edge | undefined;
      for (const edge of edges) {
        let height = elevations.get(edge.from) ?? null;
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
          degree(edge.from),
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
