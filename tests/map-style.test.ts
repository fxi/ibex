import { expect, it, afterEach } from "vitest";
import {
  customMapStyle,
  mapResourceURL,
  mapStyle,
  osmEditURL,
  streetViewURL,
} from "../src/map/style";
import { mapTilerKey } from "../scripts/local-env";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true });
});
it("always returns the bundled style and safely authenticates its resources", () => {
  for (const key of [undefined, "", "   ", " test+key&value "]) {
    const style = customMapStyle(key);
    expect(style.layers.length).toBeGreaterThan(100);
    expect(style.sources).toHaveProperty("maptiler_planet");
    expect(JSON.stringify(style)).not.toContain("key=undefined");
    expect(JSON.stringify(style)).not.toContain("INSERT_YOUR_OWN_API_KEY");
  }
  const style = customMapStyle(" test+key&value ");
  const resource = mapResourceURL(style.sprite as string, " test+key&value ");
  expect(new URL(resource).searchParams.get("key")).toBe("test+key&value");
  expect(mapResourceURL("https://example.com/tile?x=1", "key")).toBe(
    "https://example.com/tile?x=1",
  );
  expect(customMapStyle("").glyphs).not.toContain("test");
});
it("builds satellite and hybrid basemaps from the bundled style", () => {
  expect(mapStyle("k", "outdoor")).toEqual(customMapStyle("k"));
  const satellite = mapStyle("k", "satellite");
  expect(satellite.layers.map((l) => l.id)).toEqual(["Satellite"]);
  expect(satellite.sources.satellite).toMatchObject({ type: "raster" });
  const hybrid = mapStyle("k", "hybrid");
  expect(hybrid.layers[0].id).toBe("Satellite");
  const ids = hybrid.layers.map((l) => l.id);
  expect(ids).toContain("Road network");
  expect(ids).toContain("Place labels");
  expect(ids).not.toContain("Hillshade");
  expect(ids).not.toContain("Contour");
  expect(hybrid.layers.every((l) => l.type !== "fill")).toBe(true);
  // Trail casings go dark on imagery; the outdoor style keeps them white.
  const casing = (s: typeof hybrid) =>
    s.layers.find((l) => l.id === "Bicycle outline") as {
      paint: Record<string, unknown>;
    };
  expect(casing(hybrid).paint["line-color"]).toMatch(/^hsla\(0, 0%, 8%/);
  expect(casing(mapStyle("k", "outdoor")).paint["line-color"]).toContain(
    "100%",
  );
  // Large roads recede in both styles; hybrid labels flip to light text on a dark halo.
  const paint = (s: typeof hybrid, id: string) =>
    (s.layers.find((l) => l.id === id) as { paint: Record<string, unknown> })
      .paint;
  const outdoor = mapStyle("k", "outdoor");
  expect(JSON.stringify(paint(outdoor, "Road network")["line-color"])).toContain(
    "motorway",
  );
  expect(paint(hybrid, "Road network")["line-color"]).not.toEqual(
    paint(outdoor, "Road network")["line-color"],
  );
  const town = paint(hybrid, "Town labels");
  expect(town["text-halo-color"]).toMatch(/^hsla\(0, 0%, 8%/);
  expect(town["text-color"]).toBe("hsl(240, 6%, 96%)");
  expect(paint(outdoor, "Town labels")["text-color"]).toBe("hsl(240, 6%, 13%)");
  // Every layer must reference a source the style still declares.
  for (const l of hybrid.layers)
    if ("source" in l) expect(hybrid.sources).toHaveProperty(l.source);
  expect(JSON.stringify(hybrid)).not.toContain("INSERT_YOUR_OWN_API_KEY");
});
it("opens Street View at a map point", () => {
  const url = new URL(streetViewURL([6.2051234567, 46.19]));
  expect(url.searchParams.get("map_action")).toBe("pano");
  expect(url.searchParams.get("viewpoint")).toBe("46.190000,6.205123");
});
it("opens the OSM editor at a map point, never below an editable zoom", () => {
  expect(osmEditURL([6.1065051234, 46.064938], 12.4)).toBe(
    "https://www.openstreetmap.org/edit#map=17/46.064938/6.106505",
  );
  expect(osmEditURL([6.1, 46.1], 18.6)).toBe(
    "https://www.openstreetmap.org/edit#map=19/46.100000/6.100000",
  );
});
it("reads only the specified local dotenv file without expansion or ambient fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyclatractor-env-"));
  directories.push(dir);
  const file = pathToFileURL(join(dir, ".env"));
  const previous = process.env.VITE_MAPTILER_API_KEY;
  process.env.VITE_MAPTILER_API_KEY = "global-secret-reference";
  try {
    expect(mapTilerKey(file)).toBe("");
    writeFileSync(file, "OTHER=value\n");
    expect(mapTilerKey(file)).toBe("");
    writeFileSync(file, "VITE_MAPTILER_API_KEY=   \n");
    expect(mapTilerKey(file)).toBe("");
    writeFileSync(
      file,
      'export VITE_MAPTILER_API_KEY = " local+key&value " # comment\n',
    );
    expect(mapTilerKey(file)).toBe("local+key&value");
    writeFileSync(file, 'VITE_MAPTILER_API_KEY="${GLOBAL_KEY}"\n');
    expect(mapTilerKey(file)).toBe("${GLOBAL_KEY}");
  } finally {
    if (previous === undefined) delete process.env.VITE_MAPTILER_API_KEY;
    else process.env.VITE_MAPTILER_API_KEY = previous;
  }
});
