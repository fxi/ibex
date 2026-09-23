import type {
  ExpressionSpecification,
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
} from "maplibre-gl";
import {
  language_script_pairs,
  layers as protomapsLayers,
  namedFlavor,
  type Flavor,
} from "@protomaps/basemaps";
import type { MapResources } from "./resources";

/** Mapterhorn is z12 almost everywhere; beyond it hillshade and contours overzoom. */
export const TERRAIN_MAXZOOM = 12;

const OSM = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>';

/**
 * Motorways and trunks are what a rider avoids, so they recede to grey instead of drawing
 * the eye as the brightest line on the map.
 */
const FLAVOR: Flavor = {
  ...namedFlavor("light"),
  highway: "hsl(40, 6%, 86%)",
  highway_casing_early: "hsl(40, 6%, 72%)",
  highway_casing_late: "hsl(40, 6%, 72%)",
};

const roadColor = (
  large: string,
  major: string,
  minor: string,
): ExpressionSpecification => [
  "match",
  ["get", "kind"],
  "highway",
  large,
  "major_road",
  major,
  minor,
];

/** Protomaps names in the reader's language where it has them, the local name otherwise. */
export function labelLanguage(locale: string | undefined): string {
  const tag = (locale ?? "").toLowerCase();
  const known = language_script_pairs.map((p) => p.lang);
  return (
    known.find((lang) => tag === lang.toLowerCase()) ??
    known.find((lang) => tag.split("-")[0] === lang) ??
    "en"
  );
}

const FONT = ["Noto Sans Regular"];
const FONT_MEDIUM = ["Noto Sans Medium"];

const notTunnel: ExpressionSpecification = ["!", ["has", "is_tunnel"]];
const detail = (...kinds: string[]): ExpressionSpecification => [
  "in",
  ["get", "kind_detail"],
  ["literal", kinds],
];

/**
 * Paths and tracks are most of what this app routes on, so they get their own layers in
 * place of Protomaps' single pale `roads_other`: a white casing to lift them off the
 * ground, and a stroke that tells a cycleway from a track from a footpath.
 */
const TRAIL_LAYERS: LayerSpecification[] = [
  {
    id: "Trails outline",
    type: "line",
    source: "protomaps",
    "source-layer": "roads",
    minzoom: 13,
    filter: ["all", notTunnel, ["==", ["get", "kind"], "path"]],
    paint: {
      "line-color": "hsla(0, 0%, 100%, 0.75)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 13, 2, 16, 4, 18, 6],
    },
  },
  {
    id: "Cycleways",
    type: "line",
    source: "protomaps",
    "source-layer": "roads",
    minzoom: 12,
    filter: ["all", notTunnel, detail("cycleway")],
    paint: {
      "line-color": "hsl(205, 65%, 45%)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 16, 1.8, 18, 3],
    },
  },
  {
    id: "Tracks",
    type: "line",
    source: "protomaps",
    "source-layer": "roads",
    minzoom: 12,
    filter: ["all", notTunnel, detail("track")],
    paint: {
      "line-color": "hsl(30, 45%, 38%)",
      "line-dasharray": [3, 1.5],
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 16, 1.6, 18, 2.5],
    },
  },
  {
    id: "Paths",
    type: "line",
    source: "protomaps",
    "source-layer": "roads",
    minzoom: 13,
    filter: [
      "all",
      notTunnel,
      ["==", ["get", "kind"], "path"],
      ["!", detail("cycleway", "track")],
    ],
    paint: {
      "line-color": "hsl(24, 10%, 45%)",
      "line-dasharray": [1, 1],
      "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.5, 16, 1.3, 18, 2],
    },
  },
];

const network = (...networks: string[]): ExpressionSpecification => [
  "in",
  ["get", "network"],
  ["literal", networks],
];
const bicycle: ExpressionSpecification = ["==", ["get", "route"], "bicycle"];
const ROUTE_WIDTH: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  5,
  0.8,
  10,
  2,
  14,
  2.5,
  18,
  4,
];
const LONG_DISTANCE: ExpressionSpecification = ["all", bicycle, network("icn", "ncn")];
const REGIONAL: ExpressionSpecification = ["all", bicycle, network("rcn")];
const LOCAL: ExpressionSpecification = [
  "all",
  bicycle,
  ["!", network("icn", "ncn", "rcn")],
];
const MTB: ExpressionSpecification = ["==", ["get", "route"], "mtb"];

