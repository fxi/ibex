import {
  resolveProfile,
  type ProfileInput,
  type ResolvedProfile,
} from "./profiles";
import {
  eligible,
  isStreet,
  isPaved,
  isFerry,
  rideClass,
  traversalSegments,
} from "./eligibility";
import type {
  Attraction,
  Components,
  Edge,
  Field,
  Graph,
  Point,
  RouteRequest,
  RouteResult,
} from "./types";

export const emptyComponents = (): Components => ({
  distance: 0,
  stress: 0,
  slope: 0,
  surface: 0,
  uncertainty: 0,
  network: 0,
  attraction: 0,
  reward: 0,
  junction: 0,
  climbing: 0,
  offroad: 0,
  walking: 0,
  countryside: 0,
  cycling_network: 0,
  ferry: 0,
});
export function distance(a: Point, b: Point): number {
  const r = Math.PI / 180;
  return (
    6371000 *
    Math.hypot(
      (a[0] - b[0]) * r * Math.cos(((a[1] + b[1]) * r) / 2),
      (a[1] - b[1]) * r,
    )
  );
}
export class Heap<T> {
  private a: { key: number; value: T }[] = [];
  get size() {
    return this.a.length;
  }
  push(key: number, value: T) {
    const a = this.a;
    let i = a.length;
    a.push({ key, value });
    while (i) {
      const p = (i - 1) >> 1;
      if (a[p].key <= key) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = { key, value };
  }
  pop() {
    const a = this.a;
    if (!a.length) return undefined;
    const result = a[0],
      last = a.pop()!;
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1;
        if (c + 1 < a.length && a[c + 1].key < a[c].key) c++;
        if (a[c].key >= last.key) break;
        a[i] = a[c];
        i = c;
      }
      a[i] = last;
    }
    return result;
  }
}

