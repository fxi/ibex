/**
 * Push the current tracks, cells and diagnostics into the map sources the layers read.
 *
 * Called on every render that changes something the map draws, so it is a plain function of
 * (map, snapshot): it only ever calls setData and setLayoutProperty. Which inputs count as a
 * change is decided by the effect that dispatches `ibex-update` in Map.tsx — everything
 * read here has to be listed there, or a layer silently stops updating.
 */
import type maplibregl from "maplibre-gl";
import { selectedRoute } from "../routing/selection";
import { freshResult, type Track } from "../tracks";
import type { Comparison, Point, RouteResult } from "../routing/types";
import { CELL_COLORS, type CellState } from "../offline/cells";
import { cellBBox, cellId, cellsInBBox, type CellId } from "../geo/grid";
import { HEATMAP_URL } from "../config";
import { rideFeatures, SURFACE_STYLE, type Lens } from "./rideStyle";
import { lensFeatures, type LensFeature } from "./lens";
import { compileProfile } from "../routing/compile";
import type { Profile } from "../routing/profiles";
import type { CapabilityProfile } from "../routing/capability";
import { empty, MIN_SELECT_ZOOM } from "./layers";
import { NOTE_COLORS, type Note } from "../notes/types";
import type { SearchArea } from "../state/useNotes";

export type MapSnapshot = {
  editable: boolean;
  anchors: Point[];
  comparison?: Comparison;
  partial?: RouteResult;
  debug: boolean;
  history: boolean;
  tracks: Track[];
  activeId?: string;
  /** Whether the download grid is drawn at all: it belongs to the Data tab. */
  grid: boolean;
  /** What is known about the cells that have been built; everything else is unbuilt. */
  cellStates?: Map<CellId, CellState>;
  /** The download grid zoom, from the catalogue. */
  gridZoom?: number;
  /** Every track drawn at its stale opacity, so the ground under it shows. */
  dimmed: boolean;
  notes: Note[];
  searchArea?: SearchArea;
  /** What the centre line says: surface, steepness or traffic. */
  lens: Lens;
};

/** Compiling a profile is not free, and the map asks on every sync. */
const capabilities = new WeakMap<Profile, CapabilityProfile>();
function capabilityOf(profile: Profile): CapabilityProfile {
  let capability = capabilities.get(profile);
  if (!capability) {
    capability = compileProfile(profile).capability;
    capabilities.set(profile, capability);
  }
  return capability;
}

/**
 * One track's lens line, kept per route until the lens, the profile or the look changes:
 * a long ride has thousands of grade runs, and the map syncs on every change it draws.
 */
const lensLines = new WeakMap<
  RouteResult,
  { key: string; profile: Profile; features: LensFeature[] }
>();
function lensLine(
  track: Track,
  lens: Lens,
  meta: Parameters<typeof lensFeatures>[3],
): LensFeature[] {
  const route = track.result!;
  const key = `${lens}|${meta.active}|${meta.stale}|${meta.trackColor}`;
  const cached = lensLines.get(route);
  if (cached && cached.key === key && cached.profile === track.profile)
    return cached.features;
  const features = lensFeatures(route, lens, capabilityOf(track.profile), meta);
  lensLines.set(route, { key, profile: track.profile, features });
  return features;
}

/** A circle as a polygon ring, on a locally square grid: good to a few metres at 10 km. */
function circle({ center, radiusM }: SearchArea): Point[] {
  const dy = radiusM / 111_320,
    dx = dy / Math.cos((center[1] * Math.PI) / 180);
  return Array.from({ length: 65 }, (_, i) => {
    const a = (i / 64) * 2 * Math.PI;
    return [center[0] + dx * Math.cos(a), center[1] + dy * Math.sin(a)];
  });
}

/** A bbox as a closed polygon ring, for drawing a cell outline. */
const ring = (b: [number, number, number, number]): Point[] => [
  [b[0], b[1]],
  [b[2], b[1]],
  [b[2], b[3]],
  [b[0], b[3]],
  [b[0], b[1]],
];

