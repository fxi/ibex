/**
 * Gold standards: real lines judged the best through their area, and the tool that
 * compares a routed line with one and explains where they part.
 *
 * A case is `tests/fixtures/gold/<name>.json`: the `line`, every `waypoint` it was drawn
 * through in Ibex, and `intent`, the indices of the few waypoints that say where the
 * rider wanted to go. The others were corrections, and a good model needs none of them.
 * `min_shared` is the share of the line the router must already ride from the intent
 * alone: a ratchet, raised as the model improves. Its graph, `<name>-graph.json.gz`, is
 * the corridor around the line (`scripts/gen_graph_fixture.ts gold/<name>`).
 *
 *   node --import tsx scripts/gold_route.ts import <gpx> <name> [profile id] [intent]
 *   node --import tsx scripts/gold_route.ts audit <name> [waypoints] [packs dir]
 *
 * `import` needs a line drawn in Ibex on the current release, so that its vertices are
 * graph vertices; the points that are not are the waypoints. `intent` defaults to the
 * two ends. `audit` routes the case as the app does (`intent`, `all`, or comma-separated
 * waypoint indices) on its fixture, or on a local release when given one, prints the
 * share of the
 * line it rides, and every divergence with what each side costs, term by term, and the
 * ways on both. Turn charges are included: a divergence is often distance traded against
 * changes of direction.
 */
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { distance } from "../src/geo/distance";
import { scoreEdge, total, turnCost } from "../src/routing/engine";
import { compareOn, joinLegs } from "../src/routing/legs";
import { selectedRoute } from "../src/routing/selection";
import { toCompiled } from "../src/routing/compile";
import type { Profile } from "../src/routing/profiles";
import type {
  Components,
  Edge,
  Graph,
  Point,
  RouteResult,
} from "../src/routing/types";

export type Gold = {
  profile: string;
  line: Point[];
  waypoints: Point[];
  intent: number[];
  min_shared: number;
};

export const loadGold = (path: string): Gold =>
  JSON.parse(fs.readFileSync(path, "utf8"));

// Gold lines are drawn on the same graph, so their vertices are graph vertices exactly.
const key = (p: Point) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
const span = (a: Point, b: Point) => [key(a), key(b)].sort().join("|");

export type Divergence = {
  /** Distance along the gold line where the route leaves it. */
  atM: number;
  route: Point[];
  /** The stretch of gold line the route replaced; empty when it does not rejoin. */
  gold: Point[];
};

export type Overlap = {
  routeM: number;
  goldM: number;
  /** Route length that rides the gold line, in either direction. */
  sharedM: number;
  divergences: Divergence[];
};