function technicalFactor(
  edge: Edge,
  grade: number,
  w: ResolvedProfile["costs"],
): number {
  const tags = edge.tags;
  if (!tags || !w.technical) return 0;
  const scale = Number.parseFloat(
    (grade > 0 ? tags["mtb:scale:uphill"] : tags["mtb:scale:downhill"]) ??
      tags["mtb:scale"] ??
      "0",
  );
  if (!(scale > 0)) return 0;
  return grade > 0
    ? w.technical * w.technical_up * scale ** 3
    : w.technical * w.technical_down * scale ** 1.5;
}
export function scoreEdge(
  edge: Edge,
  profile: ProfileInput,
  attraction?: Attraction,
): Components {
  const p = resolveProfile(profile),
    w = p.costs,
    l = edge.length;
  const rough =
    (
      {
        paved: 0,
        asphalt: 0,
        concrete: 0,
        compacted: 0.15,
        fine_gravel: 0.25,
        gravel: 0.6,
        unpaved: 0.7,
        ground: 0.9,
        dirt: 1,
        grass: 1.1,
        sand: 2,
        mud: 2,
        rock: 2,
        cobblestone: 0.6,
      } as Record<string, number>
    )[edge.surface] ?? (isStreet(edge) ? 0.15 : 0.8);
  if (isFerry(edge)) {
    const c = emptyComponents();
    c.distance = l;
    c.ferry =
      edge.ferrySeconds === undefined
        ? l * w.ferry_factor
        : edge.ferrySeconds * w.ferry_second_meters;
    c.uncertainty = l * edge.uncertainty * w.uncertainty;
    return c;
  }
  const segments = traversalSegments(edge, p);
  const segmentSlopes = segments.map(({ length: meters, grade, mode }) => {
    if (mode === "walk") return 0;
    if (grade === null) return meters * w.slope * (isStreet(edge) ? 0.5 : 4);
    const technical = technicalFactor(edge, grade, w);
    const factor = grade > 0 || technical > 0 ? 1 : w.downhill_factor;
    const excess =
      grade > 0 ? grade : Math.max(0, -grade - w.downhill_free_grade);
    return (
      meters * (excess / w.slope_reference_grade) ** 4 * w.slope * factor +
      meters * technical
    );
  });
  const slope = segmentSlopes.reduce((sum, cost) => sum + cost, 0);
  const c: Components = {
    distance: l,
    stress: ((l * edge.stress * p.attraction.quiet) / 100) * w.quiet_factor,
    slope,
    surface: l * rough * w.surface,
    uncertainty: l * edge.uncertainty * w.uncertainty,
    network: l * (1 - edge.utility) * w.graph_utility,
    attraction: 0,
    reward: 0,
    climbing: 0,
    offroad: 0,
    walking: 0,
    countryside:
      ((l * (edge.urban ?? 0) * p.attraction.countryside) / 100) *
      w.countryside_factor,
    cycling_network:
      ((l * (1 - (edge.cyclingNetwork ?? 0)) * p.attraction.cycling_network) /
        100) *
      w.cycling_network_factor,
    ferry: 0,
    junction: (edge.junction ?? 0) * w.junction * w.junction_meters,
  };
  // Discounts only the hardship components, never distance/network/uncertainty: a
  // detour still costs distance, only its difficulty becomes cheap when something
  // rewarding (viewpoint, forest, golden gravel) is reachable soon after.
  c.reward =
    (-(c.stress + c.slope + c.surface) *
      Math.min(w.scenic_discount, Math.max(0, edge.reward ?? 0)) *
      p.attraction.scenic) /
    100;
  // Price each grade segment independently so waypoint splitting preserves cost.
  // Walking effort and junction events do not receive riding discounts.
  const segmentLength = segments.reduce((sum, s) => sum + s.length, 0);
  const scenicFactor =
    (Math.min(w.scenic_discount, Math.max(0, edge.reward ?? 0)) *
      p.attraction.scenic) /
    100;
  for (const [index, segment] of segments.entries()) {
    if (segment.mode === "walk") {
      c.walking +=
        segment.length *
        (edge.highway === "steps" ? w.steps_factor : w.walking_factor);
      continue;
    }
    if (segment.mode !== "ride") continue;
    const fraction = segment.length / segmentLength;
    const hardship = fraction * (c.stress + c.surface) + segmentSlopes[index];
    const base =
      fraction *
        (c.distance +
          c.stress +
          c.surface +
          c.uncertainty +
          c.network +
          c.countryside +
          c.cycling_network) +
      segmentSlopes[index] -
      hardship * scenicFactor;
    const grade = segment.grade;
    const climb =
      grade !== null && grade > 0
        ? ((-base * w.climbing_discount * p.attraction.climbing) / 100) *
          Math.min(1, grade / w.slope_reference_grade)
        : 0;
    c.climbing += climb;
    if (!isPaved(edge) && edge.surface !== "unknown") {
      const preference =
        grade === null || grade === 0
          ? (p.attraction.offroad_up + p.attraction.offroad_down) / 2
          : grade > 0
            ? p.attraction.offroad_up
            : p.attraction.offroad_down;
      c.offroad -= ((base + climb) * w.offroad_discount * preference) / 100;
    }
  }
  if (attraction) {
    const mid = edge.geometry[Math.floor(edge.geometry.length / 2)];
    const influence = Math.max(
      0,
      1 - distance(mid, attraction.point) / Math.max(1, attraction.radiusM),
    );
    c.attraction =
      -total(c) * Math.min(0.65, Math.max(0, attraction.strength)) * influence;
  }
  return c;
}
export const total = (c: Components) =>
  Object.values(c).reduce((a, b) => a + b, 0);
export function pointInBounds(p: Point, b: Graph["bbox"]) {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}

export function project(
  p: Point,
  a: Point,
  b: Point,
): { point: Point; t: number; distance: number } {
  const cos = Math.cos((p[1] * Math.PI) / 180),
    dx = (b[0] - a[0]) * cos,
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p[0] - a[0]) * cos * dx + (p[1] - a[1]) * dy) /
        (dx * dx + dy * dy || 1),
    ),
  );
  const point: Point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  return { point, t, distance: distance(p, point) };
}

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