/** Signed cycle routes, from the app's own archive of OSM route relations. */
const CYCLE_ROUTE_LAYERS: LayerSpecification[] = [
  {
    id: "Bicycle outline",
    type: "line",
    source: "cycle_routes",
    "source-layer": "cycle_routes",
    filter: [
      "any",
      LONG_DISTANCE,
      ["all", REGIONAL, [">=", ["zoom"], 8]],
      [">=", ["zoom"], 11],
    ],
    paint: {
      "line-color": "hsla(0, 0%, 100%, 0.75)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2, 10, 4, 14, 5, 18, 7],
    },
  },
  {
    id: "MTB routes",
    type: "line",
    source: "cycle_routes",
    "source-layer": "cycle_routes",
    minzoom: 10,
    filter: MTB,
    paint: {
      "line-color": "hsl(25, 85%, 48%)",
      "line-dasharray": [2, 1.5],
      "line-width": ROUTE_WIDTH,
    },
  },
  {
    id: "Bicycle local",
    type: "line",
    source: "cycle_routes",
    "source-layer": "cycle_routes",
    minzoom: 11,
    filter: LOCAL,
    paint: {
      "line-color": "hsl(306, 80%, 64%)",
      "line-dasharray": [1.5, 1.5],
      "line-width": ROUTE_WIDTH,
    },
  },
  {
    id: "Bicycle regional",
    type: "line",
    source: "cycle_routes",
    "source-layer": "cycle_routes",
    minzoom: 8,
    filter: REGIONAL,
    paint: { "line-color": "hsl(307, 85%, 58%)", "line-width": ROUTE_WIDTH },
  },
  {
    id: "Bicycle longdistance",
    type: "line",
    source: "cycle_routes",
    "source-layer": "cycle_routes",
    filter: LONG_DISTANCE,
    paint: { "line-color": "hsl(307, 100%, 45%)", "line-width": ROUTE_WIDTH },
  },
];

const CYCLE_ROUTE_LABELS: LayerSpecification = {
  id: "Bicycle route labels",
  type: "symbol",
  source: "cycle_routes",
  "source-layer": "cycle_routes",
  minzoom: 11,
  filter: ["has", "ref"],
  layout: {
    "symbol-placement": "line",
    "symbol-spacing": 350,
    "text-field": ["get", "ref"],
    "text-font": FONT_MEDIUM,
    "text-size": 11,
  },
  paint: {
    "text-color": ["case", MTB, "hsl(25, 85%, 38%)", "hsl(307, 100%, 38%)"],
    "text-halo-color": "hsl(0, 0%, 100%)",
    "text-halo-width": 2,
  },
};

const HILLSHADE: LayerSpecification = {
  id: "Hillshade",
  type: "hillshade",
  source: "terrain",
  paint: {
    "hillshade-accent-color": "hsl(98, 35%, 86%)",
    "hillshade-exaggeration": ["interpolate", ["linear"], ["zoom"], 6, 0.4, 14, 0.35, 18, 0.25],
    "hillshade-highlight-color": "hsl(20, 13%, 68%)",
    "hillshade-shadow-color": [
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      "hsl(9, 3%, 41%)",
      13,
      "hsl(9, 0%, 0%)",
      15,
      "hsl(9, 3%, 41%)",
    ],
  },
};

/** Contour intervals in metres by zoom, as [minor, index]. */
export const CONTOUR_THRESHOLDS: Record<number, [number, number]> = {
  10: [200, 1000],
  11: [100, 500],
  12: [50, 250],
  13: [20, 100],
  14: [10, 50],
};

const CONTOUR_LAYERS: LayerSpecification[] = [
  {
    id: "Contour",
    type: "line",
    source: "contours",
    "source-layer": "contours",
    minzoom: 11,
    filter: ["==", ["get", "level"], 0],
    paint: {
      "line-color": "hsl(36, 45%, 50%)",
      "line-opacity": 0.3,
      "line-width": 0.8,
    },
  },
  {
    id: "Contour index",
    type: "line",
    source: "contours",
    "source-layer": "contours",
    minzoom: 10,
    filter: [">", ["get", "level"], 0],
    paint: {
      "line-color": "hsla(36, 45%, 45%, 0.8)",
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.3, 14, 0.4, 18, 0.5],
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 1.5],
    },
  },
];