export function syncSources(m: maplibregl.Map, s: MapSnapshot) {
  if (!m.getSource("route")) return;
  const route = selectedRoute(s.comparison, s.partial);
  // The grid covers the world, so it is generated from the viewport rather than from the
  // catalogue: a cell nobody has built yet is still drawn, in the colour that says so.
  // Below MIN_SELECT_ZOOM a screenful is thousands of cells and none of them are worth
  // picking, so nothing is drawn at all. Off the Data tab the grid is not drawn either:
  // it is a tool for downloading areas, not a permanent overlay on the route.
  const bounds = m.getBounds();
  const selectable = s.grid && m.getZoom() >= MIN_SELECT_ZOOM;
  const states = s.cellStates;
  const visible = selectable
    ? cellsInBBox(
        [
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth(),
        ],
        s.gridZoom ?? 9,
      ).map((cell) => {
        const id = cellId(cell);
        return {
          id,
          bbox: cellBBox(cell),
          state: states?.get(id) ?? "unavailable",
        };
      })
    : [];
  (m.getSource("cells") as maplibregl.GeoJSONSource)?.setData(
    visible.length
      ? {
          type: "FeatureCollection",
          features: visible.map((cell) => ({
            type: "Feature" as const,
            properties: {
              id: cell.id,
              state: cell.state,
              color: CELL_COLORS[cell.state],
              active:
                cell.state !== "available" && cell.state !== "unavailable",
              selectable,
            },
            geometry: {
              type: "Polygon" as const,
              coordinates: [ring(cell.bbox)],
            },
          })),
        }
      : empty,
  );
  (m.getSource("field") as maplibregl.GeoJSONSource)?.setData(
    s.debug && s.comparison?.fieldView ? s.comparison.fieldView : empty,
  );
  const line = (geometry: Point[]) => ({
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates: geometry },
  });
  (m.getSource("route") as maplibregl.GeoJSONSource)?.setData({
    type: "FeatureCollection",
    features: s.tracks
      .filter((t) => t.visible && t.result?.status === "ok")
      .flatMap((t) => {
        const meta = {
          trackId: t.id,
          trackColor: t.color,
          active: t.id === s.activeId,
          // Dimming borrows the stale look rather than adding a third opacity per layer.
          stale: s.dimmed || !freshResult(t),
        };
        return rideFeatures(t.result!.segments, t.result!.geometry, meta);
      }),
  });
  // Under the steepness and traffic lenses their line takes the middle of the track, and
  // the surface centre lines step aside rather than stack two patterns on one line.
  for (const { ride, center } of SURFACE_STYLE)
    if (center && m.getLayer(`route-${ride}`))
      m.setLayoutProperty(
        `route-${ride}`,
        "visibility",
        s.lens === "surface" ? "visible" : "none",
      );
  (m.getSource("route-lens") as maplibregl.GeoJSONSource)?.setData({
    type: "FeatureCollection",
    features:
      s.lens === "surface"
        ? []
        : s.tracks
            .filter((t) => t.visible && t.result?.status === "ok")
            .flatMap((t) =>
              lensLine(t, s.lens, {
                trackId: t.id,
                trackColor: t.color,
                active: t.id === s.activeId,
                stale: s.dimmed || !freshResult(t),
              }),
            ),
  });
  (m.getSource("reference") as maplibregl.GeoJSONSource)?.setData(
    s.debug && s.comparison?.reference.status === "ok"
      ? line(s.comparison.reference.geometry)
      : empty,
  );
  (m.getSource("corridor") as maplibregl.GeoJSONSource)?.setData({
    type: "FeatureCollection",
    features: s.debug
      ? (route?.corridor ?? []).filter((p) => p.length > 1).map(line)
      : [],
  });
  (m.getSource("notes") as maplibregl.GeoJSONSource)?.setData({
    type: "FeatureCollection",
    features: s.notes.map((n) => ({
      type: "Feature" as const,
      properties: { kind: n.kind, color: NOTE_COLORS[n.kind] },
      geometry: { type: "Point" as const, coordinates: n.point },
    })),
  });
  (m.getSource("search-area") as maplibregl.GeoJSONSource)?.setData(
    s.searchArea
      ? {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [circle(s.searchArea)] },
        }
      : empty,
  );
  if (s.history && HEATMAP_URL && !m.getSource("history")) {
    m.addSource("history", {
      type: "vector",
      url: `pmtiles://${HEATMAP_URL}`,
    });
    m.addLayer(
      {
        id: "history",
        type: "line",
        source: "history",
        "source-layer": "heatmap",
        filter: ["in", "sport_type", "Ride", "GravelRide", "MountainBikeRide"],
        paint: {
          "line-color": "#865a94",
          "line-opacity": 0.22,
          "line-width": 2,
        },
      },
      "route-halo",
    );
  }
  if (m.getLayer("history"))
    m.setLayoutProperty(
      "history",
      "visibility",
      s.history ? "visible" : "none",
    );
}
