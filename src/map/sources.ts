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
import { rideFeatures } from "./rideStyle";
import { empty, MIN_SELECT_ZOOM } from "./layers";

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
};

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
          [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
          s.gridZoom ?? 9,
        ).map((cell) => {
          const id = cellId(cell);
          return { id, bbox: cellBBox(cell), state: states?.get(id) ?? "unavailable" };
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
            stale: !freshResult(t),
          };
          return rideFeatures(
            t.result!.segments,
            t.result!.geometry,
            meta,
          );
        }),
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
          filter: [
            "in",
            "sport_type",
            "Ride",
            "GravelRide",
            "MountainBikeRide",
          ],
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