export function overlap(geometry: Point[], gold: Point[]): Overlap {
  const spans = new Set<string>();
  const index = new Map<string, number>();
  const along: number[] = [0];
  gold.forEach((p, i) => {
    index.set(key(p), i);
    if (i === 0) return;
    spans.add(span(gold[i - 1], p));
    along.push(along[i - 1] + distance(gold[i - 1], p));
  });
  let routeM = 0,
    sharedM = 0;
  const on: boolean[] = [];
  for (let i = 1; i < geometry.length; i++) {
    const d = distance(geometry[i - 1], geometry[i]);
    const shared = spans.has(span(geometry[i - 1], geometry[i]));
    routeM += d;
    if (shared) sharedM += d;
    on.push(shared);
  }
  const divergences: Divergence[] = [];
  for (let i = 0; i < on.length; ) {
    if (on[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < on.length && !on[j]) j++;
    const from = index.get(key(geometry[i]));
    const to = index.get(key(geometry[j]));
    divergences.push({
      atM: from === undefined ? NaN : along[from],
      route: geometry.slice(i, j + 1),
      gold:
        from !== undefined && to !== undefined && to > from
          ? gold.slice(from, to + 1)
          : [],
    });
    i = j;
  }
  return { routeM, goldM: along.at(-1)!, sharedM, divergences };
}

/** The share of a line, by length, whose spans are edges of `graph` as they stand. */
export function onGraph(graph: Graph, line: Point[]): number {
  const spans = new Set<string>();
  for (const e of graph.edges)
    for (let i = 1; i < e.geometry.length; i++)
      spans.add(span(e.geometry[i - 1], e.geometry[i]));
  let found = 0,
    total = 0;
  for (let i = 1; i < line.length; i++) {
    const d = distance(line[i - 1], line[i]);
    total += d;
    if (spans.has(span(line[i - 1], line[i]))) found += d;
  }
  return total > 0 ? found / total : 0;
}

/**
 * What riding a polyline costs, turns included. Spans are matched to the graph's
 * directed edges; one the graph lacks, such as a waypoint's split, costs nothing here.
 */
export function lineCost(graph: Graph, line: Point[], profile: Profile) {
  const bySpan = new Map<string, Edge>();
  for (const e of graph.edges)
    for (let i = 1; i < e.geometry.length; i++)
      bySpan.set(`${key(e.geometry[i - 1])}>${key(e.geometry[i])}`, e);
  const neighbours = new Map<number, Set<number>>();
  for (const e of graph.edges) {
    neighbours.set(e.from, (neighbours.get(e.from) ?? new Set()).add(e.to));
    neighbours.set(e.to, (neighbours.get(e.to) ?? new Set()).add(e.from));
  }
  const compiled = toCompiled(profile);
  const parts: Partial<Record<keyof Components, number>> = {};
  const edges: Edge[] = [];
  let cost = 0;
  for (let i = 1; i < line.length; i++) {
    const e = bySpan.get(`${key(line[i - 1])}>${key(line[i])}`);
    if (!e) continue;
    const share = distance(line[i - 1], line[i]) / e.length;
    const c = scoreEdge(e, compiled);
    cost += total(c) * share;
    for (const [k, v] of Object.entries(c) as [keyof Components, number][])
      if (k !== "distanceM") parts[k] = (parts[k] ?? 0) + v * share;
    const previous = edges.at(-1);
    if (previous !== e) {
      if (previous && previous.to === e.from) {
        const turn = turnCost(
          previous,
          e,
          compiled,
          neighbours.get(e.from)?.size ?? 0,
        );
        cost += turn;
        parts.junction = (parts.junction ?? 0) + turn;
      }
      edges.push(e);
    }
  }
  return { cost, parts, edges };
}

function describe(e: Edge, profile: Profile): string {
  const t = e.tags ?? {};
  const grade = e.grades?.length
    ? `${Math.round(100 * Math.max(...e.grades.map(([, g]) => Math.abs(g))))}%`
    : "?";
  const facts = [
    e.highway,
    e.surface,
    t.tracktype,
    t.smoothness,
    t["mtb:scale"] && `mtb${t["mtb:scale"]}`,
    t.sac_scale,
  ].filter(Boolean);
  const rate = total(scoreEdge(e, profile)) / e.length;
  return `${e.way} ${facts.join("/")} ${Math.round(e.length)}m ${grade} rate ${rate.toFixed(2)}${e.name ? ` «${e.name}»` : ""}`;
}

export const goldPath = (name: string) => `tests/fixtures/gold/${name}.json`;
export const goldGraphPath = (name: string) =>
  `tests/fixtures/gold/${name}-graph.json.gz`;
export const loadGoldGraph = (name: string): Graph =>
  JSON.parse(gunzipSync(fs.readFileSync(goldGraphPath(name))).toString());

/** Route `anchors` as the app does: leg by leg, then joined. */
export function routeAsApp(
  graph: Graph,
  profile: Profile,
  anchors: Point[],
): RouteResult {
  const legs = anchors.slice(1).map((to, i) => {
    const request = { profile, anchors: [anchors[i], to] };
    return selectedRoute(compareOn(graph, request, graph.bbox))!;
  });
  return joinLegs(legs, anchors);
}

/** Waypoint indices for `intent`, `all`, or a comma-separated list. */
export function pickWaypoints(gold: Gold, pick = "intent"): number[] {
  if (pick === "intent") return gold.intent;
  if (pick === "all") return gold.waypoints.map((_, i) => i);
  return pick.split(",").map(Number);
}

async function importGpx(file: string, name: string, profile = "gravel_50", intent?: string) {
  const { parseGPX } = await import("../src/importers/gpx");
  const { DEFAULT_CELLS, loadReleaseGraph } = await import("./local_release");
  const round = (p: Point): Point => [+p[0].toFixed(7), +p[1].toFixed(7)];
  const line = parseGPX(fs.readFileSync(file, "utf8")).geometry.map(round);
  const graph = await loadReleaseGraph(DEFAULT_CELLS, line);
  const vertices = new Set(graph.edges.flatMap((e) => e.geometry.map(key)));
  const off = line.filter((p, i) => i > 0 && i < line.length - 1 && !vertices.has(key(p)));
  // Ibex splits an edge at each waypoint, so a drawn line leaves the graph's vertices
  // only there. A recorded ride leaves them everywhere, and would need map matching.
  if (off.length > 0.05 * line.length)
    throw new Error(
      `${off.length} of ${line.length} points are not graph vertices: ` +
        `draw the line in Ibex on the current release, or export it again.`,
    );
  const waypoints = [line[0], ...off, line.at(-1)!];
  const gold: Gold = {
    profile,
    line,
    waypoints,
    intent: intent
      ? intent.split(",").map(Number)
      : [0, waypoints.length - 1],
    min_shared: 0,
  };
  fs.writeFileSync(goldPath(name), JSON.stringify(gold));
  console.log(
    `${goldPath(name)}: ${line.length} points, ${waypoints.length} waypoints, ` +
      `intent ${gold.intent.join(",")}. Now generate its graph with ` +
      `scripts/gen_graph_fixture.ts gold/${name}, audit it, and set min_shared.`,
  );
}

async function audit(name: string, pick?: string, packs?: string) {
  const { loadProfile } = await import("./profile");
  const { loadReleaseGraph } = await import("./local_release");
  const gold = loadGold(goldPath(name));
  const graph = packs
    ? await loadReleaseGraph(packs, gold.line)
    : loadGoldGraph(name);
  const profile = await loadProfile(gold.profile);
  const indices = pickWaypoints(gold, pick);
  const result = routeAsApp(
    graph,
    profile,
    indices.map((i) => gold.waypoints[i]),
  );
  const o = overlap(result.geometry, gold.line);
  const km = (m: number) => (m / 1000).toFixed(2);
  const share = (x: Overlap) => (100 * x.sharedM) / x.goldM;
  console.log(
    `${name}, ${profile.name}, waypoints ${indices.join(",")}: ${result.status}, ` +
      `route ${km(o.routeM)} km, gold ${km(o.goldM)} km, shared ${km(o.sharedM)} km ` +
      `(${share(o).toFixed(1)}% of gold, min ${100 * gold.min_shared}%)`,
  );
  // The fixture is only a stand-in for the packs: if it routes differently, it has lost
  // an alternative the app weighs, and the test ratchet measures a graph nobody rides.
  if (packs) {
    const onFixture = overlap(
      routeAsApp(
        loadGoldGraph(name),
        profile,
        indices.map((i) => gold.waypoints[i]),
      ).geometry,
      gold.line,
    );
    const gap = share(onFixture) - share(o);
    console.log(
      Math.abs(gap) < 0.5
        ? `fixture agrees with the packs (${share(onFixture).toFixed(1)}%)`
        : `WARNING: the fixture routes ${share(onFixture).toFixed(1)}% of gold, the packs ` +
            `${share(o).toFixed(1)}%. Widen GOLD_RADIUS_M or regenerate the fixture.`,
    );
  }
  const fmt = (parts: Partial<Record<string, number>>) =>
    Object.entries(parts)
      .filter(([, v]) => Math.abs(v!) >= 1)
      .map(([k, v]) => `${k} ${Math.round(v!)}`)
      .join(", ");
  const length = (line: Point[]) =>
    line.slice(1).reduce((s, p, i) => s + distance(line[i], p), 0);
  for (const d of o.divergences) {
    const r = lineCost(graph, d.route, profile);
    if (!d.gold.length) {
      console.log(`\nleaves the gold line without rejoining it (${r.edges.length} edges)`);
      continue;
    }
    const g = lineCost(graph, d.gold, profile);
    // A waypoint's split edge is not in the graph and costs nothing on the gold side.
    if (!g.edges.length) continue;
    console.log(
      `\nat gold km ${km(d.atM)}: route ${Math.round(length(d.route))} m for ${Math.round(r.cost)}, ` +
        `gold ${Math.round(length(d.gold))} m for ${Math.round(g.cost)} ` +
        `(gold ${g.cost > r.cost ? "+" : ""}${Math.round(g.cost - r.cost)})`,
    );
    console.log(`  route: ${fmt(r.parts)}`);
    for (const e of r.edges) console.log(`    ${describe(e, profile)}`);
    console.log(`  gold:  ${fmt(g.parts)}`);
    for (const e of g.edges) console.log(`    ${describe(e, profile)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "import" && args.length >= 2)
    await importGpx(args[0], args[1], args[2], args[3]);
  else if (command === "audit" && args.length >= 1)
    await audit(args[0], args[1], args[2]);
  else
    throw new Error(
      "usage: gold_route.ts import <gpx> <name> [profile] [intent] | audit <name> [waypoints] [packs dir]",
    );
}
