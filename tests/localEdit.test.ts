import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { route as routeOn } from "../src/routing/engine";
import { joinLegs, routeLegs } from "../src/routing/legs";
import {
  anchorVertices,
  applyLocalEdit,
  findPinches,
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
const within = (lo: number, hi: number) => (p: Point) =>
  p[0] >= lo && p[0] <= hi;
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

  it("pinches where the route leaves the screen, never past a neighbour", () => {
    const geometry = line(11);
    const vertices = [0, 5, 10];
    const moved = findPinches(
      geometry,
      vertices,
      { kind: "move", index: 1 },
      within(3, 7),
    );
    expect(moved.before?.position).toBeCloseTo(3, 6);
    expect(moved.after?.position).toBeCloseTo(7, 6);
    expect(moved.before?.point[0]).toBeCloseTo(3, 6);
    // Both neighbours on screen: nothing to pin.
    expect(
      findPinches(
        geometry,
        vertices,
        { kind: "move", index: 1 },
        within(0, 10),
      ),
    ).toEqual({ before: undefined, after: undefined });
    // The first waypoint has nothing before it.
    expect(
      findPinches(geometry, vertices, { kind: "move", index: 0 }, within(0, 3))
        .before,
    ).toBeUndefined();
    // A leg grabbed between vertices pins only the side that leaves the screen.
    const inserted = findPinches(
      geometry,
      vertices,
      { kind: "insert", index: 1, position: 2.5 },
      within(2, 8),
    );
    expect(inserted.before?.position).toBeCloseTo(2, 6);
    expect(inserted.after).toBeUndefined();
    // A grab already off screen pins nothing.
    expect(
      findPinches(geometry, vertices, { kind: "move", index: 1 }, within(6, 9)),
    ).toEqual({});
  });

  it("pins a long straight span where it crosses the edge, not at its far vertex", () => {
    // Two vertices, ten units apart: the next vertex out is always off screen.
    const geometry: Point[] = [
      [0, 0],
      [10, 0],
    ];
    const pinches = findPinches(
      geometry,
      [0, 1],
      { kind: "insert", index: 1, position: 0.5 },
      within(3, 7),
    );
    expect(pinches.before?.position).toBeCloseTo(0.3, 6);
    expect(pinches.after?.position).toBeCloseTo(0.7, 6);
    expect(pinches.after?.point[0]).toBeCloseTo(7, 5);
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
