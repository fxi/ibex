import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { distance, route as routeOn } from "../src/routing/engine";
import { joinLegs, routeLegs } from "../src/routing/legs";
import {
  anchorVertices,
  applyLocalEdit,
  pinchesAround,
  routeHandles,
  sliceRoute,
} from "../src/routing/localEdit";
import { selectedRoute } from "../src/routing/selection";
import type { Graph, Point, RouteResult } from "../src/routing/types";
import { loadProfile } from "./helpers";

const graph: Graph = JSON.parse(
  gunzipSync(
    readFileSync(new URL("./fixtures/coudry-graph.json.gz", import.meta.url)),
  ).toString(),
);
const profile = loadProfile("gravel_50");
const start: Point = [6.3533, 46.1632],
  end: Point = [6.2316, 46.1833];
const baseline = routeOn(
  graph,
  { anchors: [start, end], profile },
  "reference",
);
const middle = baseline.geometry[Math.floor(baseline.geometry.length / 2)];
const anchors = [start, middle, end];
const routed: Promise<RouteResult> = routeLegs(
  { load: async () => graph, missing: () => [] },
  { anchors, profile },
  graph.bbox,
).then((c) => selectedRoute(c)!);

/** A straight line of `n` vertices along x, one unit apart. */
const line = (n: number): Point[] =>
  Array.from({ length: n }, (_, i): Point => [i, 0]);
const close = (a: number, b: number) =>
  expect(Math.abs(a - b)).toBeLessThan(1e-6 * Math.max(1, Math.abs(b)));

/** Pieces of a route, joined back, carry the route's own totals. */
function expectSameTotals(joined: RouteResult, route: RouteResult) {
  close(joined.distanceM, route.distanceM);
  close(joined.cost, route.cost);
  close(joined.hikeABikeM, route.hikeABikeM);
  close(joined.uncertainM, route.uncertainM);
  if (route.ascentM !== null) close(joined.ascentM!, route.ascentM);
  for (const [surface, m] of Object.entries(route.surfaceM))
    close(joined.surfaceM[surface] ?? 0, m);
  close(
    joined.segments.reduce((sum, s) => sum + s.lengthM, 0),
    route.segments.reduce((sum, s) => sum + s.lengthM, 0),
  );
  expect(joined.segments[0].start).toBe(0);
  expect(joined.segments.at(-1)!.end).toBe(joined.geometry.length - 1);
}