const CONTOUR_LABELS: LayerSpecification = {
  id: "Contour labels",
  type: "symbol",
  source: "contours",
  "source-layer": "contours",
  minzoom: 12,
  filter: [">", ["get", "level"], 0],
  layout: {
    "symbol-placement": "line",
    "text-field": ["concat", ["number-format", ["get", "ele"], {}], " m"],
    "text-font": FONT,
    "text-size": 10,
  },
  paint: {
    "text-color": "hsl(36, 45%, 31%)",
    "text-halo-color": "hsla(0, 0%, 100%, 0.8)",
    "text-halo-width": 0.8,
  },
};

export type StyleInputs = {
  /** The bucket's basemap files and relief; without them only the background is drawn. */
  resources?: MapResources;
  /** Contour tile URL from maplibre-contour for the same relief; without it none are drawn. */
  contours?: string;
  /** A Protomaps label language, see `labelLanguage`. */
  lang?: string;
};

function sources(inputs: StyleInputs): StyleSpecification["sources"] {
  const out: Record<string, SourceSpecification> = {};
  const r = inputs.resources;
  if (r?.terrain) {
    out.terrain = {
      type: "raster-dem",
      tiles: [r.terrain],
      encoding: "terrarium",
      tileSize: 512,
      maxzoom: TERRAIN_MAXZOOM,
      attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
    };
    if (inputs.contours)
      out.contours = { type: "vector", tiles: [inputs.contours], maxzoom: 15 };
  }
  if (r) {
    out.protomaps = {
      type: "vector",
      url: `pmtiles://${r.basemap}`,
      attribution: `<a href="https://protomaps.com">Protomaps</a> ${OSM}`,
    };
    if (r.cycleRoutes)
      out.cycle_routes = {
        type: "vector",
        url: `pmtiles://${r.cycleRoutes}`,
        attribution: OSM,
      };
  }
  return out;
}

/**
 * The outdoor map: Protomaps' light basemap with the relief laid under its roads, paths
 * restyled for riding, and cycle routes drawn over everything but the labels.
 */
export function outdoorStyle(inputs: StyleInputs): StyleSpecification {
  const r = inputs.resources;
  const src = sources(inputs);
  const relief = [
    ...(src.terrain ? [HILLSHADE] : []),
    ...(src.contours ? CONTOUR_LAYERS : []),
  ];
  const background: LayerSpecification = {
    id: "background",
    type: "background",
    paint: { "background-color": FLAVOR.earth },
  };
  if (!r) return { version: 8, sources: src, layers: [background, ...relief] };

  const base = protomapsLayers("protomaps", FLAVOR, { lang: inputs.lang ?? "en" })
    // Paths are redrawn by TRAIL_LAYERS; what is left under this id is piers and the like.
    .map((l) =>
      l.id === "roads_other"
        ? ({ ...l, filter: ["all", notTunnel, ["==", ["get", "kind"], "other"]] } as LayerSpecification)
        : l,
    );
  const lines = base.filter((l) => l.type !== "symbol");
  const labels = base.filter((l) => l.type === "symbol");
  const firstRoad = lines.findIndex((l) => l.id.startsWith("roads_"));
  return {
    version: 8,
    glyphs: r.glyphs,
    sprite: r.sprite,
    sources: src,
    layers: [
      ...lines.slice(0, firstRoad),
      ...relief,
      ...lines.slice(firstRoad),
      ...TRAIL_LAYERS,
      ...(src.cycle_routes ? CYCLE_ROUTE_LAYERS : []),
      ...(src.contours ? [CONTOUR_LABELS] : []),
      ...labels,
      ...(src.cycle_routes ? [CYCLE_ROUTE_LABELS] : []),
    ],
  };
}

export type Basemap = "outdoor" | "satellite" | "hybrid";
export const BASEMAPS: { id: Basemap; label: string }[] = [
  { id: "outdoor", label: "Outdoor" },
  { id: "satellite", label: "Satellite" },
  { id: "hybrid", label: "Hybrid" },
];

/**
 * Keyless imagery, stacked coarse to fine: Sentinel-2 cloudless everywhere, then the
 * national orthophotos of France and Switzerland where they exist. Each carries its
 * bounds, so the fine layers are never asked for tiles they do not have.
 */
