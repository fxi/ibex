/**
 * The three passes that look global but are not.
 *
 * Each has a bounded radius — utility 1 km, junction node-local, reward 600·ln(50) ≈
 * 2,347 m — which is why a cell can be built on its own: run over the cell plus a 5 km halo,
 * every one of them sees every neighbour that could influence an edge the cell owns, so the
 * answer equals a whole-region run. The halo is trimmed only afterwards.
 *
 * Ported from `scripts/build_region.py:418-544`.
 */
import { Heap } from "../routing/heap";
import { roundTo } from "./round";
import type { Surface } from "./surface";
import type { Point } from "../routing/types";

/** What each pass needs of an edge; the builder's own edge record is a superset. */
export type PassEdge = {
  way: string;
  from: number;
  to: number;
  length: number;
  stress: number;
  highway: string;
  quality: number;
  forest: number;
  geometry: Point[];
};

/** Below this an edge counts as low-stress network worth being near. */
const LOW_STRESS = 0.4;
const UTILITY_RADIUS_M = 1000;
/** Reach is compressed logarithmically; 15 km of nearby lanes is as good as it gets. */
const UTILITY_SATURATION_M = 15000;

/**
 * How much low-stress network a node sits in: reachable low-stress length within 1 km.
 *
 * A bounded Dijkstra per node. The same physical segment counts once however many
 * directions it carries, so a two-way lane is not worth twice a one-way one.
 */
export function networkUtility(
  edges: readonly PassEdge[],
  nodeIds: Iterable<number>,
): Map<number, number> {
  /** What the search reads of an edge, with the physical segment reduced to a dense id. */
  type Step = { to: number; length: number; segment: number };
  const adjacency = new Map<number, Step[]>();
  const segments = new Map<string, number>();
  for (const edge of edges) {
    if (edge.stress >= LOW_STRESS || edge.highway === "steps" || edge.highway === "ferry")
      continue;
    // Keyed on the segment, not the directed edge, so both directions count once.
    const low = edge.from < edge.to ? edge.from : edge.to;
    const high = edge.from < edge.to ? edge.to : edge.from;
    const key = `${edge.way},${low},${high}`;
    let segment = segments.get(key);
    if (segment === undefined) {
      segment = segments.size;
      segments.set(key, segment);
    }
    const step = { to: edge.to, length: edge.length, segment };
    const list = adjacency.get(edge.from);
    if (list) list.push(step);
    else adjacency.set(edge.from, [step]);
  }

  // One stamp per segment, compared against the origin's turn, replaces a Set of template
  // strings rebuilt for every edge the search touched: 4.6 s of a 12 s z9 build was here.
  // Segments keep their insertion order in `adjacency`, so `reach` accumulates in the same
  // order as before and sums to the same float.
  const stamp = new Int32Array(segments.size).fill(-1);
  const utility = new Map<number, number>();
  const saturation = Math.log1p(UTILITY_SATURATION_M);
  let turn = 0;
  for (const origin of nodeIds) {
    const visit = turn++;
    const queue = new Heap<number>();
    queue.push(0, origin);
    const best = new Map<number, number>([[origin, 0]]);
    let reach = 0;
    for (let top = queue.pop(); top; top = queue.pop()) {
      const { key: cost, value: node } = top;
      if (cost !== best.get(node)) continue;
      for (const step of adjacency.get(node) ?? []) {
        if (stamp[step.segment] !== visit) {
          reach += Math.min(step.length, UTILITY_RADIUS_M - cost);
          stamp[step.segment] = visit;
        }
        const next = cost + step.length;
        if (next <= UTILITY_RADIUS_M && next < (best.get(step.to) ?? Infinity)) {
          best.set(step.to, next);
          queue.push(next, step.to);
        }
      }
    }
    utility.set(origin, roundTo(Math.min(1, Math.log1p(reach) / saturation), 3));
  }
  return utility;
}

