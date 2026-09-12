import { describe, expect, it } from "vitest";
import { distance, route } from "../src/routing/engine";
import { rideClass } from "../src/routing/eligibility";
import type { Edge, Graph, Point, RouteResult } from "../src/routing/types";
import type { Profile } from "../src/routing/profiles";
import { TRAIL, withPermissions } from "./helpers";

const points: Point[] = [
  [6.1, 46.2],
  [6.11, 46.2],
  [6.12, 46.2],
  [6.13, 46.2],
];

/** A permissive profile: these tests are about how a route is described, not chosen. */
const profile = (overrides: Partial<Profile> = {}): Profile => ({
  ...withPermissions(TRAIL, { ferry: true, stairs: true, push: true }),
  ...overrides,
});

function edge(from: number, to: number, overrides: Partial<Edge> = {}): Edge {
  const length = distance(points[from], points[to]);
  return {
    id: from * 2 + (from > to ? 1 : 0),
    from,
    to,
    way: String(Math.min(from, to)),
    length,
    geometry: [points[from], points[to]],
    grades: [[length, 0]],
    surface: "asphalt",
    highway: "cycleway",
    tags: {},
    stress: 0.1,
    uncertainty: 0.1,
    utility: 0.7,
    urban: 0,
    cyclingNetwork: 0,
    bridge: false,
    tunnel: false,
    name: "",
    tile: "",
    ...overrides,
  };
}

/** A straight chain of edges, each traversable in both directions. */
function chain(...specs: Partial<Edge>[]): Graph {
  const edges: Edge[] = [];
  specs.forEach((spec, i) => {
    edges.push(edge(i, i + 1, spec), edge(i + 1, i, spec));
  });
  return {
    schemaVersion: 1,
    bbox: [5.8, 45.95, 6.55, 46.45],
    nodes: points.map((p, id) => ({ id, p, elevation: 400 })),
    restrictions: [],
    edges,
  };
}

const run = (graph: Graph, p = profile()): RouteResult =>
  route(
    graph,
    { anchors: [points[0], points[points.length - 1]], profile: p },
    "reference",
  );

