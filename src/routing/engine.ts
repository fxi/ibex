import type { Profile } from "./profiles";
import { toCompiled, type CompiledProfile } from "./compile";
import {
  ENGINE,
  NET_SCALE,
  REWARD_SHARE,
  STRENGTH,
  type ScoredKey,
} from "./vocabulary";
import { exceedance } from "./capability";
import { edgeSignals, scenicValue, type Signals } from "./signals";
import {
  climbingTechnical,
  eligible,
  isFerry,
  rideClass,
  traversalSegments,
} from "./eligibility";
import { isStreet } from "./tagging";
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

/** Cost terms that are not a matter of taste, and so sit outside the preference factor. */
export const HARD_TERMS = [
  "slope",
  "technical",
  "roughness",
  "traffic",
  "uncertainty",
  "network",
] as const;
export type HardTerm = (typeof HARD_TERMS)[number];

export const emptyComponents = (): Components => ({
  distanceM: 0,
  base: 0,
  preference: 0,
  slope: 0,
  technical: 0,
  roughness: 0,
  traffic: 0,
  uncertainty: 0,
  network: 0,
  junction: 0,
  walking: 0,
  ferry: 0,
  attraction: 0,
  clamp: 0,
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
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent].key <= a[i].key) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return undefined;
    const result = a[0],
      last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1,
          right = left + 1;
        let smallest = i;
        if (left < a.length && a[left].key < a[smallest].key) smallest = left;
        if (right < a.length && a[right].key < a[smallest].key)
          smallest = right;
        if (smallest === i) break;
        [a[smallest], a[i]] = [a[i], a[smallest]];
        i = smallest;
      }
    }
    return result;
  }
}

/**
 * Where a value sits relative to an ordinary way, from -1 (as low as it goes) through 0
 * (ordinary) to +1 (as high as it goes).
 *
 * The two sides are scaled independently because the reference is rarely in the middle:
 * traffic stress 0.35 is ordinary, so 0 is as quiet as a road gets and 1 is far worse
 * than ordinary, and both deserve to read as a full unit of their kind.
 */
export function deviation(value: number, reference: number): number {
  const d =
    value > reference
      ? (value - reference) / Math.max(1e-6, 1 - reference)
      : (value - reference) / Math.max(1e-6, reference);
  return Math.max(-1, Math.min(1, d));
}

type Rate = { net: number; hard: number; terms: Record<HardTerm, number> };

/**
 * The hazard of riding in traffic busier than a quiet departmental road, for a rider who
 * avoids it. Zero for anyone neutral or keen, and for any way at or below
 * `ENGINE.traffic_from`.
 */
export function trafficHazard(
  stress: number,
  p: CompiledProfile,
  weights: CompiledProfile["weights"] = p.weights,
): number {
  const w = weights.traffic_stress;
  if (w.sign >= 0) return 0;
  const from = ENGINE.traffic_from;
  const excess = Math.max(0, (stress - from) / (1 - from));
  return ENGINE.traffic * Math.abs(STRENGTH[w.level]) * excess * excess;
}

/** Traffic stress as ridden: road class, calmed where a cycle route is signed. */
export function effectiveStress(edge: Edge): number {
  return edge.cyclingNetwork
    ? edge.stress * ENGINE.network_calming
    : edge.stress;
}

/**
 * Unpaved ground, for a rider who strongly avoids it: a road bike on gravel.
 *
 * The preference alone is capped by the detour budget, and compacted gravel sits below a
 * 28 mm tyre's roughness threshold, so neither kept a road route off a gravel shortcut.
 * Like traffic it is charged outside the budget. Still finite, so nothing becomes
 * unreachable. An untagged street is assumed sealed; an untagged track is not.
 */
export function unpavedHazard(
  edge: Edge,
  s: Signals,
  p: CompiledProfile,
  weights: CompiledProfile["weights"] = p.weights,
): number {
  // Directional: `downhill.unpaved: strongly_avoid` has to reach this charge too, or an
  // override could only move the capped preference and never keep a descent off gravel.
  if (weights.unpaved.level !== "strongly_avoid") return 0;
  if (s.surfaceKnown) return ENGINE.unpaved_hazard * s.unpaved;
  return isStreet(edge)
    ? 0
    : ENGINE.unpaved_hazard * ENGINE.unpaved_guess_share * s.unpaved;
}

