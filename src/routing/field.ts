/**
 * The cost field: a coarse raster of "how far is it from here to the destination", used to
 * shape a corridor before the real search runs.
 *
 * Cells are `FIELD_ZOOM` tiles, and the field is filled by a Dijkstra over cell centres
 * rather than over the graph, so it is cheap enough to build per request. It is guidance
 * only — the search still falls back to the whole graph, so nothing here can make a route
 * impossible, only better or worse guided.
 */
import { Heap } from "./heap";
import { distance } from "../geo/distance";
import { costCache, total } from "./cost";
import { toCompiled } from "./compile";
import { eligible } from "./eligibility";
import type { Field, Graph, Point, RouteRequest } from "./types";

/**
 * Every preference now reads a derived per-edge signal, so a pack built before those
 * signals existed cannot serve any profile rather than only the ones that asked for them.
 */
export function validateProfileData(graph: Graph) {
  if (
    graph.edges.some(
      (e) => e.urban === undefined || e.cyclingNetwork === undefined,
    )
  )
    throw new Error(
      "This profile needs updated region data. Save the updated region.",
    );
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