import { describe, expect, it } from "vitest";
import type { BBox } from "../src/geo/grid";
import type { Installed } from "../src/offline/store";
import {
  LegCache,
  assembleLegs,
  legData,
  legKey,
  legKeys,
  missingLegs,
} from "../src/routing/legCache";
import type { LegComparison } from "../src/routing/legs";
import type { Point, RouteResult } from "../src/routing/types";
import { GRAVEL, ROAD } from "./helpers";

const pack = (id: string, version: string) =>
  ({ manifest: { id, version } }) as unknown as Installed;
const cells: { id: string; bbox: BBox }[] = [
  { id: "9-1-1", bbox: [6, 46, 6.5, 46.5] },
  { id: "9-2-1", bbox: [6.5, 46, 7, 46.5] },
];
const packs = [pack("9-1-1", "a"), pack("9-2-1", "b")];
const anchors: Point[] = [
  [6.1, 46.1],
  [6.2, 46.2],
  [6.3, 46.1],
  [6.4, 46.2],
];

/** A leg whose route is only its status and endpoints: enough to plan and join. */
function leg(status: RouteResult["status"], from: Point, to: Point) {
  const route = {
    status,
    mode: "reference",
    geometry: status === "ok" ? [from, to] : [],
    anchors: [from, to],
    cost: 1,
    components: { travel: 1 },
    distanceM: 1000,
    hikeABikeM: 0,
    ferryM: 0,
    ascentM: 0,
    descentM: 0,
    elevationProfile: [],
    edgeIds: [],
    segments: [],
    surfaceM: {},
    uncertainM: 0,
    metrics: { durationMs: 0, explored: 0, expansions: 0, tiles: 0 },
  } as unknown as RouteResult;
  return {
    reference: route,
    corridor: route,
    selected: route,
    relativeCost: 0,
    fieldView: { type: "FeatureCollection", features: [] },
  } as LegComparison;
}

describe("leg keys", () => {
  const data = legData("r1", packs, cells, [6, 46, 6.4, 46.4]);

  it("depends only on the installed cells under the leg", () => {
    expect(data).toBe("r1|9-1-1@a");
    expect(
      legData(
        "r1",
        [pack("9-1-1", "a"), pack("9-2-1", "c")],
        cells,
        [6, 46, 6.4, 46.4],
      ),
    ).toBe(data);
    expect(
      legData(
        "r1",
        [pack("9-1-1", "b"), pack("9-2-1", "b")],
        cells,
        [6, 46, 6.4, 46.4],
      ),
    ).not.toBe(data);
    expect(legData("r2", packs, cells, [6, 46, 6.4, 46.4])).not.toBe(data);
  });

  it("changes with a waypoint, the profile, or the data", () => {
    const base = legKey({ profile: GRAVEL }, anchors[0], anchors[1], data);
    expect(legKey({ profile: GRAVEL }, anchors[0], anchors[1], data)).toBe(
      base,
    );
    expect(legKey({ profile: GRAVEL }, anchors[1], anchors[0], data)).not.toBe(
      base,
    );
    expect(legKey({ profile: ROAD }, anchors[0], anchors[1], data)).not.toBe(
      base,
    );
    expect(
      legKey({ profile: GRAVEL }, anchors[0], anchors[1], `${data}x`),
    ).not.toBe(base);
  });
});

describe("planning a recompute", () => {
  const request = { anchors, profile: GRAVEL };
  const warm = () => {
    const cache = new LegCache<LegComparison>();
    const keys = legKeys(request, "r1", packs, cells);
    keys.forEach((k, i) => cache.set(k, leg("ok", anchors[i], anchors[i + 1])));
    return cache;
  };

  it("routes only the new leg when a waypoint is appended", () => {
    const cache = warm();
    const next = { ...request, anchors: [...anchors, [6.45, 46.3] as Point] };
    expect(missingLegs(legKeys(next, "r1", packs, cells), cache)).toEqual([4]);
  });

  it("routes the two legs that meet at a moved waypoint", () => {
    const cache = warm();
    const moved = anchors.map((p, i) =>
      i === 2 ? [6.31, 46.11] : p,
    ) as Point[];
    expect(
      missingLegs(
        legKeys({ ...request, anchors: moved }, "r1", packs, cells),
        cache,
      ),
    ).toEqual([2, 3]);
  });

  it("routes the two halves of a split leg when a waypoint is inserted", () => {
    const cache = warm();
    const inserted = [...anchors];
    inserted.splice(2, 0, [6.25, 46.15]);
    expect(
      missingLegs(
        legKeys({ ...request, anchors: inserted }, "r1", packs, cells),
        cache,
      ),
    ).toEqual([2, 3]);
  });

  it("routes nothing again when only the far end of the route is removed", () => {
    const cache = warm();
    expect(
      missingLegs(
        legKeys(
          { ...request, anchors: anchors.slice(0, 3) },
          "r1",
          packs,
          cells,
        ),
        cache,
      ),
    ).toEqual([]);
  });
});

describe("leg cache", () => {
  it("evicts the least recently used leg", () => {
    const cache = new LegCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.size).toBe(2);
  });
});

describe("assembling a route from legs", () => {
  const keys = ["k1", "k2", "k3"];

  it("joins cached and freshly routed legs in order", () => {
    const cache = new LegCache<LegComparison>();
    cache.set("k1", leg("ok", anchors[0], anchors[1]));
    cache.set("k3", leg("ok", anchors[2], anchors[3]));
    const routed = new Map([[2, leg("ok", anchors[1], anchors[2])]]);
    const value = assembleLegs(keys, anchors, cache, routed)!;
    expect(value.selected!.status).toBe("ok");
    expect(value.selected!.geometry).toEqual(anchors);
    expect(value.selected!.distanceM).toBe(3000);
  });

  it("ends the route at a failed leg", () => {
    const cache = new LegCache<LegComparison>();
    cache.set("k1", leg("ok", anchors[0], anchors[1]));
    const routed = new Map([
      [2, leg("budget-exceeded", anchors[1], anchors[2])],
    ]);
    const value = assembleLegs(keys, anchors, cache, routed)!;
    expect(value.selected!.status).toBe("budget-exceeded");
  });

  it("makes no route when a leg never arrived", () => {
    const cache = new LegCache<LegComparison>();
    cache.set("k1", leg("ok", anchors[0], anchors[1]));
    cache.set("k3", leg("ok", anchors[2], anchors[3]));
    expect(assembleLegs(keys, anchors, cache, new Map())).toBeUndefined();
  });
});
