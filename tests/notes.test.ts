import { afterEach, describe, expect, it, vi } from "vitest";
import { distance } from "../src/geo/distance";
import { RouteIndex } from "../src/notes/routeIndex";
import { circleSpans, routeChunks, simplify } from "../src/notes/corridor";
import { thin, type Located } from "../src/notes/density";
import {
  fetchPlaces,
  overpassQuery,
  parsePlaces,
  placeKind,
} from "../src/notes/overpass";
import { findPlaces, mergePlaces } from "../src/notes/search";
import type { Note } from "../src/notes/types";
import { exportGPX } from "../src/gpx";
import { newTrack, restoreCollection } from "../src/tracks";
import type { Point, RouteResult } from "../src/routing/types";

const LAT = 46;
/** Degrees of longitude per metre along the parallel the test route follows. */
const DEG_PER_M = 1 / distance([0, LAT], [1, LAT]);
/** A straight route east along 46°N, one vertex every 100 m. */
function straight(lengthM: number): Point[] {
  return Array.from({ length: lengthM / 100 + 1 }, (_, i) => [
    6 + i * 100 * DEG_PER_M,
    LAT,
  ]);
}
/** A point `m` along the straight route and `offsetM` north of it. */
const beside = (m: number, offsetM = 0): Point => [
  6 + m * DEG_PER_M,
  LAT + offsetM / 111_320,
];
const place = (
  osm: string,
  kind: Located["kind"],
  m: number,
  offsetM: number,
): Located => ({ osm, kind, point: beside(m, offsetM), m, offsetM });

describe("route index", () => {
  const index = new RouteIndex(straight(30_000));

  it("finds where a point sits along the route, and how far off it is", () => {
    const at = index.locate(beside(12_345, 200), 500)!;
    expect(at.m).toBeCloseTo(12_345, -1);
    expect(at.offsetM).toBeCloseTo(200, -1);
    expect(index.locate(beside(12_345, 800), 500)).toBeUndefined();
  });

  it("rescales to the route's own length", () => {
    const scaled = new RouteIndex(straight(10_000), 11_000);
    expect(scaled.lengthM).toBeCloseTo(11_000, 6);
    expect(scaled.locate(beside(5000), 50)!.m).toBeCloseTo(5500, -1);
  });

  it("slices a stretch with interpolated ends", () => {
    const line = index.slice(1050, 2050);
    expect(distance(line[0], beside(1050))).toBeLessThan(1);
    expect(distance(line.at(-1)!, beside(2050))).toBeLessThan(1);
    expect(line).toHaveLength(12);
  });
});

describe("corridor", () => {
  const index = new RouteIndex(straight(30_000));

  it("keeps only the stretch a circle crosses, padded", () => {
    const spans = circleSpans(index, beside(15_000, 3000), 5000, 500);
    expect(spans).toHaveLength(1);
    // The circle crosses the line 4 km either side of its foot, to the nearest segment.
    expect(Math.abs(spans[0][0] - 10_500)).toBeLessThan(101);
    expect(Math.abs(spans[0][1] - 19_500)).toBeLessThan(101);
    expect(circleSpans(index, beside(15_000, 6000), 5000)).toEqual([]);
  });

  it("cuts a long route into chunks and simplifies each", () => {
    const chunks = routeChunks(index, [[0, index.lengthM]], 25_000, 100);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].toM).toBeCloseTo(index.lengthM, 6);
    // A straight line needs only its two ends.
    expect(chunks[0].line).toHaveLength(2);
  });

  it("keeps a corner that departs by more than the tolerance", () => {
    const corner: Point[] = [beside(0), beside(500, 300), beside(1000)];
    expect(simplify(corner, 100)).toHaveLength(3);
    expect(simplify(corner, 400)).toHaveLength(2);
  });
});

describe("density", () => {
  it("keeps the place closest to the route in each kilometre", () => {
    const kept = thin(
      [
        place("node/1", "food", 100, 300),
        place("node/2", "supermarket", 600, 40),
        place("node/3", "food", 1500, 10),
      ],
      [[0, 2000]],
    );
    expect(kept.map((p) => p.osm)).toEqual(["node/2", "node/3"]);
  });

  it("brings water back wherever kept water would be too far apart", () => {
    const places: Located[] = [];
    // A café right on the road every kilometre beats any water point in its bin.
    for (let km = 0; km < 30; km++)
      places.push(place(`node/c${km}`, "food", km * 1000 + 500, 5));
    for (const km of [3, 4, 5, 12, 13, 16, 25])
      places.push(place(`node/w${km}`, "water", km * 1000 + 200, 100));
    const kept = thin(places, [[0, 30_000]]);
    const water = kept.filter((p) => p.kind === "water").map((p) => p.m);
    const edges = [0, ...water, 30_000];
    for (let i = 1; i < edges.length; i++)
      expect(edges[i] - edges[i - 1]).toBeLessThanOrEqual(10_000);
    // The protection adds only what the gaps need: four of the seven.
    expect(water).toHaveLength(4);
  });

  it("drops duplicates found by two neighbouring queries", () => {
    const kept = thin(
      [place("node/1", "water", 100, 20), place("node/1", "water", 100, 20)],
      [[0, 1000]],
    );
    expect(kept).toHaveLength(1);
  });
});