/**
 * The attention a change of direction takes at an intersection, for a rider who avoids
 * it. Zero going straight, at a node where fewer than three ways meet (a way split, a
 * waypoint, a hairpin inside one way), across a ferry, or for anyone neutral or keen:
 * a negative cost would break the search, so turns are never rewarded.
 */
export function turnCost(
  previous: Edge | undefined,
  edge: Edge,
  p: CompiledProfile,
  degree: number,
): number {
  const strength = STRENGTH[p.directionChanges];
  if (!previous || strength >= 0 || degree < 3) return 0;
  if (isFerry(previous) || isFerry(edge)) return 0;
  const a = previous.geometry.at(-2)!,
    b = previous.geometry.at(-1)!,
    c = edge.geometry[1] ?? edge.geometry.at(-1)!;
  const k = Math.cos((b[1] * Math.PI) / 180);
  const ux = (b[0] - a[0]) * k,
    uy = b[1] - a[1],
    vx = (c[0] - b[0]) * k,
    vy = c[1] - b[1];
  const norm = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (!norm) return 0;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / norm));
  return ENGINE.turn_meters * -strength * ((1 - cos) / 2);
}

/** Physical cycle infrastructure remains distinguishable from signed route membership. */
export function cycleInfrastructure(edge: Edge): number {
  return Math.max(
    edge.cyclingNetwork ?? 0,
    edge.highway === "cycleway" || edge.tags?.bicycle === "designated"
      ? 0.8
      : 0,
  );
}

/**
 * Score one grade run: how well it matches the rider's preferences, and how far past
 * their capability it is.
 */
