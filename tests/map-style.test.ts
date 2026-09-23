import { expect, it } from "vitest";
import {
  labelLanguage,
  mapStyle,
  osmEditURL,
  outdoorStyle,
  streetViewURL,
  type StyleInputs,
} from "../src/map/style";
import { mapIndexURL, parseMapIndex } from "../src/map/resources";

const ROOT = "https://bucket.example/ibex/";
const resources = parseMapIndex(
  {
    basemap: "basemap/abc.pmtiles",
    cycleRoutes: "cycle-routes/def.pmtiles",
    glyphs: "assets/fonts/{fontstack}/{range}.pbf",
    sprite: "assets/sprites/v4/light",
  },
  ROOT,
);
const inputs: StyleInputs = {
  resources,
  contours: "dem-contour://{z}/{x}/{y}?thresholds=11*100*500",
  lang: "fr",
};
type Painted = { paint: Record<string, unknown> };
const paint = (s: ReturnType<typeof mapStyle>, id: string) =>
  (s.layers.find((l) => l.id === id) as Painted).paint;

it("resolves the basemap index against the data root without escaping templates", () => {
  expect(mapIndexURL(ROOT)).toBe("https://bucket.example/ibex/map.json");
  expect(resources.basemap).toBe("https://bucket.example/ibex/basemap/abc.pmtiles");
  expect(resources.glyphs).toBe(
    "https://bucket.example/ibex/assets/fonts/{fontstack}/{range}.pbf",
  );
  expect(
    parseMapIndex({ ...resources, basemap: "https://other.example/b.pmtiles" }, ROOT)
      .basemap,
  ).toBe("https://other.example/b.pmtiles");
  expect(() => parseMapIndex({ basemap: "b", glyphs: "no-template", sprite: "s" }, ROOT)).toThrow();
});

it("draws everything from the bucket or keyless services", () => {
  for (const basemap of ["outdoor", "satellite", "hybrid"] as const) {
    const text = JSON.stringify(mapStyle(inputs, basemap));
    expect(text).not.toMatch(/maptiler|key=/i);
    const style = mapStyle(inputs, basemap);
    // Every layer must reference a source the style still declares.
    for (const l of style.layers)
      if ("source" in l) expect(style.sources).toHaveProperty(l.source);
  }
  const outdoor = outdoorStyle(inputs);
  expect(outdoor.sources.protomaps).toMatchObject({
    url: "pmtiles://https://bucket.example/ibex/basemap/abc.pmtiles",
  });
  expect(outdoor.sources.terrain).toMatchObject({
    type: "raster-dem",
    encoding: "terrarium",
  });
  expect(outdoor.glyphs).toBe(resources.glyphs);
});

it("starts with relief alone until the basemap index arrives", () => {
  const bare = outdoorStyle({ contours: inputs.contours });
  expect(bare.glyphs).toBeUndefined();
  expect(bare.layers.every((l) => l.type !== "symbol")).toBe(true);
  expect(bare.layers.map((l) => l.id)).toEqual([
    "background",
    "Hillshade",
    "Contour",
    "Contour index",
  ]);
  expect(Object.keys(outdoorStyle({}).sources)).toEqual(["terrain"]);
});

it("lays relief under the roads and cycle routes over them, under the labels", () => {
  const ids = outdoorStyle(inputs).layers.map((l) => l.id);
  const at = (id: string) => {
    expect(ids).toContain(id);
    return ids.indexOf(id);
  };
  expect(at("Hillshade")).toBeLessThan(at("roads_minor"));
  expect(at("roads_highway")).toBeLessThan(at("Tracks"));
  expect(at("Tracks")).toBeLessThan(at("Bicycle longdistance"));
  expect(at("Bicycle longdistance")).toBeLessThan(at("places_locality"));
  expect(at("places_locality")).toBeLessThan(at("Bicycle route labels"));
  const noRoutes = outdoorStyle({ ...inputs, resources: { ...resources, cycleRoutes: undefined } });
  expect(noRoutes.layers.some((l) => l.id.startsWith("Bicycle"))).toBe(false);
});

it("builds satellite and hybrid basemaps from keyless imagery", () => {
  const satellite = mapStyle(inputs, "satellite");
  expect(satellite.layers.map((l) => l.id)).toEqual([
    "Satellite",
    "Satellite France",
    "Satellite Switzerland",
  ]);
  for (const id of ["imagery-satellite-france", "imagery-satellite-switzerland"])
    expect(satellite.sources[id]).toHaveProperty("bounds");
  const hybrid = mapStyle(inputs, "hybrid");
  expect(hybrid.layers[0].id).toBe("Satellite");
  const ids = hybrid.layers.map((l) => l.id);
  expect(ids).toContain("roads_minor");
  expect(ids).toContain("places_locality");
  expect(ids).toContain("Bicycle longdistance");
  expect(ids).not.toContain("Hillshade");
  expect(ids).not.toContain("Contour");
  expect(ids.some((id) => id.includes("casing") && id.startsWith("roads_"))).toBe(false);
  expect(hybrid.layers.every((l) => l.type !== "fill")).toBe(true);
  // Trail casings go dark on imagery; the outdoor style keeps them white.
  const outdoor = mapStyle(inputs, "outdoor");
  expect(paint(hybrid, "Bicycle outline")["line-color"]).toMatch(/^hsla\(0, 0%, 8%/);
  expect(paint(outdoor, "Bicycle outline")["line-color"]).toContain("100%");
  // Roads go grey on imagery; labels flip to light text on a dark halo.
  expect(paint(hybrid, "roads_minor")["line-color"]).not.toEqual(
    paint(outdoor, "roads_minor")["line-color"],
  );
  const town = paint(hybrid, "places_locality");
  expect(town["text-halo-color"]).toMatch(/^hsla\(0, 0%, 8%/);
  expect(JSON.stringify(town["text-color"])).toMatch(/hsl\(0, 0%, 96%\)/);
});

it("labels in the reader's language where Protomaps has it", () => {
  expect(labelLanguage("fr-CH")).toBe("fr");
  expect(labelLanguage("zh-Hant")).toBe("zh-Hant");
  expect(labelLanguage("rm")).toBe("en");
  expect(labelLanguage(undefined)).toBe("en");
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