function validateProfileData(graph: Graph, profile: ResolvedProfile) {
  if (
    (profile.attraction.countryside > 0 ||
      profile.attraction.cycling_network > 0 ||
      profile.access.steps ||
      profile.access.ferry) &&
    graph.edges.some(
      (e) => e.urban === undefined || e.cyclingNetwork === undefined,
    )
  )
    throw new Error(
      "This profile needs updated region data. Save the updated region.",
    );
}
export function ferryBoardingCost(
  edge: Edge,
  previous: Edge | undefined,
  profile: ProfileInput,
): number {
  if (
    !isFerry(edge) ||
    (previous &&
      isFerry(previous) &&
      (edge.ferryService ?? edge.way) ===
        (previous.ferryService ?? previous.way))
  )
    return 0;
  return resolveProfile(profile).costs.ferry_boarding_meters;
}
export function buildField(graph: Graph, request: RouteRequest): Field {
  request = { ...request, profile: resolveProfile(request.profile) };
  validateProfileData(graph, resolveProfile(request.profile));
  const [w, s, e, n] = graph.bbox,
    cellM = 700,
    width = Math.ceil(distance([w, s], [e, s]) / cellM),
    height = Math.ceil(distance([w, s], [w, n]) / cellM);
  const field: Field = {
    width,
    height,
    cellM,
    bbox: graph.bbox,
    costs: Array(width * height).fill(15),
    paths: [],
  };
  for (const edge of graph.edges) {
    if (!eligible(edge, request.profile)) continue;
    const cost =
      total(scoreEdge(edge, request.profile, request.attraction)) / edge.length;
    for (let i = 1; i < edge.geometry.length; i++) {
      const a = edge.geometry[i - 1],
        b = edge.geometry[i],
        steps = Math.max(1, Math.ceil(distance(a, b) / 300));
      for (let j = 0; j <= steps; j++) {
        const t = j / steps,
          id = cell(field, [
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
          ]);
        field.costs[id] = Math.min(field.costs[id], cost);
      }
    }
  }
  for (let i = 1; i < request.anchors.length; i++)
    field.paths.push(
      fieldPath(
        field,
        cell(field, request.anchors[i - 1]),
        cell(field, request.anchors[i]),
      ),
    );
  return field;
}
export function cell(f: Field, p: Point): number {
  const [w, s, e, n] = f.bbox;
  const x = Math.max(
      0,
      Math.min(f.width - 1, Math.floor(((p[0] - w) / (e - w)) * f.width)),
    ),
    y = Math.max(
      0,
      Math.min(f.height - 1, Math.floor(((p[1] - s) / (n - s)) * f.height)),
    );
  return y * f.width + x;
}
export function center(f: Field, id: number): Point {
  const [w, s, e, n] = f.bbox;
  return [
    w + (((id % f.width) + 0.5) / f.width) * (e - w),
    s + ((Math.floor(id / f.width) + 0.5) / f.height) * (n - s),
  ];
}
export function fieldPath(f: Field, start: number, end: number): number[] {
  const q = new Heap<number>(),
    cost = new Float64Array(f.costs.length).fill(Infinity),
    prev = new Int32Array(f.costs.length).fill(-1);
  cost[start] = 0;
  q.push(0, start);
  while (q.size) {
    const { key, value: id } = q.pop()!;
    if (key !== cost[id]) continue;
    if (id === end) break;
    const x = id % f.width,
      y = Math.floor(id / f.width);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (
          (!dx && !dy) ||
          x + dx < 0 ||
          x + dx >= f.width ||
          y + dy < 0 ||
          y + dy >= f.height
        )
          continue;
        const next = (y + dy) * f.width + x + dx,
          newCost =
            key + ((f.costs[id] + f.costs[next]) / 2) * Math.hypot(dx, dy);
        if (newCost < cost[next]) {
          cost[next] = newCost;
          prev[next] = id;
          q.push(newCost, next);
        }
      }
  }
  const path = [];
  for (let id = end; id !== -1; id = prev[id]) path.push(id);
  return path.reverse();
}
export function corridorCells(f: Field, radius: number): Set<number> {
  const allowed = new Set<number>();
  for (const path of f.paths)
    for (const id of path) {
      const x = id % f.width,
        y = Math.floor(id / f.width);
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          if (
            dx * dx + dy * dy > radius * radius ||
            x + dx < 0 ||
            x + dx >= f.width ||
            y + dy < 0 ||
            y + dy >= f.height
          )
            continue;
          allowed.add((y + dy) * f.width + x + dx);
        }
    }
  return allowed;
}