function riddenRate(
  edge: Edge,
  p: CompiledProfile,
  s: Signals,
  grade: number | null,
): Rate {
  const k = p.capability;
  const down = grade !== null && grade < 0;
  const technical = down
    ? s.technicalDown
    : climbingTechnical(s.technicalUp, grade, k);

  // Past a false flat, the profile's uphill or downhill preferences take over: the same
  // rider can want good gravel on the way up and smooth tarmac, or singletrack, down.
  const weights =
    grade !== null && grade > ENGINE.grade_from
      ? p.uphillWeights
      : grade !== null && grade < -ENGINE.grade_from
        ? p.downhillWeights
        : p.weights;
  const value: Record<ScoredKey, number> = {
    traffic_stress: effectiveStress(edge),
    unpaved: s.unpaved,
    roughness: s.roughness,
    technicality: technical,
    scenic: scenicValue(edge),
    urbanity: edge.urban ?? 0,
    cycle_infrastructure: edge.cyclingNetwork ?? 0,
  };

  // Off the street network, a way whose ground nobody described is a gamble, and the
  // forest around it says nothing about whether it can be ridden. Its defects are
  // charged in full, but its virtues are only partly believed: full scenic credit
  // made a bare `mtb:scale=1` footpath through a wood the cheapest way on a gravel
  // route near Arthaz — and unrideable when ridden.
  const trust = s.surfaceKnown || isStreet(edge) ? 1 : ENGINE.unsurveyed_credit;
  let sum = 0,
    weight = 0;
  for (const key of Object.keys(value) as ScoredKey[]) {
    // Roughness and technicality share one `surface_difficulty` level but combine by
    // direction. Avoiding it, both defects are charged: rough *and* technical is worse
    // than either, and taking only the larger halved the penalty on a gravel bike's
    // `mtb:scale=2` dirt shortcut. Preferring it, either one is the ground asked for, so
    // the further from its own reference is credited — scored separately, a smooth but
    // technical path was charged for being smooth.
    if (key === "technicality" && weights.technicality.sign > 0) continue;
    let w = weights[key];
    if (w.weight === 0) continue;
    let d = deviation(value[key], w.reference);
    if (key === "roughness" && w.sign > 0) {
      const dt = deviation(value.technicality, weights.technicality.reference);
      if (dt > d) {
        d = dt;
        w = weights.technicality;
      }
    }
    // Positive is worse than an ordinary way in the direction this rider cares about,
    // negative is better. A virtue the rider asked for counts in full; merely lacking
    // a defect they avoid is discounted by `REWARD_SHARE`.
    let badness = -w.sign * d;
    // Avoiding difficult ground, a smooth surface is no virtue on a technical path. The
    // reverse is left alone: most gravel carries no technical tag, and withholding that
    // credit would recalibrate every rough track.
    if (
      key === "roughness" &&
      w.sign < 0 &&
      badness <= 0 &&
      deviation(value.technicality, weights.technicality.reference) > 0
    )
      continue;
    // Nor is lacking a technical tag a virtue. Almost no way carries one, so its absence
    // sits a full unit below the reference and, credited, outweighed real roughness:
    // "avoid difficult ground" priced a rough gravel track below "prefer" it.
    if (key === "technicality" && badness <= 0) continue;
    if (key === "unpaved" && !s.surfaceKnown) {
      // Never reward a guess: with no `surface` tag, "unpaved" is read off the road
      // hierarchy and is not evidence of the gravel the rider came for. Nor is silence
      // tarmac, so a rider avoiding unpaved ground pays a share of the likely penalty.
      if (w.sign >= 0 || badness <= 0) continue;
      badness *= ENGINE.unpaved_guess_share;
    }
    sum +=
      w.weight *
      (badness > 0
        ? badness
        : badness * (w.sign > 0 ? 1 : REWARD_SHARE) * trust);
    weight += w.weight;
  }

  const terms: Record<HardTerm, number> = {
    slope:
      grade === null
        ? 0
        : grade > 0
          ? ENGINE.climb_effort * grade * p.climbAversion +
            ENGINE.threshold_rate * exceedance(grade, k.uphill_grade)
          : // A steep descent on a twisty line is worse than a steep straight one, and
            // this is the only place curvature is used.
            ENGINE.threshold_rate *
            exceedance(-grade, k.downhill_grade) *
            (1 + 0.5 * s.curvature),
    technical:
      ENGINE.threshold_rate *
      exceedance(technical, down ? k.technical_down : k.technical_up),
    roughness:
      ENGINE.threshold_rate * exceedance(s.roughness, k.surface_roughness) +
      unpavedHazard(edge, s, p, weights),
    traffic: trafficHazard(effectiveStress(edge), p, weights),
    uncertainty: ENGINE.uncertainty * edge.uncertainty,
    network: ENGINE.off_network * (1 - edge.utility),
  };
  return {
    net: weight > 0 ? sum / weight : 0,
    hard: HARD_TERMS.reduce((total, key) => total + terms[key], 0),
    terms,
  };
}

/**
 * Cost in equivalent metres, at a rate that can fall below 1.
 *
 * The old model charged full distance and then applied capped discounts to the penalty
 * terms only — never to distance itself, as its own comment said. The cheapest possible
 * edge therefore still cost its own length, so a scenic line could never beat a shorter
 * plain one and the router was structurally incapable of detouring however the profile
 * was tuned. Here an edge costs `length x rate`, and a way the rider likes has a rate
 * below 1: it buys distance.
 *
 *     rate = (1 + hard) * budget_ratio ** tanh(net / NET_SCALE)
 *
 * `net` is the weighted mean of how well the edge matches the preferences the rider
 * actually expressed, -1 (ideal) to +1 (exactly wrong), so raising `budget_ratio` to it
 * is what gives `detour` its meaning: at `prefer`, budget 1.5, an ideal edge costs 1/1.5
 * of its length and the router will ride 1.5 km of it rather than 1 km of nothing
 * special. `hard` carries what is not a matter of taste.
 */
/**
 * Cost every edge once per search.
 *
 * `scoreEdge` is called on every relaxation, again for each edge of the finished route,
 * and again for each edge in `buildField`. It reads only the edge and the compiled
 * profile, both immutable for the length of a route, so one pass and a lookup is the
 * same answer for a fraction of the work.
 */