/** How busy the roads meeting at a node are, by class. */
const JUNCTION_CLASS_WEIGHT: Record<string, number> = {
  primary: 1.0,
  primary_link: 1.0,
  secondary: 0.7,
  secondary_link: 0.7,
  tertiary: 0.4,
  tertiary_link: 0.4,
  unclassified: 0.25,
  residential: 0.15,
  living_street: 0.05,
  service: 0.05,
  cycleway: 0.0,
};
const JUNCTION_DEFAULT_WEIGHT = 0.1;

/**
 * How hard the junction at each node is: how many ways converge, on what road class.
 *
 * Scored at the node, so both directions of an edge arriving there agree.
 */
export function junctionSeverity(
  edges: readonly PassEdge[],
  nodeIds: Iterable<number>,
): Map<number, number> {
  const degree = new Map<number, number>();
  const maxClass = new Map<number, number>();
  for (const edge of edges) {
    const weight = JUNCTION_CLASS_WEIGHT[edge.highway] ?? JUNCTION_DEFAULT_WEIGHT;
    for (const node of [edge.from, edge.to]) {
      degree.set(node, (degree.get(node) ?? 0) + 1);
      maxClass.set(node, Math.max(maxClass.get(node) ?? 0, weight));
    }
  }
  const severity = new Map<number, number>();
  for (const node of nodeIds) {
    const crowding = Math.min(1, Math.max(0, (degree.get(node) ?? 0) / 2 - 1) / 3);
    severity.set(node, roundTo(Math.min(1, (maxClass.get(node) ?? 0) * crowding), 3));
  }
  return severity;
}

const REWARD_TAU = 600.0;
const REWARD_FLOOR = 0.02;
const REWARD_HORIZON = REWARD_TAU * Math.log(1 / REWARD_FLOOR);
const QUALITY_SOURCE_THRESHOLD = 0.7;
const FOREST_SOURCE_THRESHOLD = 0.6;
const SOURCE_STRENGTH = { quality: 0.7, forest: 0.5 };

/**
 * How close each node is to something worth riding to, decayed by distance.
 *
 * A reverse multi-source Dijkstra from every attractor — an amenity cluster, forest, golden
 * gravel — seeded at both ends of the attractor edge and propagated over the *reversed*
 * graph, so it measures riding the direction actually allowed. That is what lets the cost of
 * a hard section be discounted when the reward follows soon after.
 */
export function rewardPotential(
  edges: readonly PassEdge[],
  attraction: Surface | undefined,
): Map<number, number> {
  const sourceStrength = (edge: PassEdge) => {
    let strength = attraction ? attraction.sampleMax(edge.geometry) : 0;
    if (edge.quality >= QUALITY_SOURCE_THRESHOLD)
      strength = Math.max(strength, SOURCE_STRENGTH.quality);
    if (edge.forest >= FOREST_SOURCE_THRESHOLD)
      strength = Math.max(strength, SOURCE_STRENGTH.forest);
    return strength;
  };

  const reverse = new Map<number, [number, number][]>();
  for (const edge of edges) {
    const list = reverse.get(edge.to);
    if (list) list.push([edge.from, edge.length]);
    else reverse.set(edge.to, [[edge.from, edge.length]]);
  }

  const best = new Map<number, number>();
  const queue = new Heap<number>();
  for (const edge of edges) {
    const strength = sourceStrength(edge);
    if (strength <= 0) continue;
    // A stronger source starts closer, so its reward reaches further before it decays.
    const start = -REWARD_TAU * Math.log(strength);
    for (const node of [edge.from, edge.to])
      if (start < (best.get(node) ?? Infinity)) {
        best.set(node, start);
        queue.push(start, node);
      }
  }

  for (let top = queue.pop(); top; top = queue.pop()) {
    const { key: d, value: node } = top;
    if (d !== best.get(node) || d > REWARD_HORIZON) continue;
    for (const [neighbour, length] of reverse.get(node) ?? []) {
      const next = d + length;
      if (next <= REWARD_HORIZON && next < (best.get(neighbour) ?? Infinity)) {
        best.set(neighbour, next);
        queue.push(next, neighbour);
      }
    }
  }

  const reward = new Map<number, number>();
  for (const [node, d] of best)
    if (d <= REWARD_HORIZON) reward.set(node, roundTo(Math.exp(-d / REWARD_TAU), 3));
  return reward;
}