function restrictionAllows(
  rules: Graph["restrictions"],
  history: string[],
  at: number,
  next: Edge,
  previous?: Edge,
): boolean {
  for (const rule of rules) {
    if (rule.via !== undefined && rule.via !== at) continue;
    // Via-way only restrictions constrain every departure in the sequence,
    // not just the final turn. History retains progress across split edges.
    if (rule.only && rule.via === undefined) {
      for (let length = 1; length < rule.ways.length; length++) {
        if (
          history.length < length ||
          !rule.ways
            .slice(0, length)
            .every((way, i) => history[history.length - length + i] === way)
        )
          continue;
        if (next.way !== history.at(-1) && next.way !== rule.ways[length])
          return false;
      }
      continue;
    }
    const prefix = rule.ways.slice(0, -1);
    if (
      history.length < prefix.length ||
      !prefix.every((w, i) => history[history.length - prefix.length + i] === w)
    )
      continue;
    if (rule.via === undefined && next.way === history.at(-1)) continue;
    const matches =
      next.way === rule.ways.at(-1) &&
      (!(
        rule.uTurn &&
        rule.via !== undefined &&
        rule.ways.length === 2 &&
        rule.ways[0] === rule.ways[1]
      ) ||
        previous?.from === next.to);
    if (rule.only ? !matches : matches) return false;
  }
  return true;
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
  profile: ProfileInput,
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
  const scale = geometryLength > 0 && runLength > 0 ? runLength / geometryLength : 1;
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
  let startRun = runAt(spans[0] / 2) ;
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
  request = { ...request, profile: resolveProfile(request.profile) };
  validateProfileData(graph, resolveProfile(request.profile));
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
  const adjacency = new Map<number, Edge[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) || [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }
  const reverse = new Map<number, number[]>();
  for (const edge of graph.edges) {
    const origins = reverse.get(edge.to) ?? [];
    origins.push(edge.from);
    reverse.set(edge.to, origins);
  }
  const reachability = new Map<number, Set<number>>();
  const canReach = snap.nodes.map((target, leg) => {
    if (leg === 0) return new Set<number>();
    const cached = reachability.get(target);
    if (cached) return cached;
    const seen = new Set([target]),
      queue = [target];
    for (let i = 0; i < queue.length; i++) {
      for (const origin of reverse.get(queue[i]) ?? []) {
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
  // Only restriction prefixes affect future legality. Remembering arbitrary
  // previous roads multiplies equivalent search states across the entire region.
  const restrictionPrefixes = new Set<string>();
  let historyLength = 1;
  for (const rule of graph.restrictions) {
    for (let length = 1; length < rule.ways.length; length++)
      restrictionPrefixes.add(JSON.stringify(rule.ways.slice(0, length)));
    historyLength = Math.max(historyLength, rule.ways.length - 1);
  }
  const nextHistory = (previous: string[], way: string): string[] => {
    if (previous.at(-1) === way) return previous;
    const candidate = [...previous, way].slice(-historyLength);
    for (let start = 0; start < candidate.length - 1; start++) {
      const suffix = candidate.slice(start);
      if (restrictionPrefixes.has(JSON.stringify(suffix))) return suffix;
    }
    return [way];
  };
  const tiles = new Set<string>();
  const rulesByWay = new Map<string, Graph["restrictions"]>();
  for (const rule of graph.restrictions) {
    const keys =
      rule.only && rule.via === undefined
        ? rule.ways.slice(0, -1)
        : [rule.ways[rule.ways.length - 2]];
    for (const key of new Set(keys)) {
      const list = rulesByWay.get(key) ?? [];
      list.push(rule);
      rulesByWay.set(key, list);
    }
  }
  const radii = f
    ? fixedRadius !== undefined
      ? [fixedRadius]
      : [2, 5, 12, Infinity]
    : [Infinity];
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
    q.push(0, key);
    let final: string | undefined;
    while (q.size) {
      const item = q.pop()!;
      if (item.key !== cost.get(item.value)) continue;
      const state = states.get(item.value)!;
      if (++result.metrics.explored > (request.maxSettled ?? 1500000)) {
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
            item.key +
            total(scoreEdge(edge, request.profile, request.attraction)) +
            ferryBoardingCost(edge, state.edge, request.profile);
        if (newCost < (cost.get(nextKey) ?? Infinity)) {
          cost.set(nextKey, newCost);
          states.set(nextKey, next);
          q.push(newCost, nextKey);
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
        const c = scoreEdge(edge, request.profile, request.attraction);
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
