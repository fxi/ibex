/**
 * Waypoint-by-waypoint routing.
 *
 * A whole route used to be one search over the graph under the bbox of every waypoint:
 * a 500 km route decoded a region's worth of roads and split one search budget across
 * all its legs. Each leg is now solved on its own, over the area around its two
 * waypoints only, with its own budget, and the finished legs are joined.
 *
 * The one thing this gives up is continuity through a waypoint: turn restrictions and
 * ferry boarding do not carry from one leg into the next, so a rider may turn around at a
 * waypoint. That is also what a waypoint usually means.
 */
import { bboxIntersects, type BBox } from "../geo/grid";
import { toCompiled } from "./compile";
import { buildField, emptyComponents, route } from "./engine";
import { searchArea } from "./provider";
import { selectedRoute } from "./selection";
import type {
  Comparison,
  Components,
  Field,
  FieldView,
  Graph,
  Point,
  RouteRequest,
  RouteResult,
} from "./types";

/** Where leg graphs come from: the cell provider in the app, a fixture in tests. */
export type LegGraphSource = {
  load(bbox: BBox): Promise<Graph>;
  /** Published cells overlapping the area that are not installed. */
  missing(bbox: BBox): string[];
  /** Drop cached data outside the area, so memory tracks one leg rather than the route. */
  retain?(bbox: BBox): void;
};

/** Coarse debug overlay: every second cell of the corridor field. */
export function fieldViewOf(field: Field): FieldView {
  const view: FieldView = { type: "FeatureCollection", features: [] };
  const [w, s, e, n] = field.bbox;
  for (let y = 0; y < field.height; y += 2)
    for (let x = 0; x < field.width; x += 2) {
      const x0 = w + (x / field.width) * (e - w),
        x1 = w + (Math.min(x + 2, field.width) / field.width) * (e - w),
        y0 = s + (y / field.height) * (n - s),
        y1 = s + (Math.min(y + 2, field.height) / field.height) * (n - s);
      view.features.push({
        type: "Feature",
        properties: { cost: field.costs[y * field.width + x] },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [x0, y0],
              [x1, y0],
              [x1, y1],
              [x0, y1],
              [x0, y0],
            ],
          ],
        },
      });
    }
  return view;
}

/**
 * Corridor expansion, then the full-graph reference — for one graph and one request. Used
 * per leg, so every budget here is a per-leg budget.
 */
export function compareOn(
  graph: Graph,
  request: RouteRequest,
  coverage: BBox,
  progress: (label: string) => void = () => {},
): Comparison & { fieldView: FieldView } {
  if (!request.diagnostics) {
    progress("Finding your route…");
    const result = route(graph, request, "reference");
    return {
      reference: result,
      corridor: result,
      fieldView: { type: "FeatureCollection", features: [] },
      relativeCost: null,
    };
  }
  const field = buildField(graph, request);
  const fieldView = fieldViewOf(field);
  let corridor: RouteResult | undefined;
  let explored = 0;
  const initialRadius = toCompiled(request.profile).detour.corridor_cells;
  for (const [expansion, radius] of [
    initialRadius,
    initialRadius * 2.5,
    Infinity,
  ].entries()) {
    progress(
      `Following the semantic corridor${expansion ? " · expanding" : ""}…`,
    );
    corridor = route(
      graph,
      {
        ...request,
        maxSettled: Math.max(1, (request.maxSettled ?? 1500000) - explored),
      },
      "corridor",
      field,
      radius,
    );
    explored += corridor.metrics.explored;
    corridor.metrics.expansions = expansion;
    corridor.metrics.explored = explored;
    if (
      corridor.failedLeg !== undefined ||
      !["no-path", "snap-failed"].includes(corridor.status) ||
      request.anchors.some(
        (p) =>
          p[0] < coverage[0] ||
          p[0] > coverage[2] ||
          p[1] < coverage[1] ||
          p[1] > coverage[3],
      )
    )
      break;
  }
  progress("Comparing with the complete graph…");
  const reference = route(graph, request, "reference");
  return {
    fieldView,
    reference,
    corridor: corridor!,
    relativeCost: relativeCost(reference, corridor!),
  };
}