const profileCosts = new WeakMap<CompiledProfile, WeakMap<Edge, Components>>();
export function costCache(
  profile: Profile | CompiledProfile,
  attraction?: Attraction,
) {
  const p = toCompiled(profile);
  // Edge objects survive block reuse; ids alone are unsafe for waypoint splits.
  let cache = !attraction ? profileCosts.get(p) : undefined;
  if (!cache) {
    cache = new WeakMap<Edge, Components>();
    if (!attraction) profileCosts.set(p, cache);
  }
  return (edge: Edge): Components => {
    const hit = cache.get(edge);
    if (hit) return hit;
    const value = scoreEdge(edge, p, attraction);
    cache.set(edge, value);
    return value;
  };
}

export function scoreEdge(
  edge: Edge,
  input: Profile | CompiledProfile,
  attraction?: Attraction,
): Components {
  const p = toCompiled(input);
  const s = edgeSignals(edge);
  const c = emptyComponents();
  const l = edge.length;
  c.distanceM = l;

  if (isFerry(edge)) {
    c.base = l;
    c.ferry =
      edge.ferrySeconds === undefined
        ? l * ENGINE.ferry_meters
        : edge.ferrySeconds * ENGINE.ferry_second_meters;
    c.uncertainty = l * edge.uncertainty * ENGINE.uncertainty;
    return c;
  }

  const segments = traversalSegments(edge, p, s);
  const riddenLength = segments.reduce(
    (sum, seg) => sum + (seg.mode === "ride" ? seg.length : 0),
    0,
  );

  // Price each grade run on its own, so that splitting an edge at a waypoint — which
  // `snapAnchors` does — cannot change what the route costs.
  const terms: Record<HardTerm, number> = {
    slope: 0,
    technical: 0,
    roughness: 0,
    traffic: 0,
    uncertainty: 0,
    network: 0,
  };
  let net = 0;
  for (const seg of segments) {
    if (seg.mode === "ferry") continue;
    const r = riddenRate(edge, p, s, seg.grade);
    const walking = seg.mode === "walk";
    if (walking) {
      const stairs = edge.highway === "steps";
      const permitted = stairs ? p.permissions.stairs : p.permissions.push;
      c.walking +=
        seg.length *
        (stairs
          ? permitted
            ? ENGINE.stairs
            : ENGINE.stairs_refused
          : permitted
            ? ENGINE.push
            : ENGINE.push_refused);
    } else if (riddenLength > 0) {
      net += r.net * (seg.length / riddenLength);
    }
    const share = walking ? ENGINE.walk_hard_share : 1;
    for (const key of HARD_TERMS)
      terms[key] += r.terms[key] * seg.length * share;
  }

  // The preference factor scales the whole perceived cost, climb and push included.
  // Applying it only to the flat reference metre left it with almost no leverage exactly
  // where terrain is interesting: in the mountains the climbing and capability terms
  // dominate, so a rider who said they would happily ride half as far again for a better
  // line got a route barely 3% longer. A rider who loves quiet gravel finds the climb on
  // it more worth doing too, and this says so.
  const preference = p.detour.budget_ratio ** Math.tanh(net / NET_SCALE);
  const raw =
    riddenLength + c.walking + HARD_TERMS.reduce((sum, k) => sum + terms[k], 0);
  c.base = riddenLength;
  c.preference = raw * (preference - 1);
  for (const key of HARD_TERMS) c[key] = terms[key];

  // Nothing is ever unroutable, so the whole edge is capped rather than any one term.
  const priced = raw + c.preference;
  c.clamp = Math.min(priced, l * ENGINE.rate_max) - priced;

  c.junction = (edge.junction ?? 0) * ENGINE.junction_meters;

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

/**
 * The cost of an edge. `distanceM` is a report, not a cost, so it is excluded.
 *
 * Always strictly positive: `base` is the full ridden length, `preference` can subtract
 * at most `1 - 1/budget_ratio` of it, and every other term is non-negative apart from
 * `attraction`, which is capped at 65% of the rest.
 */
export const total = (c: Components) =>
  c.base +
  c.preference +
  c.slope +
  c.technical +
  c.roughness +
  c.traffic +
  c.uncertainty +
  c.network +
  c.junction +
  c.walking +
  c.ferry +
  c.attraction +
  c.clamp;

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

/**
 * Every preference now reads a derived per-edge signal, so a pack built before those
 * signals existed cannot serve any profile rather than only the ones that asked for them.
 */
function validateProfileData(graph: Graph) {
  if (
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
export function buildField(graph: Graph, request: RouteRequest): Field {
  request = { ...request, profile: toCompiled(request.profile) };
  validateProfileData(graph);
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
  const cost_ = costCache(request.profile, request.attraction);
  for (const edge of graph.edges) {
    if (!eligible(edge, request.profile)) continue;
    const cost = total(cost_(edge)) / edge.length;
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
  const adjacency = new Map<number, Edge[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) || [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }
  const reverse = new Map<number, Edge[]>();
  for (const edge of graph.edges) {
    const origins = reverse.get(edge.to) ?? [];
    origins.push(edge);
    reverse.set(edge.to, origins);
  }
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
  // A fixed projection gives a true Euclidean metric. Bound every graph edge against
  // its endpoint chord, including rounded lengths, then apply the minimum cost rate.
  // Unlike the corridor this cannot exclude a better route outside a guessed area.
  const longitudeScale = Math.cos((snap.points[0][1] * Math.PI) / 180);
  const positions = new Map(graph.nodes.map((node) => [node.id, node.p]));
  const chord = (a: Point, b: Point) =>
    ((6371000 * Math.PI) / 180) *
    Math.hypot((a[0] - b[0]) * longitudeScale, a[1] - b[1]);
  let lengthScale = 1;
  if (request.search !== "dijkstra")
    for (const edge of graph.edges) {
      const from = positions.get(edge.from),
        to = positions.get(edge.to);
      if (!from || !to) {
        lengthScale = 0;
        break;
      }
      const d = chord(from, to);
      const gradedLength =
        edge.grades?.reduce((sum, [length]) => sum + length, 0) ?? edge.length;
      if (d > 0)
        lengthScale = Math.min(
          lengthScale,
          Math.min(edge.length, gradedLength) / d,
        );
    }
  const floor =
    Math.min(1, toCompiled(request.profile).detour.rate_floor) *
    (request.attraction ? 0.35 : 1) *
    lengthScale *
    0.999999;
  const remaining = new Float64Array(snap.nodes.length);
  for (let i = snap.nodes.length - 2; i >= 0; i--)
    remaining[i] =
      remaining[i + 1] + chord(snap.points[i], snap.points[i + 1]) * floor;
  const estimates = snap.nodes.map(() => new Map<number, number>());
  // A relaxed node graph ignores turn restrictions and transition charges, so its
  // distances are valid lower bounds for the richer search. Stop at the source; nodes
  // not settled yet are at least as far away as the frontier. This is especially
  // effective where a cheap geometric estimate cannot see a mountain or river barrier.
  const potential = new Map<number, number>();
  let frontier = 0;
  if (
    request.search !== "dijkstra" &&
    snap.nodes.length === 2 &&
    graph.edges.length > 10000
  ) {
    const pending = new Map<number, number>([[snap.nodes[1], 0]]);
    const heap = new Heap<number>();
    heap.push(0, snap.nodes[1]);
    const limit = Math.min(
      100000,
      Math.floor((request.maxSettled ?? 1500000) / 4),
    );
    while (heap.size && potential.size < limit) {
      const item = heap.pop()!;
      if (item.key !== pending.get(item.value) || potential.has(item.value))
        continue;
      potential.set(item.value, item.key);
      frontier = item.key;
      if (item.value === snap.nodes[0]) break;
      for (const edge of reverse.get(item.value) ?? []) {
        const next = item.key + total(cost_(edge));
        if (next < (pending.get(edge.from) ?? Infinity)) {
          pending.set(edge.from, next);
          heap.push(next, edge.from);
        }
      }
    }
    result.metrics.preparedStates = potential.size;
  }
  const estimate = (node: number, leg: number) => {
    if (request.search === "dijkstra" || leg >= snap.nodes.length) return 0;
    const cache = estimates[leg];
    const hit = cache.get(node);
    if (hit !== undefined) return hit;
    const point = positions.get(node);
    const geometric = point
      ? chord(point, snap.points[leg]) * floor + remaining[leg]
      : 0;
    const h = Math.max(geometric, potential.get(node) ?? frontier);
    cache.set(node, h);
    return h;
  };
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
            // The state key carries the arrival node, so the previous edge is known.
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
