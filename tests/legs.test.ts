import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { distance, emptyComponents, route } from "../src/routing/engine";
import {
  compareOn,
  joinLegs,
  routeLegs,
  type LegComparison,
} from "../src/routing/legs";
import { selectedRoute } from "../src/routing/selection";
import type {
  Graph,
  Point,
  RouteRequest,
  RouteResult,
} from "../src/routing/types";
import { loadProfile } from "./helpers";

const graph: Graph = JSON.parse(
  gunzipSync(
    readFileSync(new URL("./fixtures/coudry-graph.json.gz", import.meta.url)),
  ).toString(),
);
const profile = loadProfile("gravel_50");
const start: Point = [6.3533, 46.1632],
  end: Point = [6.2316, 46.1833];
// A waypoint on the reference line, so splitting there should not change the ride much.
const baseline = route(graph, { anchors: [start, end], profile }, "reference");
const middle = baseline.geometry[Math.floor(baseline.geometry.length / 2)];

/** Every leg gets the whole fixture; what matters here is the splitting and joining. */
const fixture = {
  load: async () => graph,
  missing: () => [],
};

function failed(
  status: RouteResult["status"],
  failedLeg?: number,
): RouteResult {
  return {
    ...baseline,
    status,
    failedLeg,
    geometry: [],
    segments: [],
    anchors: [],
  };
}

describe("routing leg by leg", () => {
  it("returns the same route as before for a single leg", async () => {
    const request: RouteRequest = { anchors: [start, end], profile };
    const whole = selectedRoute(compareOn(graph, request, graph.bbox))!;
    const legs = selectedRoute(await routeLegs(fixture, request, graph.bbox))!;
    expect(legs.status).toBe("ok");
    expect(legs.edgeIds).toEqual(whole.edgeIds);
    expect(legs.distanceM).toBeCloseTo(whole.distanceM, 6);
    expect(legs.cost).toBeCloseTo(whole.cost, 6);
  }, 30000);

  it("joins legs into one continuous, consistent route", async () => {
    const anchors = [start, middle, end];
    const comparison = await routeLegs(
      fixture,
      { anchors, profile },
      graph.bbox,
    );
    const r = comparison.reference;
    expect(r.status).toBe("ok");
    expect(r.anchors).toHaveLength(3);
    expect(distance(r.geometry[0], r.anchors[0])).toBeLessThan(1);
    expect(distance(r.geometry.at(-1)!, r.anchors[2])).toBeLessThan(1);
    // Segments stay contiguous across the join and index the joined geometry.
    expect(r.segments[0].start).toBe(0);
    for (let i = 1; i < r.segments.length; i++)
      expect(r.segments[i].start).toBe(r.segments[i - 1].end);
    expect(r.segments.at(-1)!.end).toBe(r.geometry.length - 1);
    const segmentM = r.segments.reduce((sum, s) => sum + s.lengthM, 0);
    expect(segmentM).toBeCloseTo(r.distanceM, -1);
    // The elevation profile runs on without restarting at the waypoint. Grade runs and
    // edge lengths disagree by millimetres within one edge already, hence the slack.
    for (let i = 1; i < r.elevationProfile.length; i++)
      expect(r.elevationProfile[i][0]).toBeGreaterThan(
        r.elevationProfile[i - 1][0] - 0.01,
      );
    expect(r.elevationProfile.at(-1)![0]).toBeCloseTo(r.distanceM, 0);
    // A waypoint on the best line barely changes it.
    expect(r.distanceM).toBeGreaterThan(baseline.distanceM * 0.98);
    expect(r.distanceM).toBeLessThan(baseline.distanceM * 1.05);
  }, 60000);

  it("gives each leg its own search budget", async () => {
    const anchors = [start, middle, end];
    const single = route(graph, { anchors, profile }, "reference");
    const budget = Math.ceil(single.metrics.explored * 0.75);
    const comparison = await routeLegs(
      fixture,
      { anchors, profile, maxSettled: budget },
      graph.bbox,
    );
    expect(
      route(graph, { anchors, profile, maxSettled: budget }, "reference")
        .status,
    ).toBe("budget-exceeded");
    expect(comparison.reference.status).toBe("ok");
  }, 60000);

  it("routes only the legs it was not given, and joins the same route", async () => {
    const anchors = [start, middle, end];
    const first = new Map<number, LegComparison>();
    await routeLegs(
      fixture,
      { anchors: anchors.slice(0, 2), profile },
      graph.bbox,
      undefined,
      { onLeg: (leg, value) => first.set(leg, value) },
    );
    let loads = 0;
    const routed: number[] = [];
    const extended = await routeLegs(
      { ...fixture, load: async () => (loads++, graph) },
      { anchors, profile },
      graph.bbox,
      undefined,
      {
        cached: (leg) => first.get(leg),
        onLeg: (leg) => routed.push(leg),
      },
    );
    expect(routed).toEqual([2]);
    expect(loads).toBe(1);
    const fresh = await routeLegs(fixture, { anchors, profile }, graph.bbox);
    expect(extended.exploration!.edgeIds).toEqual(fresh.exploration!.edgeIds);
    expect(extended.exploration!.cost).toBeCloseTo(fresh.exploration!.cost, 6);
  }, 60000);

  it("reports the failing leg numbered across the route", () => {
    const joined = joinLegs(
      [baseline, failed("no-path", 1)],
      [start, middle, end],
    );
    expect(joined.status).toBe("no-path");
    expect(joined.failedLeg).toBe(2);
    expect(joined.geometry).toEqual([]);
    expect(joined.ascentM).toBeNull();
  });

  it("collects missing cells from every leg", () => {
    const joined = joinLegs(
      [
        { ...failed("missing-cells"), missingCells: ["a", "b"] },
        { ...failed("missing-cells"), missingCells: ["b", "c"] },
      ],
      [start, middle, end],
    );
    expect(joined.status).toBe("missing-cells");
    expect(joined.missingCells).toEqual(["a", "b", "c"]);
  });

  it("sums cost components and keeps unknown elevation unknown", () => {
    const unknown = { ...baseline, ascentM: null, descentM: null };
    const joined = joinLegs([baseline, unknown], [start, end, start]);
    const expected = emptyComponents();
    for (const k of Object.keys(expected) as (keyof typeof expected)[])
      expect(joined.components[k]).toBeCloseTo(baseline.components[k] * 2, 6);
    expect(joined.cost).toBeCloseTo(baseline.cost * 2, 6);
    expect(joined.ascentM).toBeNull();
    expect(joined.geometry).toHaveLength(baseline.geometry.length * 2 - 1);
  });
});