describe("route segments", () => {
  it("classifies a uniform paved route as one segment covering it", () => {
    const result = run(chain({}, {}, {}));
    expect(result.status).toBe("ok");
    expect(result.segments.every((s) => s.ride === "paved")).toBe(true);
    expect(result.segments[0].start).toBe(0);
    expect(result.segments.at(-1)!.end).toBe(result.geometry.length - 1);
  });

  it("splits where the surface changes", () => {
    const result = run(
      chain(
        {},
        { surface: "gravel" },
        { surface: "dirt", highway: "path", tags: { sac_scale: "hiking" } },
      ),
    );
    expect(result.status).toBe("ok");
    expect(result.segments.map((s) => s.ride)).toEqual([
      "paved",
      "gravel",
      "rough",
    ]);
    expect(result.segments[2].sac).toBe("hiking");
    expect(result.segments[2].surface).toBe("dirt");
    expect(result.segments[2].highway).toBe("path");
  });

  it("marks a hike-a-bike stretch as walking", () => {
    const result = run(
      chain({}, { highway: "steps", surface: "ground" }, {}),
      profile(),
    );
    expect(result.status).toBe("ok");
    expect(result.segments.map((s) => s.ride)).toContain("walk");
    // The walking distance the result reports and the walking segments must agree.
    const walked = result.segments
      .filter((s) => s.ride === "walk")
      .reduce((sum, s) => sum + s.lengthM, 0);
    expect(walked).toBeCloseTo(result.hikeABikeM, 0);
  });

  it("marks a ferry crossing", () => {
    const result = run(chain({}, { highway: "ferry", surface: "water" }, {}));
    expect(result.status).toBe("ok");
    expect(result.segments.map((s) => s.ride)).toContain("ferry");
    const ferried = result.segments
      .filter((s) => s.ride === "ferry")
      .reduce((sum, s) => sum + s.lengthM, 0);
    expect(ferried).toBeCloseTo(result.ferryM, 0);
  });

  it("keeps segments contiguous and covering the whole geometry", () => {
    const result = run(
      chain({}, { surface: "gravel" }, { surface: "dirt", highway: "track" }),
    );
    expect(result.segments[0].start).toBe(0);
    for (const s of result.segments) expect(s.end).toBeGreaterThan(s.start);
    for (let i = 1; i < result.segments.length; i++)
      // Segments share a vertex rather than leaving or repeating a gap.
      expect(result.segments[i].start).toBe(result.segments[i - 1].end);
    expect(result.segments.at(-1)!.end).toBe(result.geometry.length - 1);
  });

  it("conserves length across the segments", () => {
    const result = run(
      chain({}, { surface: "gravel" }, { surface: "dirt", highway: "track" }),
    );
    const total = result.segments.reduce((sum, s) => sum + s.lengthM, 0);
    // Segment lengths are straight-line spans; the route distance is the builder's own
    // edge lengths, so they agree to within a metre per edge rather than exactly.
    expect(total).toBeCloseTo(result.distanceM, -1);
  });

  it("carries the grade of the stretch it describes", () => {
    const graph = chain({}, {}, {});
    for (const e of graph.edges)
      e.grades = [[e.length, e.from < e.to ? 0.08 : -0.08]];
    const result = run(graph);
    expect(result.segments.every((s) => s.grade !== null)).toBe(true);
    expect(result.segments[0].grade).toBeCloseTo(0.08, 5);
  });

  it("reports a null grade where elevation is unknown", () => {
    const graph = chain({}, {}, {});
    for (const e of graph.edges) e.grades = null;
    const result = run(graph);
    expect(result.segments.every((s) => s.grade === null)).toBe(true);
  });

  it("indexes into the geometry it was produced with", () => {
    const result = run(chain({}, { surface: "gravel" }, {}));
    for (const s of result.segments) {
      expect(result.geometry[s.start]).toBeDefined();
      expect(result.geometry[s.end]).toBeDefined();
    }
  });
});

describe("ride classification", () => {
  const base = edge(0, 1);
  it("separates paved, gravel and rough surfaces", () => {
    expect(rideClass({ ...base, surface: "asphalt" }, "ride")).toBe("paved");
    expect(rideClass({ ...base, surface: "compacted" }, "ride")).toBe("gravel");
    expect(rideClass({ ...base, surface: "dirt" }, "ride")).toBe("rough");
  });
  it("puts mode ahead of surface", () => {
    expect(rideClass({ ...base, surface: "asphalt" }, "walk")).toBe("walk");
    expect(rideClass({ ...base, surface: "asphalt" }, "ferry")).toBe("ferry");
    expect(rideClass({ ...base, surface: "asphalt" }, "blocked")).toBe("walk");
  });
  it("treats a ferry way as a ferry however it is traversed", () => {
    expect(rideClass({ ...base, highway: "ferry" }, "ride")).toBe("ferry");
  });
  it("reads an untagged surface off the hierarchy instead of calling it rough", () => {
    const untagged = { ...base, surface: "unknown" };
    // Three quarters of ways carry no surface tag. A street with none is sealed until
    // something says otherwise; calling it rough put broken ground over ordinary tarmac.
    expect(rideClass({ ...untagged, highway: "residential" }, "ride")).toBe(
      "paved",
    );
    expect(rideClass({ ...untagged, highway: "tertiary" }, "ride")).toBe(
      "paved",
    );
    // A track is unsurfaced by definition, and its tracktype grades how badly.
    expect(rideClass({ ...untagged, highway: "track" }, "ride")).toBe("gravel");
    expect(
      rideClass(
        { ...untagged, highway: "track", tags: { tracktype: "grade2" } },
        "ride",
      ),
    ).toBe("gravel");
    expect(
      rideClass(
        { ...untagged, highway: "track", tags: { tracktype: "grade5" } },
        "ride",
      ),
    ).toBe("rough");
    // A path with nothing at all to go on claims nothing.
    expect(rideClass({ ...untagged, highway: "path" }, "ride")).toBe("unknown");
  });
});
