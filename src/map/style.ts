import type { StyleSpecification } from "maplibre-gl";
import downloaded from "./custom-style.json";

/** Authenticate only MapTiler resources; never modify unrelated URLs. */
export function mapResourceURL(
  resource: string,
  key: string | undefined,
): string {
  if (!key?.trim() || !resource.startsWith("https://api.maptiler.com/"))
    return resource;
  const url = new URL(resource);
  url.searchParams.set("key", key.trim());
  return url.href;
}

/** The bundled JSON is the only style, independent of connectivity. */
export function customMapStyle(key: string | undefined): StyleSpecification {
  return JSON.parse(
    JSON.stringify(downloaded).replaceAll(
      "INSERT_YOUR_OWN_API_KEY",
      encodeURIComponent(key?.trim() ?? ""),
    ),
  ) as StyleSpecification;
}

export type Basemap = "outdoor" | "satellite" | "hybrid";
export const BASEMAPS: { id: Basemap; label: string }[] = [
  { id: "outdoor", label: "Outdoor" },
  { id: "satellite", label: "Satellite" },
  { id: "hybrid", label: "Hybrid" },
];

/** Overlay lines that only add clutter on top of imagery. */
const HYBRID_EXCLUDED = /^(Park outline|Military limit|River|Cliff)/;

/**
 * Satellite imagery replaces the bundled style's ground; hybrid keeps its roads, trails
 * and labels on top. Contours and hillshade are dropped: the imagery already shows relief.
 */
export function mapStyle(
  key: string | undefined,
  basemap: Basemap,
): StyleSpecification {
  const style = customMapStyle(key);
  if (basemap === "outdoor") return style;
  const satellite = {
    type: "raster" as const,
    url: `https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=${encodeURIComponent(key?.trim() ?? "")}`,
    tileSize: 512,
  };
  const overlay =
    basemap === "hybrid"
      ? style.layers.filter(
          (l) =>
            (l.type === "line" || l.type === "symbol") &&
            l.source !== "contours" &&
            !HYBRID_EXCLUDED.test(l.id),
        )
      : [];
  return {
    ...style,
    sources: { ...style.sources, satellite },
    layers: [
      { id: "Satellite", type: "raster", source: "satellite" },
      ...overlay,
    ],
  };
}

/** Google Street View at the nearest panorama; Google picks the closest imagery. */
export function streetViewURL([lng, lat]: [number, number]): string {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lng.toFixed(6)}`;
}