export function relativeCost(
  reference: RouteResult,
  corridor: RouteResult,
): number | null {
  return reference.status === "ok" &&
    corridor.status === "ok" &&
    reference.cost > 0
    ? corridor.cost / reference.cost - 1
    : null;
}

const intersect = (a: BBox, b: BBox): BBox => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.min(a[2], b[2]),
  Math.min(a[3], b[3]),
];

/**
 * One leg's comparison. `selected` always holds the route chosen for the leg, so legs
 * joined through it carry each leg's own choice.
 */
export type LegComparison = Comparison & {
  fieldView: FieldView;
  selected: RouteResult;
};

/** Route leg `leg` (one-based) of `request.anchors`, over the area of its two waypoints. */
export async function routeLeg(
  source: LegGraphSource,
  request: RouteRequest,
  leg: number,
  coverage: BBox,
  progress: (label: string) => void = () => {},
): Promise<LegComparison> {
  const legs = request.anchors.length - 1;
  const prefix = legs > 1 ? `Leg ${leg} of ${legs} · ` : "";
  const anchors: Point[] = [request.anchors[leg - 1], request.anchors[leg]];
  const area = searchArea(anchors);
  source.retain?.(area);
  progress(`${prefix}Loading map data…`);
  const loadStarted = performance.now();
  const loaded = await source.load(area);
  const loadMs = performance.now() - loadStarted;
  // The corridor field is laid over the graph bbox; keep it to the leg, not the region.
  const graph: Graph = {
    ...loaded,
    bbox: bboxIntersects(loaded.bbox, area)
      ? intersect(loaded.bbox, area)
      : loaded.bbox,
  };
  const value = compareOn(
    graph,
    { ...request, anchors },
    coverage,
    (label) => progress(prefix + label),
  );
  for (const result of new Set([value.reference, value.corridor]))
    result.metrics.loadMs = loadMs;
  // A search that ran out of graph next to uninstalled coverage is missing data, not a
  // disconnected network. The same is true of a failed snap: an anchor with no road within
  // 250 m is a hole in the data whenever coverage next to it is uninstalled, and blaming
  // the waypoint sends the rider to move a marker that was never the problem.
  if (value.reference.status === "no-path" || value.reference.status === "snap-failed") {
    const needed = source.missing(area);
    if (needed.length)
      for (const r of [value.reference, value.corridor]) {
        r.status = "missing-cells";
        r.missingCells = needed;
      }
  }
  return { ...value, selected: selectedRoute(value)! };
}

/** Join leg comparisons, first to last, into the comparison for the whole route. */
export function joinComparison(
  legs: LegComparison[],
  anchors: Point[],
): Comparison {
  const reference = joinLegs(
    legs.map((c) => c.reference),
    anchors,
  );
  const corridor = joinLegs(
    legs.map((c) => c.corridor),
    anchors,
  );
  return {
    fieldView: {
      type: "FeatureCollection",
      features: legs.flatMap((c) => c.fieldView.features),
    },
    reference,
    corridor,
    selected: joinLegs(
      legs.map((c) => c.selected),
      anchors,
    ),
    relativeCost: legs.every((leg) => leg.relativeCost !== null)
      ? relativeCost(reference, corridor)
      : null,
  };
}

/**
 * Route every leg in order and join them. Legs run one at a time and each leg's graph is
 * released before the next is loaded, so peak memory is that of the largest leg. A leg
 * `cached` supplies is not routed again; `onLeg` sees every leg that was.
 */
export async function routeLegs(
  source: LegGraphSource,
  request: RouteRequest,
  coverage: BBox,
  progress: (label: string) => void = () => {},
  hooks: {
    cached?: (leg: number) => LegComparison | undefined;
    onLeg?: (leg: number, value: LegComparison) => void;
  } = {},
): Promise<Comparison> {
  const done: LegComparison[] = [];
  for (let leg = 1; leg < request.anchors.length; leg++) {
    let value = hooks.cached?.(leg);
    if (!value) {
      value = await routeLeg(source, request, leg, coverage, progress);
      hooks.onLeg?.(leg, value);
    }
    done.push(value);
    if (value.selected.status !== "ok") break;
  }
  return joinComparison(done, request.anchors);
}