describe("Overpass", () => {
  it("counts a fountain as water only when it is drinkable", () => {
    expect(placeKind({ amenity: "drinking_water" })).toBe("water");
    expect(placeKind({ amenity: "fountain" })).toBeUndefined();
    expect(placeKind({ amenity: "fountain", drinking_water: "yes" })).toBe(
      "water",
    );
    expect(placeKind({ man_made: "water_tap" })).toBeUndefined();
    expect(placeKind({ shop: "bakery" })).toBe("food");
    expect(placeKind({ shop: "convenience" })).toBe("supermarket");
    expect(placeKind({ shop: "bakery", access: "private" })).toBeUndefined();
  });

  it("reads nodes and way centres, and ignores what offers nothing", () => {
    const places = parsePlaces({
      elements: [
        {
          type: "node",
          id: 1,
          lat: 46.2,
          lon: 6.1,
          tags: { amenity: "drinking_water" },
        },
        {
          type: "way",
          id: 2,
          center: { lat: 46.3, lon: 6.2 },
          tags: {
            shop: "supermarket",
            name: "Coop",
            opening_hours: "Mo-Sa 08:00-19:00",
          },
        },
        {
          type: "node",
          id: 3,
          lat: 46.2,
          lon: 6.1,
          tags: { amenity: "fountain", drinking_water: "no" },
        },
      ],
    });
    expect(places).toEqual([
      { osm: "node/1", kind: "water", point: [6.1, 46.2] },
      {
        osm: "way/2",
        kind: "supermarket",
        point: [6.2, 46.3],
        name: "Coop",
        hours: "Mo-Sa 08:00-19:00",
      },
    ]);
  });

  it("refuses an answer the server cut short", () => {
    expect(() =>
      parsePlaces({ remark: "runtime error: Query timed out", elements: [] }),
    ).toThrow(/timed out/);
  });

  it("asks once along the line, latitude first", () => {
    const query = overpassQuery(
      [
        [6.123456, 46.5],
        [6.2, 46.6],
      ],
      520,
    );
    expect(query).toContain("nwr(around:520,46.5,6.12346,46.6,6.2)");
    expect(query).toContain("out center tags;");
  });

  describe("retries", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it("asks again while the server is busy", async () => {
      vi.useFakeTimers();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response("busy", { status: 504 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ elements: [] }), { status: 200 }),
        );
      vi.stubGlobal("fetch", fetch);
      const pending = fetchPlaces(straight(200), 500);
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("gives up at once on a bad request", async () => {
      const fetch = vi
        .fn()
        .mockResolvedValue(new Response("bad", { status: 400 }));
      vi.stubGlobal("fetch", fetch);
      await expect(fetchPlaces(straight(200), 500)).rejects.toThrow(/400/);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});

describe("a search along a long route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps what answered when one stretch never does", async () => {
    vi.useFakeTimers();
    const index = new RouteIndex(straight(100_000));
    // Answer only for queries starting near the route's start; the rest are refused as busy.
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const data = new URLSearchParams(String(init.body)).get("data")!;
      const lon = Number(/around:\d+,[\d.]+,([\d.]+)/.exec(data)![1]);
      if (lon > 6.01) return new Response("busy", { status: 504 });
      const [x, y] = beside(1000, 20);
      const elements = [
        { type: "node", id: 1, lat: y, lon: x, tags: { shop: "bakery" } },
      ];
      return new Response(JSON.stringify({ elements }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const pending = findPlaces({
      index,
      spans: [[0, index.lengthM]],
      bufferM: 500,
    });
    await vi.runAllTimersAsync();
    const { places, covered, failed } = await pending;
    expect(places.map((p) => p.osm)).toEqual(["node/1"]);
    expect(covered).toHaveLength(1);
    expect(covered[0][0]).toBe(0);
    expect(failed).toBe(2);
  });
});

describe("notes on a track", () => {
  const index = new RouteIndex(straight(30_000));
  const manual: Note = {
    id: "a",
    kind: "manual",
    point: beside(5000),
    text: "Lunch",
  };
  const inside: Note = {
    id: "node/1",
    kind: "water",
    point: beside(5000, 50),
    text: "",
    osm: "node/1",
  };
  const outside: Note = {
    ...inside,
    id: "node/2",
    osm: "node/2",
    point: beside(20_000),
  };

  it("replaces the places a search covered and keeps everything else", () => {
    const merged = mergePlaces(
      [manual, inside, outside],
      [place("node/3", "food", 6000, 30)],
      index,
      [[0, 10_000]],
      500,
    );
    expect(merged.map((n) => n.id)).toEqual(["a", "node/2", "node/3"]);
  });

  it("restores tracks saved before notes existed", () => {
    const { notes: _, ...old } = newTrack();
    const restored = restoreCollection({ version: 1, tracks: [old] });
    expect(restored.tracks[0].notes).toEqual([]);
  });

  it("exports notes as GPX waypoints ahead of the track", () => {
    const route = {
      geometry: straight(200),
      elevationProfile: [],
    } as unknown as RouteResult;
    const gpx = exportGPX(route, "Ride", [
      manual,
      { ...inside, hours: "24/7 & more" },
    ]);
    expect(gpx).toMatch(/<wpt lat="46" lon="[\d.]+"><name>Lunch<\/name>/);
    expect(gpx).toContain(
      "<name>Drinking water</name><desc>24/7 &amp; more</desc><type>water</type>",
    );
    expect(gpx.indexOf("<wpt")).toBeLessThan(gpx.indexOf("<trk>"));
  });
});
