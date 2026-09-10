/// <reference lib="webworker" />
import { COST_MODEL_VERSION } from "../routing/types";
import { resolveProfile } from "../routing/profiles";
import { readJSON, type Installed } from "../offline/store";
import { buildField, pointInBounds, route } from "../routing/engine";
import type {
  Field,
  FieldView,
  Graph,
  Point,
  Profile,
  RouteRequest,
  RouteResult,
} from "../routing/types";
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
    if (
      !Array.isArray(value.edges) ||
      value.edges.length > 100000 ||
      !Array.isArray(value.nodes)
    )
      throw new Error("Invalid graph chunk");
    if (value.nodes.length > 100000)
      throw new Error("Invalid graph node count");
    for (const n of value.nodes) {
      if (
        !Number.isSafeInteger(n.id) ||
        n.p.length !== 2 ||
        n.p.some((v) => !Number.isFinite(v))
      )
        throw new Error("Invalid graph node");
      nodes.set(n.id, n);
    }
    for (const edge of value.edges) {
      if (
        typeof edge.highway !== "string" ||
        !Number.isFinite(edge.length) ||
        edge.length <= 0 ||
        ![
          edge.stress,
          edge.uncertainty,
          edge.utility,
          edge.urban,
          edge.cyclingNetwork,
        ].every(
          (v) =>
            typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
        ) ||
        (edge.ferrySeconds !== undefined &&
          (!Number.isFinite(edge.ferrySeconds) || edge.ferrySeconds < 0)) ||
        (edge.highway === "ferry" &&
          (typeof edge.ferryService !== "string" ||
            !edge.ferryService.length)) ||
        edge.geometry.length < 2 ||
        edge.geometry.length > 100000 ||
        edge.geometry.some(
          (p) => p.length !== 2 || p.some((v) => !Number.isFinite(v)),
        ) ||
        edge.grades?.some(
          ([length, grade]) =>
            !Number.isFinite(length) || length <= 0 || !Number.isFinite(grade),
        )
      )
        throw new Error("Invalid graph edge");
      graph.edges.push(edge);
    }
    loadedBytes += pack.manifest.files.find(
      (f) => f.path === chunk.path,
    )!.bytes;
  }
  graph.nodes = [...nodes.values()];
  return { graph, loadedBytes };
}
self.onmessage = async (
  event: MessageEvent<{ id: number; pack: Installed; request: RouteRequest }>,
) => {
  const { id, pack } = event.data;
  try {
    const request = {
      ...event.data.request,
      profile: resolveProfile(event.data.request.profile),
    };
    if (pack.manifest.costModelVersion !== COST_MODEL_VERSION)
      throw new Error("Routing data needs updating. Save the updated region.");
    const start = performance.now();
    const index = await readJSON<Index>(pack, "index.bin");
    if (index.schemaVersion !== 1) throw new Error("Unsupported graph index");
    if (
      !Array.isArray(index.chunks) ||
      index.chunks.length > 1000 ||
      !Array.isArray(index.restrictions) ||
      index.restrictions.length > 50000
    )
      throw new Error("Invalid graph index size");
    for (const field of Object.values(index.fields)) {
      if (
        !Number.isInteger(field.width) ||
        !Number.isInteger(field.height) ||
        field.width < 1 ||
        field.height < 1 ||
        field.width * field.height > 100000 ||
        field.costs.length !== field.width * field.height ||
        field.costs.some((c) => !Number.isFinite(c) || c <= 0)
      )
        throw new Error("Invalid semantic field");
    }
    if (
      !Array.isArray(request.anchors) ||
      request.anchors.length < 2 ||
      request.anchors.length > 12 ||
      request.anchors.some(
        (p) => p.length !== 2 || p.some((v) => !Number.isFinite(v)),
      )
    )
      throw new Error("Invalid route anchors");
    // Fields baked into packs cannot represent arbitrary user coefficients.
    // Read once, then share the graph across corridor expansion and reference.
    self.postMessage({
      id,
      type: "progress",
      label: "Preparing your profile…",
    });
    const { graph, loadedBytes } = await loadGraph(pack, index, index.chunks);
    const field = buildField(graph, request);
    const fieldView: FieldView = { type: "FeatureCollection", features: [] };
    for (let y = 0; y < field.height; y += 2)
      for (let x = 0; x < field.width; x += 2) {
        const [w, s, e, n] = field.bbox;
        const x0 = w + (x / field.width) * (e - w),
          x1 = w + (Math.min(x + 2, field.width) / field.width) * (e - w),
          y0 = s + (y / field.height) * (n - s),
          y1 = s + (Math.min(y + 2, field.height) / field.height) * (n - s);
        fieldView.features.push({
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
      if (
        corridor.failedLeg !== undefined ||
        !["no-path", "snap-failed"].includes(corridor.status) ||
        request.anchors.some((p: Point) => !pointInBounds(p, index.bbox))
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
    self.postMessage({
      id,
      type: "result",
      comparison: {
        fieldView,
        reference,
        corridor,
        relativeCost:
          reference.status === "ok" &&
          corridor!.status === "ok" &&
          reference.cost > 0
            ? corridor!.cost / reference.cost - 1
            : null,
      },
    });
  } catch (e) {
    self.postMessage({
      id,
      type: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
};