/**
 * Join leg results, first to last, into one route over `anchors`.
 *
 * Each leg ends on the snapped point its successor starts from, so the shared vertex is
 * kept once and indices into the geometry shift by the joined length minus one — the same
 * convention the engine uses between consecutive edges. A failed leg makes the whole route
 * fail with that leg's status, numbered across the route.
 */
export function joinLegs(legs: RouteResult[], anchors: Point[]): RouteResult {
  const failed = legs.findIndex((r) => r.status !== "ok");
  const joined: RouteResult = {
    status: failed === -1 ? "ok" : legs[failed].status,
    mode: legs[0]?.mode ?? "reference",
    geometry: [],
    anchors: [],
    cost: 0,
    components: emptyComponents(),
    distanceM: 0,
    hikeABikeM: 0,
    ferryM: 0,
    ascentM: 0,
    descentM: 0,
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
  if (failed !== -1) {
    const leg = legs[failed];
    joined.anchors = anchors;
    joined.failedLeg =
      leg.failedLeg !== undefined ? failed + leg.failedLeg : undefined;
    const missing = new Set(legs.flatMap((r) => r.missingCells ?? []));
    if (missing.size) joined.missingCells = [...missing];
  }
  if (!legs.length) {
    joined.status = "no-path";
    joined.anchors = anchors;
    return joined;
  }
  const corridor: Point[][] = [];
  for (const [i, leg] of legs.entries()) {
    joined.metrics.durationMs += leg.metrics.durationMs;
    joined.metrics.loadMs =
      (joined.metrics.loadMs ?? 0) + (leg.metrics.loadMs ?? 0);
    joined.metrics.loadedBytes += leg.metrics.loadedBytes;
    joined.metrics.blocks =
      (joined.metrics.blocks ?? 0) + (leg.metrics.blocks ?? 0);
    joined.metrics.cells = [
      ...new Set([
        ...(joined.metrics.cells ?? []),
        ...(leg.metrics.cells ?? []),
      ]),
    ];
    joined.metrics.explored += leg.metrics.explored;
    joined.metrics.preparedStates =
      (joined.metrics.preparedStates ?? 0) + (leg.metrics.preparedStates ?? 0);
    joined.metrics.expansions = Math.max(
      joined.metrics.expansions,
      leg.metrics.expansions,
    );
    joined.metrics.tiles += leg.metrics.tiles;
    if (leg.corridor) corridor.push(...leg.corridor);
    if (failed !== -1) continue;

    const base = joined.geometry.length ? joined.geometry.length - 1 : 0;
    joined.geometry.push(
      ...(joined.geometry.length ? leg.geometry.slice(1) : leg.geometry),
    );
    for (const s of leg.segments)
      joined.segments.push({ ...s, start: s.start + base, end: s.end + base });
    for (const [m, h] of leg.elevationProfile)
      joined.elevationProfile.push([m + joined.distanceM, h]);
    if (i === 0) joined.anchors.push(leg.anchors[0] ?? anchors[0]);
    joined.anchors.push(leg.anchors.at(-1) ?? anchors[i + 1]);
    joined.edgeIds.push(...leg.edgeIds);
    joined.cost += leg.cost;
    for (const k of Object.keys(leg.components) as (keyof Components)[])
      joined.components[k] += leg.components[k];
    joined.distanceM += leg.distanceM;
    joined.hikeABikeM += leg.hikeABikeM;
    joined.ferryM += leg.ferryM;
    joined.uncertainM += leg.uncertainM;
    for (const [surface, m] of Object.entries(leg.surfaceM))
      joined.surfaceM[surface] = (joined.surfaceM[surface] ?? 0) + m;
    joined.ascentM =
      joined.ascentM === null || leg.ascentM === null
        ? null
        : joined.ascentM + leg.ascentM;
    joined.descentM =
      joined.descentM === null || leg.descentM === null
        ? null
        : joined.descentM + leg.descentM;
  }
  if (failed !== -1) {
    joined.ascentM = null;
    joined.descentM = null;
  }
  if (corridor.length) joined.corridor = corridor;
  return joined;
}
