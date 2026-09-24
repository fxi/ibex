import { describe, expect, it } from "vitest";
import { parseGPX } from "../src/importers/gpx";

const gpx = (body: string, name = "Morning ride") =>
  `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>${body}</trkseg></trk></gpx>`;

const pt = (lon: number, lat: number, ele?: number) =>
  `<trkpt lat="${lat}" lon="${lon}">${ele === undefined ? "" : `<ele>${ele}</ele>`}</trkpt>`;

describe("GPX import", () => {
  it("reads points, name, distance and elevation", () => {
    const track = parseGPX(
      gpx(pt(6.1, 46.2, 400) + pt(6.11, 46.2, 450) + pt(6.12, 46.2, 420)),
    );
    expect(track.name).toBe("Morning ride");
    expect(track.geometry).toHaveLength(3);
    expect(track.geometry[0]).toEqual([6.1, 46.2]);
    // ~770 m per 0.01° of longitude at this latitude.
    expect(track.distanceM).toBeGreaterThan(1400);
    expect(track.distanceM).toBeLessThan(1600);
    expect(track.ascentM).toBe(50);
    expect(track.descentM).toBe(30);
    expect(track.elevationProfile[0]).toEqual([0, 400]);
    expect(track.elevationProfile.at(-1)?.[1]).toBe(420);
  });

  it("keeps the elevation profile aligned with cumulative distance", () => {
    const track = parseGPX(gpx(pt(6.1, 46.2, 10) + pt(6.2, 46.2, 20)));
    expect(track.elevationProfile).toHaveLength(track.geometry.length);
    expect(track.elevationProfile.at(-1)?.[0]).toBeCloseTo(track.distanceM, 6);
  });

  it("reports no ascent when elevation is missing anywhere", () => {
    const track = parseGPX(gpx(pt(6.1, 46.2, 400) + pt(6.11, 46.2)));
    expect(track.ascentM).toBeNull();
    expect(track.descentM).toBeNull();
    expect(track.elevationProfile[1][1]).toBeNull();
  });

  it("ignores elevation noise below the threshold", () => {
    const track = parseGPX(
      gpx(pt(6.1, 46.2, 400) + pt(6.11, 46.2, 401) + pt(6.12, 46.2, 400)),
    );
    expect(track.ascentM).toBe(0);
    expect(track.descentM).toBe(0);
  });

  it("accepts route points as well as track points", () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte><name>Planned</name><rtept lat="46.2" lon="6.1"/><rtept lat="46.2" lon="6.2"/></rte></gpx>`;
    const track = parseGPX(xml);
    expect(track.name).toBe("Planned");
    expect(track.geometry).toHaveLength(2);
  });

  it("skips unusable coordinates rather than failing the whole file", () => {
    const track = parseGPX(
      gpx(
        pt(6.1, 46.2) +
          `<trkpt lat="not-a-number" lon="6.11"/>` +
          `<trkpt lat="200" lon="6.12"/>` +
          pt(6.13, 46.2),
      ),
    );
    expect(track.geometry).toHaveLength(2);
  });

  it("falls back to the supplied name when the file has none", () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${pt(6.1, 46.2)}${pt(6.2, 46.2)}</trkseg></trk></gpx>`;
    expect(parseGPX(xml, "from-file").name).toBe("from-file");
  });

  it("rejects files that are not GPX, or hold no points", () => {
    expect(() => parseGPX("<html><body/></html>")).toThrow(/not a GPX/);
    expect(() => parseGPX("")).toThrow(/not a GPX/);
    expect(() => parseGPX(gpx(pt(6.1, 46.2)))).toThrow(/no track points/);

  });
});

describe("GPX round trip", () => {
  it("re-imports an exported route without drifting", async () => {
    const { exportGPX } = await import("../src/gpx");
    // Parse first, so the profile distances are the ones this geometry actually has
    // rather than hand-computed numbers that could disagree with the export.
    const source = parseGPX(
      gpx(pt(6.1, 46.2, 400) + pt(6.11, 46.2, 450) + pt(6.12, 46.205, 420)),
      "Round trip",
    );
    const xml = exportGPX(
      {
        geometry: source.geometry,
        elevationProfile: source.elevationProfile,
      } as never,
      "Round trip",
    );
    const back = parseGPX(xml);
    expect(back.name).toBe("Round trip");
    expect(back.geometry).toEqual(source.geometry);
    expect(back.elevationProfile.map((e) => e[1])).toEqual([400, 450, 420]);
    expect(back.distanceM).toBeCloseTo(source.distanceM, 6);
  });

  const exported = async (plan?: {
    waypoints: [number, number][];
    profileId: string;
  }) => {
    const { exportGPX } = await import("../src/gpx");
    const source = parseGPX(gpx(pt(6.1, 46.2, 400) + pt(6.12, 46.205, 420)));
    return exportGPX(
      {
        geometry: source.geometry,
        elevationProfile: source.elevationProfile,
      } as never,
      "Planned",
      [{ id: "n", kind: "manual", point: [6.11, 46.2], text: "Café" }],
      plan,
    );
  };

  it("brings back the waypoints and profile a planned track was drawn through", async () => {
    // Waypoints need not lie on the line: they are where the rider clicked.
    const waypoints: [number, number][] = [
      [6.1, 46.2],
      [6.1101, 46.2003],
      [6.12, 46.205],
    ];
    const xml = await exported({ waypoints, profileId: "a&b" });
    // Kept where a device does not look, so it shows no extra places along the course.
    expect(xml.match(/<wpt\b/g)).toHaveLength(1);
    expect(xml).toMatch(/<\/trk><extensions><ibex:plan/);
    expect(parseGPX(xml).plan).toEqual({ waypoints, profileId: "a&b" });
  });

  it("says nothing of a plan it was not given, or one with no route in it", async () => {
    const plain = await exported();
    expect(plain).not.toContain("extensions");
    expect(parseGPX(plain).plan).toBeUndefined();
    const single = await exported({ waypoints: [[6.1, 46.2]], profileId: "x" });
    expect(parseGPX(single).plan).toBeUndefined();
  });
});
