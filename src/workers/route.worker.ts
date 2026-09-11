/// <reference lib="webworker" />
import { COST_MODEL_VERSION } from "../routing/types";
import { resolveProfile } from "../routing/profiles";
import { readJSON, type Installed } from "../offline/store";
import {
  validateAnchors,
  validateChunk,
  validateEdge,
  validateField,
  validateIndexSize,
  validateNode,
} from "../offline/validate";
import { buildField, pointInBounds, route } from "../routing/engine";
import { CellGraphProvider, searchArea } from "../routing/provider";
import { emptyComponents } from "../routing/engine";
import type { BBox } from "../geo/grid";
import type {
  Field,
  FieldView,
  Graph,
  Point,
  Profile,
  RouteRequest,
  RouteResult,
} from "../routing/types";

/** The legacy single-region pack index; unchanged so installed packs keep working. */
type Index = {
  schemaVersion: 1;
  bbox: Graph["bbox"];
  restrictions: Graph["restrictions"];
  chunks: { path: string; bbox: Graph["bbox"] }[];
  fields: Record<Profile, Field>;
};

async function loadGraph(
  pack: Installed,
  index: Index,
  selected: Index["chunks"],
) {
  const graph: Graph = {
    schemaVersion: 1,
    bbox: index.bbox,
    restrictions: index.restrictions,
    nodes: [],
    edges: [],
  };
  const nodes = new Map<number, Graph["nodes"][number]>();
  let loadedBytes = 0;
  for (const chunk of selected) {
    const value = await readJSON<Pick<Graph, "nodes" | "edges">>(
      pack,
      chunk.path,
    );
    validateChunk(value);
    for (const n of value.nodes) nodes.set(validateNode(n).id, n);
    for (const edge of value.edges) graph.edges.push(validateEdge(edge));
    loadedBytes += pack.manifest.files.find(
      (f) => f.path === chunk.path,
    )!.bytes;
  }
  graph.nodes = [...nodes.values()];
  return { graph, loadedBytes };
}

