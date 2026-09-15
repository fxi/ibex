import type {
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
} from "maplibre-gl";
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

/**
 * Road colour by class. Motorways and trunks are what a rider avoids, so they recede to
 * grey instead of drawing the eye as the brightest line on the map.
 */
const roadColor = (
  large: string,
  major: string,
  minor: string,
): ExpressionSpecification => [
  "match",
  ["get", "class"],
  ["motorway", "trunk"],
  large,
  ["primary", "secondary", "tertiary"],
  major,
  minor,
];

/** The bundled JSON is the only style, independent of connectivity. */
export function customMapStyle(key: string | undefined): StyleSpecification {
  const style = JSON.parse(
    JSON.stringify(downloaded).replaceAll(
      "INSERT_YOUR_OWN_API_KEY",
      encodeURIComponent(key?.trim() ?? ""),
    ),
  ) as StyleSpecification;
  return withPaint(style, "Road network", {
    "line-color": roadColor("hsl(40, 6%, 86%)", "hsl(0, 0%, 100%)", "hsl(0, 0%, 100%)"),
  });
}

function withPaint(
  style: StyleSpecification,
  id: string,
  paint: Record<string, unknown>,
): StyleSpecification {
  return {
    ...style,
    layers: style.layers.map((l) =>
      l.id === id && "paint" in l
        ? ({ ...l, paint: { ...l.paint, ...paint } } as LayerSpecification)
        : l,
    ),
  };
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
 * White casings that lift trails off the pale outdoor ground but glare on imagery; hybrid
 * turns them dark so the coloured line keeps its edge without the halo.
 */
const HYBRID_DARK_CASING =
  /^((Pedestrian|Trails|Bicycle|Longdistance trail) outline|bicycle_all_outline)$/;
const DARK_CASING_COLOR = "hsla(0, 0%, 8%, 0.7)";
/** Pure white roads glare on imagery; greys keep the network legible but quieter. */
const HYBRID_ROAD_COLOR = roadColor(
  "hsl(0, 0%, 72%)",
  "hsl(0, 0%, 88%)",
  "hsla(0, 0%, 85%, 0.8)",
);
/** Labels flip to light text on a dark halo, which reads on any imagery. */
const HYBRID_HALO_COLOR = "hsla(0, 0%, 8%, 0.75)";

/**
 * Lift a label colour so it reads on a dark halo: neutral greys become near-white, coloured
 * text keeps its hue and only gains lightness. Walks expressions and stops, since a few
 * labels interpolate their colour by zoom.
 */
function lightText(value: unknown): unknown {
  if (typeof value === "string") {
    const m = value.match(
      /^hsla?\(\s*([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%(?:,\s*([\d.]+))?\s*\)$/,
    );
    if (!m) return value;
    const [h, s, l] = [+m[1], +m[2], +m[3]];
    const lightness = Math.max(l, s < 15 ? 96 : 78);
    return `hsl(${h}, ${s}%, ${lightness}%)`;
  }
  if (Array.isArray(value)) return value.map(lightText);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, lightText(v)]),
    );
  return value;
}

function hybridLayer(l: LayerSpecification): LayerSpecification {
  if (l.type === "line" && HYBRID_DARK_CASING.test(l.id))
    return { ...l, paint: { ...l.paint, "line-color": DARK_CASING_COLOR } };
  if (l.type === "line" && l.id === "Road network")
    return { ...l, paint: { ...l.paint, "line-color": HYBRID_ROAD_COLOR } };
  if (l.type === "symbol" && l.paint?.["text-halo-color"])
    return {
      ...l,
      paint: {
        ...l.paint,
        "text-color": lightText(l.paint["text-color"]) as string,
        "text-halo-color": HYBRID_HALO_COLOR,
      },
    };
  return l;
}

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
      ? style.layers
          .filter(
            (l) =>
              (l.type === "line" || l.type === "symbol") &&
              l.source !== "contours" &&
              !HYBRID_EXCLUDED.test(l.id),
          )
          .map(hybridLayer)
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

/** iD refuses to edit below zoom 16, so the editor never opens further out than this. */
const OSM_EDIT_MIN_ZOOM = 17;

/** The openstreetmap.org editor centred on a map point, close enough to edit at once. */
export function osmEditURL([lng, lat]: [number, number], zoom: number): string {
  const z = Math.max(OSM_EDIT_MIN_ZOOM, Math.round(zoom));
  return `https://www.openstreetmap.org/edit#map=${z}/${lat.toFixed(6)}/${lng.toFixed(6)}`;
}

/** Google Street View at the nearest panorama; Google picks the closest imagery. */
export function streetViewURL([lng, lat]: [number, number]): string {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lng.toFixed(6)}`;
}
