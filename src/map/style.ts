import type { StyleSpecification } from "maplibre-gl";
export const CUSTOM_STYLE_URL =
  "https://api.maptiler.com/maps/01984598-44d5-70a4-b028-6ce2d6f3027a/style.json";

/** Sprite URLs in downloaded styles may omit the API key. */
export function mapResourceURL(resource: string, key: string | undefined): string {
  if (!key?.trim() || !resource.startsWith("https://api.maptiler.com/")) return resource;
  const url = new URL(resource);
  url.searchParams.set("key", key.trim());
  return url.href;
}

export function customStyleURL(key: string | undefined): string | undefined {
  if (!key?.trim()) return undefined;
  const url = new URL(CUSTOM_STYLE_URL);
  url.searchParams.set("key", key.trim());
  return url.href;
}

const downloadedStyles = import.meta.glob<StyleSpecification>(
  "./custom-style.json",
  { eager: true, import: "default" },
);

export function customMapStyle(
  key: string | undefined,
): StyleSpecification | string | undefined {
  const url = customStyleURL(key);
  if (!url) return undefined;
  const downloaded = downloadedStyles["./custom-style.json"];
  return downloaded
    ? (JSON.parse(
        JSON.stringify(downloaded).replaceAll(
          "INSERT_YOUR_OWN_API_KEY",
          encodeURIComponent(key!.trim()),
        ),
      ) as StyleSpecification)
    : url;
}

export const mapStyle = (url: string): StyleSpecification => ({
  version: 8,
  sources: {
    basemap: {
      type: "vector",
      url,
      attribution:
        '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors · ODbL</a> · <a href="https://mapterhorn.com/attribution/">Mapterhorn</a>',
    },
  },
  layers: [
    {
      id: "land",
      type: "background",
      paint: { "background-color": "#eeefe3" },
    },
    {
      id: "water",
      type: "fill",
      source: "basemap",
      "source-layer": "basemap",
      filter: ["==", "kind", "water"],
      paint: { "fill-color": "#b7d6d3" },
    },
    {
      id: "rivers",
      type: "line",
      source: "basemap",
      "source-layer": "basemap",
      filter: ["==", "kind", "river"],
      paint: {
        "line-color": "#91bfbe",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 14, 2],
      },
    },
    {
      id: "road-case",
      type: "line",
      source: "basemap",
      "source-layer": "basemap",
      filter: ["==", "kind", "road"],
      paint: {
        "line-color": "#c9ccbc",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8,
          0.6,
          12,
          2.5,
          16,
          8,
        ],
      },
    },
    {
      id: "roads",
      type: "line",
      source: "basemap",
      "source-layer": "basemap",
      filter: ["==", "kind", "road"],
      paint: {
        "line-color": [
          "match",
          ["get", "class"],
          ["primary", "secondary", "tertiary"],
          "#fffdf5",
          ["cycleway", "path", "track"],
          "#b8c7a8",
          "#f9f9f2",
        ],
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8,
          0.3,
          12,
          1.5,
          16,
          5,
        ],
      },
    },
  ],
});