/** Coarse debug overlay: every second cell of the corridor field. */
function fieldViewOf(field: Field): FieldView {
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

function emptyResult(
  status: RouteResult["status"],
  anchors: Point[],
  extra: Partial<RouteResult> = {},
): RouteResult {
  return {
    status,
    mode: "corridor",
    geometry: [],
    anchors,
    cost: 0,
    components: emptyComponents(),
    distanceM: 0,
    hikeABikeM: 0,
    ferryM: 0,
    ascentM: null,
    descentM: null,
    elevationProfile: [],
    edgeIds: [],
    surfaceM: {},
    uncertainM: 0,
    metrics: {
      durationMs: 0,
      explored: 0,
      expansions: 0,
      tiles: 0,
      loadedBytes: 0,
    },
    ...extra,
  };
}

/**
 * Corridor expansion then the full-graph reference, shared by both data paths so the
 * comparison, cancellation semantics, and progress copy stay identical.
 */
async function compare(
  id: number,
  graph: Graph,
  request: RouteRequest,
  coverage: BBox,
  loadedBytes: number,
  start: number,
  extras: { blocks?: number; cells?: string[] } = {},
) {
  const field = buildField(graph, request);
  const fieldView = fieldViewOf(field);
  let corridor: RouteResult | undefined;
  let explored = 0;
  for (const [expansion, radius] of [2, 5, 12, Infinity].entries()) {
    self.postMessage({
      id,
      type: "progress",
      label: `Following the semantic corridor${expansion ? " · expanding" : ""}…`,
    });
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
    corridor.metrics.loadedBytes = loadedBytes;
    corridor.metrics.durationMs = performance.now() - start;
    corridor.metrics.explored = explored;
    Object.assign(corridor.metrics, extras);
    if (
      corridor.failedLeg !== undefined ||
      !["no-path", "snap-failed"].includes(corridor.status) ||
      request.anchors.some((p: Point) => !pointInBounds(p, coverage))
    )
      break;
  }
  self.postMessage({ id, type: "partial", route: corridor });
  self.postMessage({
    id,
    type: "progress",
    label: "Comparing with the complete graph…",
  });
  const referenceStart = performance.now();
  const reference = route(graph, request, "reference");
  reference.metrics.loadedBytes = loadedBytes;
  reference.metrics.durationMs = performance.now() - referenceStart;
  Object.assign(reference.metrics, extras);
  return { fieldView, reference, corridor: corridor! };
}

function postComparison(
  id: number,
  value: {
    fieldView: FieldView;
    reference: RouteResult;
    corridor: RouteResult;
  },
) {
  const { reference, corridor } = value;
  self.postMessage({
    id,
    type: "result",
    comparison: {
      ...value,
      relativeCost:
        reference.status === "ok" &&
        corridor.status === "ok" &&
        reference.cost > 0
          ? corridor.cost / reference.cost - 1
          : null,
    },
  });
}

type CellInput = {
  id: number;
  release: string;
  packs: Installed[];
  published?: { id: string; bbox: BBox }[];
  request: RouteRequest;
};
type LegacyInput = { id: number; pack: Installed; request: RouteRequest };

async function routeCells(data: CellInput) {
  const { id, packs, release } = data;
  const request = {
    ...data.request,
    profile: resolveProfile(data.request.profile),
  };
  validateAnchors(request.anchors);
  const start = performance.now();
  self.postMessage({ id, type: "progress", label: "Preparing your profile…" });

  const provider = new CellGraphProvider(packs, release, data.published ?? []);
  await provider.open();
  const coverage = provider.envelope();
  if (!coverage) {
    postComparison(id, {
      fieldView: { type: "FeatureCollection", features: [] },
      reference: emptyResult("missing-cells", request.anchors, {
        missingCells: provider.missing(searchArea(request.anchors)),
      }),
      corridor: emptyResult("missing-cells", request.anchors),
    });
    return;
  }

  // An anchor on uninstalled-but-published ground is a download problem, not a routing
  // failure, and the two must not be reported the same way.
  for (const anchor of request.anchors) {
    if (provider.contains(anchor)) continue;
    const needed = provider.missing(searchArea([anchor], 2));
    const status = needed.length ? "missing-cells" : "outside-coverage";
    postComparison(id, {
      fieldView: { type: "FeatureCollection", features: [] },
      reference: emptyResult(status, request.anchors, {
        missingCells: needed.length ? needed : undefined,
      }),
      corridor: emptyResult(status, request.anchors),
    });
    return;
  }

  const area = searchArea(request.anchors);
  const graph = await provider.load(area);
  for (const node of graph.nodes) validateNode(node);
  for (const edge of graph.edges) validateEdge(edge);

  const value = await compare(
    id,
    graph,
    request,
    coverage,
    provider.stats.storedBytes,
    start,
    { blocks: provider.stats.blocks, cells: provider.stats.cells },
  );
  // A search that ran out of graph next to uninstalled coverage is missing data, not a
  // disconnected network.
  if (value.reference.status === "no-path") {
    const needed = provider.missing(area);
    if (needed.length) {
      value.reference.status = "missing-cells";
      value.reference.missingCells = needed;
      value.corridor.status = "missing-cells";
      value.corridor.missingCells = needed;
    }
  }
  postComparison(id, value);
}

async function routeLegacy(data: LegacyInput) {
  const { id, pack } = data;
  const request = {
    ...data.request,
    profile: resolveProfile(data.request.profile),
  };
  if (pack.manifest.costModelVersion !== COST_MODEL_VERSION)
    throw new Error("Routing data needs updating. Save the updated region.");
  const start = performance.now();
  const index = await readJSON<Index>(pack, "index.bin");
  if (index.schemaVersion !== 1) throw new Error("Unsupported graph index");
  validateIndexSize(index);
  for (const field of Object.values(index.fields)) validateField(field);
  validateAnchors(request.anchors);
  // Fields baked into packs cannot represent arbitrary user coefficients.
  // Read once, then share the graph across corridor expansion and reference.
  self.postMessage({ id, type: "progress", label: "Preparing your profile…" });
  const { graph, loadedBytes } = await loadGraph(pack, index, index.chunks);
  postComparison(
    id,
    await compare(id, graph, request, index.bbox, loadedBytes, start),
  );
}

self.onmessage = async (event: MessageEvent<CellInput | LegacyInput>) => {
  const data = event.data;
  try {
    if ("packs" in data) await routeCells(data);
    else await routeLegacy(data);
  } catch (e) {
    self.postMessage({
      id: data.id,
      type: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
};
