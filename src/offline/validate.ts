/**
 * Defensive limits and shape checks for decoded routing data, extracted verbatim from
 * route.worker.ts so every reader — the legacy gzip-JSON path and the binary decoder —
 * enforces exactly the same contract. Messages are load-bearing: they reach the user.
 */
import type { Edge, Field, Graph, Node, Point } from "../routing/types";

/** Caps that bound memory for data the app did not produce. */
export const LIMITS = {
  chunkEdges: 100_000,
  chunkNodes: 100_000,
  geometryPoints: 100_000,
  indexChunks: 1000,
  restrictions: 50_000,
  fieldCells: 100_000,
  anchorsMin: 2,
  anchorsMax: 12,
} as const;

const unit = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export function validateChunk(value: Pick<Graph, "nodes" | "edges">): void {
  if (
    !Array.isArray(value.edges) ||
    value.edges.length > LIMITS.chunkEdges ||
    !Array.isArray(value.nodes)
  )
    throw new Error("Invalid graph chunk");
  if (value.nodes.length > LIMITS.chunkNodes)
    throw new Error("Invalid graph node count");
}

export function validateNode(n: Node): Node {
  if (
    !Number.isSafeInteger(n.id) ||
    n.p.length !== 2 ||
    n.p.some((v) => !Number.isFinite(v))
  )
    throw new Error("Invalid graph node");
  return n;
}

export function validateEdge(edge: Edge): Edge {
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
    ].every(unit) ||
    (edge.ferrySeconds !== undefined &&
      (!Number.isFinite(edge.ferrySeconds) || edge.ferrySeconds < 0)) ||
    (edge.highway === "ferry" &&
      (typeof edge.ferryService !== "string" || !edge.ferryService.length)) ||
    edge.geometry.length < 2 ||
    edge.geometry.length > LIMITS.geometryPoints ||
    edge.geometry.some(
      (p) => p.length !== 2 || p.some((v) => !Number.isFinite(v)),
    ) ||
    (edge.semantics !== undefined &&
      (edge.semantics.version !== 1 ||
        typeof edge.semantics.surfaceKnown !== "boolean" ||
        ![
          edge.semantics.roughness,
          edge.semantics.technicalUp,
          edge.semantics.technicalDown,
          edge.semantics.unpaved,
          edge.semantics.curvature,
        ].every(unit))) ||
    edge.grades?.some(
      ([length, grade]) =>
        !Number.isFinite(length) || length <= 0 || !Number.isFinite(grade),
    )
  )
    throw new Error("Invalid graph edge");
  return edge;
}

export function validateField(field: Field): Field {
  if (
    !Number.isInteger(field.width) ||
    !Number.isInteger(field.height) ||
    field.width < 1 ||
    field.height < 1 ||
    field.width * field.height > LIMITS.fieldCells ||
    field.costs.length !== field.width * field.height ||
    field.costs.some((c) => !Number.isFinite(c) || c <= 0)
  )
    throw new Error("Invalid semantic field");
  return field;
}

export function validateIndexSize(value: {
  chunks: unknown;
  restrictions: unknown;
}): void {
  if (
    !Array.isArray(value.chunks) ||
    value.chunks.length > LIMITS.indexChunks ||
    !Array.isArray(value.restrictions) ||
    value.restrictions.length > LIMITS.restrictions
  )
    throw new Error("Invalid graph index size");
}

export function validateAnchors(anchors: Point[]): Point[] {
  if (
    !Array.isArray(anchors) ||
    anchors.length < LIMITS.anchorsMin ||
    anchors.length > LIMITS.anchorsMax ||
    anchors.some((p) => p.length !== 2 || p.some((v) => !Number.isFinite(v)))
  )
    throw new Error("Invalid route anchors");
  return anchors;
}