describe("local edits", () => {
  it("finds every waypoint on the joined route, in order", async () => {
    const route = await routed;
    expect(route.status).toBe("ok");
    const vertices = anchorVertices(route, anchors.length)!;
    expect(vertices).toBeDefined();
    expect(vertices[0]).toBe(0);
    expect(vertices.at(-1)).toBe(route.geometry.length - 1);
    expect(vertices[1]).toBeGreaterThan(0);
    expect(vertices[1]).toBeLessThan(vertices[2]);
    expect(anchorVertices(route, anchors.length + 1)).toBeUndefined();
  });

  it("cuts a route at a vertex into pieces that join back into the same route", async () => {
    const route = await routed;
    const last = route.geometry.length - 1;
    const cut = Math.floor(last / 3);
    const pieces = [sliceRoute(route, 0, cut), sliceRoute(route, cut, last)];
    const joined = joinLegs(pieces, [start, end]);
    expect(joined.geometry).toEqual(route.geometry);
    expectSameTotals(joined, route);
    expect(pieces[0].geometry.at(-1)).toEqual(pieces[1].geometry[0]);
    expect(pieces[0].elevationProfile[0][0]).toBe(0);
    close(pieces[0].elevationProfile.at(-1)![0], pieces[0].distanceM);
  });

  it("cuts a route between vertices, adding the cut point once", async () => {
    const route = await routed;
    const last = route.geometry.length - 1;
    const cut = Math.floor(last / 3) + 0.4;
    const pieces = [sliceRoute(route, 0, cut), sliceRoute(route, cut, last)];
    const joined = joinLegs(pieces, [start, end]);
    const point = pieces[0].geometry.at(-1)!;
    expect(pieces[1].geometry[0]).toEqual(point);
    expect(pieces[0].anchors[1]).toEqual(point);
    expect(joined.geometry).toHaveLength(route.geometry.length + 1);
    expect(joined.geometry.filter((p) => p !== point)).toEqual(route.geometry);
    expectSameTotals(joined, route);
    for (const piece of pieces)
      for (const s of piece.segments) {
        expect(s.end).toBeGreaterThan(s.start);
        expect(s.end).toBeLessThan(piece.geometry.length);
      }
  });

  it("spreads handles evenly along each leg, never onto a waypoint", () => {
    const geometry = line(21);
    const vertices = [0, 8, 20];
    const unit = distance([0, 0], [1, 0]);
    // Two units apart: the 8-unit leg gets 3 handles, the 12-unit leg 5.
    const handles = routeHandles(geometry, vertices, () => 2 * unit);
    expect(handles.map((h) => h.position)).toEqual(
      [2, 4, 6, 10, 12, 14, 16, 18].map((p) => expect.closeTo(p, 6)),
    );
    expect(handles[0].point[0]).toBeCloseTo(2, 6);
    // A leg half a spacing long still gets one, in its middle; a shorter one gets none.
    expect(
      routeHandles(geometry, vertices, () => 16 * unit).map((h) => h.position),
    ).toEqual([expect.closeTo(4, 6), expect.closeTo(14, 6)]);
    expect(routeHandles(geometry, vertices, () => 100 * unit)).toEqual([]);
    // A long straight span is split between its vertices, not at them.
    const span = routeHandles(
      [
        [0, 0],
        [10, 0],
      ],
      [0, 1],
      () => 2.5 * unit,
    );
    expect(span.map((h) => h.position)).toEqual(
      [0.25, 0.5, 0.75].map((p) => expect.closeTo(p, 6)),
    );
  });

  it("pins an edit at the nearest stop on either side of the grab", () => {
    const vertices = [0, 8, 20];
    const handles = [2, 4, 6, 10, 12, 18].map((position) => ({
      position,
      point: [position, 0] as Point,
    }));
    const at = (p: number) => handles.find((h) => h.position === p);
    // A waypoint moved is pinned by the last handle before it and the first after it.
    expect(
      pinchesAround(vertices, handles, { kind: "move", index: 1 }),
    ).toEqual({ before: at(6), after: at(10) });
    // The first and last waypoints have nothing beyond them.
    expect(
      pinchesAround(vertices, handles, { kind: "move", index: 0 }),
    ).toEqual({ before: undefined, after: at(2) });
    expect(
      pinchesAround(vertices, handles, { kind: "move", index: 2 }),
    ).toEqual({ before: at(18), after: undefined });
    // Grabbed between handles, those two handles are the stops.
    expect(
      pinchesAround(vertices, handles, {
        kind: "insert",
        index: 2,
        position: 11,
      }),
    ).toEqual({ before: at(10), after: at(12) });
    // A dragged handle is the grab, so the stops are its neighbours; a waypoint nearer
    // than any handle is a stop of its own, and pins nothing.
    expect(
      pinchesAround(vertices, handles, {
        kind: "insert",
        index: 1,
        position: 2,
      }),
    ).toEqual({ before: undefined, after: at(4) });
    expect(
      pinchesAround(vertices, handles, {
        kind: "insert",
        index: 2,
        position: 19,
      }),
    ).toEqual({ before: at(18), after: undefined });
  });

  it("keeps the legs outside the pinches and edits only between them", async () => {
    const route = await routed;
    const vertices = anchorVertices(route, anchors.length)!;
    const g = route.geometry;
    const b = Math.floor(vertices[1] / 2),
      a = Math.floor((vertices[1] + vertices[2]) / 2);
    const pinches = {
      before: { position: b, point: g[b] },
      after: { position: a, point: g[a] },
    };
    const moved: Point = [middle[0] + 0.001, middle[1]];

    const plain = applyLocalEdit(anchors, { kind: "move", index: 1 }, moved);
    expect(plain.anchors).toEqual([start, moved, end]);
    expect(plain.kept.size).toBe(0);

    const local = applyLocalEdit(anchors, { kind: "move", index: 1 }, moved, {
      route,
      vertices,
      pinches,
    });
    expect(local.anchors).toEqual([start, g[b], moved, g[a], end]);
    expect([...local.kept.keys()]).toEqual([1, 4]);
    expect(local.kept.get(1)!.geometry).toEqual(g.slice(0, b + 1));
    expect(local.kept.get(4)!.geometry).toEqual(g.slice(a, g.length));

    const inserted = applyLocalEdit(
      anchors,
      { kind: "insert", index: 2, position: a },
      moved,
      { route, vertices, pinches: { before: pinches.after } },
    );
    expect(inserted.anchors).toEqual([start, middle, g[a], moved, end]);
    expect([...inserted.kept.keys()]).toEqual([2]);
    expect(inserted.kept.get(2)!.geometry).toEqual(g.slice(vertices[1], a + 1));
  });
});