export const IMAGERY: {
  id: string;
  source: SourceSpecification;
}[] = [
  {
    id: "Satellite",
    source: {
      type: "raster",
      tiles: [
        "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg",
      ],
      tileSize: 256,
      maxzoom: 14,
      attribution:
        '<a href="https://s2maps.eu">Sentinel-2 cloudless 2024</a> by EOX IT Services GmbH (modified Copernicus Sentinel data 2024)',
    },
  },
  {
    id: "Satellite France",
    source: {
      type: "raster",
      tiles: [
        "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
      ],
      tileSize: 256,
      minzoom: 6,
      maxzoom: 19,
      bounds: [-5.2, 41.3, 9.6, 51.1],
      attribution: '<a href="https://geoservices.ign.fr">© IGN</a>',
    },
  },
  {
    id: "Satellite Switzerland",
    source: {
      type: "raster",
      tiles: [
        "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg",
      ],
      tileSize: 256,
      minzoom: 8,
      maxzoom: 20,
      bounds: [5.9, 45.8, 10.5, 47.9],
      attribution: '<a href="https://www.swisstopo.admin.ch">© swisstopo</a>',
    },
  },
];

const imagerySourceId = (layerId: string) =>
  `imagery-${layerId.toLowerCase().replace(/\s+/g, "-")}`;

/** Overlay lines that only add clutter on top of imagery. */
const HYBRID_EXCLUDED = /^(boundaries|water_|landuse_|roads_(rail|pier|runway|taxiway)|Contour)/;
/**
 * White casings lift trails off the pale outdoor ground but glare on imagery; hybrid turns
 * them dark so the coloured line keeps its edge without the halo.
 */
const HYBRID_DARK_CASING = /^(Trails|Bicycle) outline$/;
const DARK_CASING_COLOR = "hsla(0, 0%, 8%, 0.7)";
/** Pure white roads glare on imagery; greys keep the network legible but quieter. */
const HYBRID_ROAD_COLOR = roadColor(
  "hsl(0, 0%, 72%)",
  "hsl(0, 0%, 88%)",
  "hsla(0, 0%, 85%, 0.8)",
);
/** Labels flip to light text on a dark halo, which reads on any imagery. */
const HYBRID_HALO_COLOR = "hsla(0, 0%, 8%, 0.75)";

/** A CSS hex or hsl colour as hue, saturation and lightness, or nothing if it is neither. */
function toHSL(value: string): [number, number, number] | undefined {
  const hsl = value.match(
    /^hsla?\(\s*([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%(?:,\s*([\d.]+))?\s*\)$/,
  );
  if (hsl) return [+hsl[1], +hsl[2], +hsl[3]];
  const hex = value.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!hex) return undefined;
  const digits =
    hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, Math.round(l * 100)];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(((h * 60) + 360) % 360), Math.round(s * 100), Math.round(l * 100)];
}

/**
 * Lift a label colour so it reads on a dark halo: neutral greys become near-white, coloured
 * text keeps its hue and only gains lightness. Walks expressions, since several labels pick
 * their colour by kind or zoom.
 */
function lightText(value: unknown): unknown {
  if (typeof value === "string") {
    const hsl = toHSL(value);
    if (!hsl) return value;
    const [h, s, l] = hsl;
    return `hsl(${h}, ${s}%, ${Math.max(l, s < 15 ? 96 : 78)}%)`;
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
  if (l.type === "line" && l.id.startsWith("roads_"))
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
 * Satellite imagery replaces the outdoor style's ground; hybrid keeps its roads, trails,
 * routes and labels on top. Relief is dropped: the imagery already shows it.
 */
export function mapStyle(
  inputs: StyleInputs,
  basemap: Basemap,
): StyleSpecification {
  const style = outdoorStyle(inputs);
  if (basemap === "outdoor") return style;
  const overlay =
    basemap === "hybrid"
      ? style.layers
          .filter(
            (l) =>
              (l.type === "line" || l.type === "symbol") &&
              !HYBRID_EXCLUDED.test(l.id) &&
              // Road casings exist to edge a white road on pale ground.
              !(l.id.startsWith("roads_") && l.id.includes("casing")),
          )
          .map(hybridLayer)
      : [];
  const overlaySources = new Set(
    overlay.map((l) => ("source" in l ? l.source : undefined)),
  );
  return {
    ...style,
    sources: {
      ...Object.fromEntries(
        Object.entries(style.sources).filter(([id]) => overlaySources.has(id)),
      ),
      ...Object.fromEntries(
        IMAGERY.map(({ id, source }) => [imagerySourceId(id), source]),
      ),
    },
    layers: [
      ...IMAGERY.map(
        ({ id }): LayerSpecification => ({
          id,
          type: "raster",
          source: imagerySourceId(id),
        }),
      ),
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
