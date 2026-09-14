import { selectedRoute } from "../routing/selection";
import { insertionIndex, nearestPosition } from "./routeEditing";
import { MarkerLayer } from "./markers";
import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { Comparison, Point, RouteResult } from "../routing/types";
import { mapResourceURL, mapStyle, streetViewURL, type Basemap } from "./style";
import type { Track } from "../tracks";
import { CELL_COLORS, type MapCell } from "../offline/cells";
import {
  CENTER_COLOR,
  SURFACE_STYLE,
  rideFeatures,
  trackColorExpression,
  trackWidthExpression,
} from "./rideStyle";
/** Below this zoom the grid is context only: one stray click must not queue an area. */
const MIN_SELECT_ZOOM = 6;

/** One-shot imperative camera instruction. `id` makes repeats of the same action distinct. */
export type MapCommand = {
  id: number;
  kind: "fit" | "zoomIn" | "zoomOut" | "resetNorth";
  points?: Point[];
};
const empty = { type: "FeatureCollection" as const, features: [] };
const ring = (b: [number, number, number, number]): Point[] => [
  [b[0], b[1]],
  [b[2], b[1]],
  [b[2], b[3]],
  [b[0], b[3]],
  [b[0], b[1]],
];
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);
export function MapView({
  anchors,
  comparison,
  partial,
  debug,
  history,
  onPoint,
  onMove,
  onInclude,
  editable,
  onMenu,
  onCamera,
  onCell,
  tracks,
  activeId,
  cells,
  command,
  bottomInset,
  basemap,
}: {
  basemap: Basemap;
  tracks: Track[];
  activeId?: string;
  cells?: MapCell[];
  command?: MapCommand;
  /** Pixels of the map occluded by the planner panel, so fits stay visible. */
  bottomInset: number;
  anchors: Point[];
  comparison?: Comparison;
  partial?: RouteResult;
  debug: boolean;
  history: boolean;
  onPoint: (p: Point) => void;
  onMove: (i: number, p: Point) => void;
  onInclude: (index: number, point: Point) => void;
  editable: boolean;
  /** Right-click or long-press on waypoint `i`, in viewport coordinates. */
  onMenu: (i: number, x: number, y: number) => void;
  /** Camera orientation, so the compass control can point north. */
  onCamera: (camera: { bearing: number; pitch: number }) => void;
  /** A grid cell was clicked while the Data tab is showing the grid. */
  onCell: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    map = useRef<maplibregl.Map | undefined>(undefined),
    markers = useRef<MarkerLayer | undefined>(undefined);
  const [mapError, setMapError] = useState("");
  const appliedBasemap = useRef(basemap);
  const handlers = useRef({
    onPoint,
    onMove,
    onMenu,
    onCamera,
    onCell,
    onInclude,
  });
  handlers.current = { onPoint, onMove, onMenu, onCamera, onCell, onInclude };
  const snapshot = useRef({
    editable,
    anchors,
    comparison,
    partial,
    debug,
    history,
    tracks,
    activeId,
    cells,
  });
  snapshot.current = {
    editable,
    anchors,
    comparison,
    partial,
    debug,
    history,
    tracks,
    activeId,
    cells,
  };
  useEffect(() => {
    const key = import.meta.env.VITE_MAPTILER_API_KEY;
    if (!key?.trim()) {
      setMapError("Map unavailable: no map access key is configured.");
      return;
    }
    const m = new maplibregl.Map({
      container: container.current!,
      style: mapStyle(key, appliedBasemap.current),
      transformRequest: (resource) => ({
        url: mapResourceURL(resource, import.meta.env.VITE_MAPTILER_API_KEY),
      }),
      center: [6.205, 46.19],
      zoom: 10.7,
      minZoom: 0,
      maxZoom: 18,
      attributionControl: { compact: true },
    });
    map.current = m;
    // Browser tests inspect sources and layers through the container, the same way they
    // already read `data-ready` off it. Scoped to the element rather than a global.
    (container.current as HTMLDivElement & { _map?: maplibregl.Map })._map = m;
    // Zoom, locate and compass are rendered as app buttons instead, so every map
    // control shares one size and shape.
    const reportCamera = () =>
      handlers.current.onCamera({
        bearing: m.getBearing(),
        pitch: m.getPitch(),
      });
    m.on("rotate", reportCamera);
    m.on("pitch", reportCamera);
    // A click on the grid selects an area; the layer handler runs first and marks the
    // event so the generic map click does not also drop a waypoint.
    m.on("click", "cells-fill", (e) => {
      if (m.getZoom() < MIN_SELECT_ZOOM) return;
      const id = e.features?.[0]?.properties?.id;
      if (typeof id !== "string") return;
      (e.originalEvent as Event & { _cellHandled?: boolean })._cellHandled =
        true;
      handlers.current.onCell(id);
    });
    let suppressClickUntil = 0;
    m.on("click", (e) => {
      if (Date.now() < suppressClickUntil) return;
      if ((e.originalEvent as Event & { _cellHandled?: boolean })._cellHandled)
        return;
      handlers.current.onPoint([e.lngLat.lng, e.lngLat.lat]);
    });
    const handleElement = document.createElement("div");
    handleElement.className = "route-drag-handle";
    handleElement.title = "Drag to reshape route";
    handleElement.setAttribute("aria-label", "Drag to reshape route");
    const handle = new maplibregl.Marker({
      element: handleElement,
      draggable: true,
    });
    let dragging = false;
    let handleIndex = 1;
    let contextPopup: maplibregl.Popup | undefined;
    const locate = (point: maplibregl.Point) => {
      const s = snapshot.current;
      const track = s.tracks.find((t) => t.id === s.activeId);
      if (
        !s.editable ||
        track?.kind !== "planned" ||
        !track.visible ||
        track.resultRevision !== track.revision ||
        track.result?.status !== "ok" ||
        s.anchors.length < 2
      )
        return;
      const project = (p: Point): Point => {
        const q = m.project(p);
        return [q.x, q.y];
      };
      const line = track.result.geometry.map(project);
      const nearest = nearestPosition(line, [point.x, point.y]);
      return {
        ...nearest,
        index: insertionIndex(line, s.anchors.map(project), nearest.position),
      };
    };
    m.on("mousemove", (e) => {
      if (dragging || e.originalEvent.buttons) return;
      const hit = locate(e.point);
      if (!hit || hit.distance > 12 || snapshot.current.anchors.length >= 12) {
        handle.remove();
        return;
      }
      handleIndex = hit.index;
      handle.setLngLat(m.unproject(hit.point));
      if (!handleElement.isConnected) handle.addTo(m);
    });
    handle.on("dragstart", () => {
      dragging = true;
      contextPopup?.remove();
    });
    handle.on("dragend", () => {
      dragging = false;
      suppressClickUntil = Date.now() + 400;
      const p = handle.getLngLat();
      handle.remove();
      handlers.current.onInclude(handleIndex, [p.lng, p.lat]);
    });
    // Street View is only offered on a computed route: elsewhere Google usually has no
    // panorama, and the route is where a rider wants to check the way ahead.
    const onRoute = (point: maplibregl.Point): Point | undefined => {
      let best: { distance: number; point: Point } | undefined;
      for (const track of snapshot.current.tracks) {
        if (!track.visible || track.result?.status !== "ok") continue;
        const line = track.result.geometry.map((p): Point => {
          const q = m.project(p);
          return [q.x, q.y];
        });
        const nearest = nearestPosition(line, [point.x, point.y]);
        if (!best || nearest.distance < best.distance) best = nearest;
      }
      if (!best || best.distance > 16) return;
      const snapped = m.unproject(best.point);
      return [snapped.lng, snapped.lat];
    };
    const openInclude = (point: maplibregl.Point) => {
      const hit = locate(point);
      const street = onRoute(point);
      if (!hit && !street) return;
      handle.remove();
      contextPopup?.remove();
      const location = m.unproject(point);
      const menu = document.createElement("div");
      menu.className = "map-context-menu";
      const action = (label: string, run: () => void, disabled = false) => {
        const button = document.createElement("button");
        button.textContent = label;
        button.disabled = disabled;
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          contextPopup?.remove();
          run();
        });
        menu.append(button);
      };
      if (hit)
        action(
          "Include in route",
          () =>
            handlers.current.onInclude(hit.index, [location.lng, location.lat]),
          snapshot.current.anchors.length >= 12,
        );
      if (street)
        action("Open in Street View", () =>
          window.open(streetViewURL(street), "_blank", "noopener,noreferrer"),
        );
      contextPopup = new maplibregl.Popup({
        closeButton: false,
        className: "map-context-popup",
      })
        .setLngLat(location)
        .setDOMContent(menu)
        .addTo(m);
    };
    m.on("contextmenu", (e) => {
      e.preventDefault();
      openInclude(e.point);
    });
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    let pressPoint: maplibregl.Point | undefined;
    let longPressed = false;
    const cancelPress = () => clearTimeout(pressTimer);
    m.on("touchstart", (e) => {
      cancelPress();
      longPressed = false;
      if (e.points.length !== 1) return;
      pressPoint = e.point;
      pressTimer = setTimeout(() => {
        longPressed = true;
        suppressClickUntil = Date.now() + 1000;
        openInclude(e.point);
      }, 500);
    });
    m.on("touchmove", (e) => {
      if (e.points.length !== 1 || !pressPoint || e.point.dist(pressPoint) > 8)
        cancelPress();
    });
    m.on("touchend", () => {
      cancelPress();
      if (longPressed) suppressClickUntil = Date.now() + 1000;
    });
    m.on("touchcancel", cancelPress);
    m.on("movestart", () => {
      if (!dragging) handle.remove();
    });
    // Culling depends on the viewport, so the grid is rebuilt when the camera settles.
    m.on("moveend", () => update());
    let disposed = false;
    m.on("idle", () => {
      if (!disposed && m.isStyleLoaded() && m.areTilesLoaded()) {
        container.current!.dataset.ready = "true";
      }
    });
    m.on("error", (event) => {
      console.warn("Map rendering error:", event.error?.message);
      if (!disposed)
        setMapError(
          "Map resources unavailable. Check your connection and map access key. Routing and export remain available.",
        );
    });
    const changeConnection = () => {
      if (!navigator.onLine)
        setMapError(
          "Map resources require an internet connection. Routing and export remain available.",
        );
      else {
        setMapError("");
        m.triggerRepaint();
      }
    };
    changeConnection();
    window.addEventListener("online", changeConnection);
    window.addEventListener("offline", changeConnection);
    m.on("style.load", () => {
      for (const id of ["cells", "field", "corridor", "reference", "route"])
        m.addSource(id, { type: "geojson", data: empty });
      // Grid cells come from one source with data-driven paint, so a state change is a
      // setData call rather than a layer rebuild. No symbol layer: labelling needs
      // MapTiler glyphs, which stay online-only, so sizes live in the panel instead.
      m.addLayer({
        id: "cells-fill",
        type: "fill",
        source: "cells",
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": [
            "case",
            ["!", ["get", "selectable"]],
            0.05,
            ["==", ["get", "state"], "unavailable"],
            0.06,
            ["get", "active"],
            0.32,
            0.14,
          ],
        },
      });
      m.addLayer({
        id: "cells-line",
        type: "line",
        source: "cells",
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["case", ["get", "active"], 2.5, 1],
          "line-opacity": [
            "case",
            ["!", ["get", "selectable"]],
            0.3,
            ["==", ["get", "state"], "unavailable"],
            0.35,
            0.9,
          ],
        },
      });
      m.addLayer({
        id: "field",
        type: "fill",
        source: "field",
        paint: {
          "fill-color": [
            "interpolate",
            ["linear"],
            ["get", "cost"],
            1,
            "#95b16b",
            4,
            "#d8c57b",
            10,
            "#c3876d",
            15,
            "#8b9182",
          ],
          "fill-opacity": 0.28,
        },
      });
      m.addLayer({
        id: "corridor",
        type: "line",
        source: "corridor",
        paint: {
          "line-color": "#8f9e58",
          "line-width": 24,
          "line-opacity": 0.22,
          "line-blur": 6,
        },
      });
      m.addLayer({
        id: "reference",
        type: "line",
        source: "reference",
        paint: {
          "line-color": "#5c86a4",
          "line-width": 4,
          "line-dasharray": [2, 1],
          "line-opacity": 0.8,
        },
      });
      m.addLayer({
        id: "route-halo",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": CENTER_COLOR,
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 8, 14, 14],
          "line-opacity": ["case", ["get", "stale"], 0.4, 0.9],
        },
      });
      m.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          // Every track keeps its own colour, active or not: colour is which track this
          // is, never what it is made of. Surface rides on top as a centre line.
          "line-color": trackColorExpression(),
          "line-width": trackWidthExpression(),
          "line-opacity": [
            "case",
            ["get", "stale"],
            0.45,
            ["get", "active"],
            1,
            0.8,
          ],
        },
      });
      // The centre line is the surface indicator: absent on tarmac, finer and more broken
      // as the going worsens, so terrain reads at a glance and in greyscale without ever
      // taking a colour away from the track it belongs to.
      for (const { ride, center } of SURFACE_STYLE) {
        if (!center) continue;
        m.addLayer({
          id: `route-${ride}`,
          type: "line",
          source: "route",
          layout: { "line-cap": "butt", "line-join": "round" },
          filter: ["==", ["get", "ride"], ride],
          paint: {
            "line-color": CENTER_COLOR,
            ...(center.dash ? { "line-dasharray": center.dash } : {}),
            "line-width": trackWidthExpression(center.weight),
            "line-opacity": [
              "case",
              ["get", "stale"],
              center.opacity * 0.5,
              ["get", "active"],
              center.opacity,
              center.opacity * 0.8,
            ],
          },
        });
      }
      update();
    });
    function update() {
      if (!dragging) handle.remove();
      contextPopup?.remove();
      if (!m.getSource("route")) return;
      const s = snapshot.current;
      const route = selectedRoute(s.comparison, s.partial);
      const bounds = m.getBounds();
      const selectable = m.getZoom() >= MIN_SELECT_ZOOM;
      const visible = (s.cells ?? []).filter(
        (cell) =>
          cell.bbox[0] <= bounds.getEast() &&
          cell.bbox[2] >= bounds.getWest() &&
          cell.bbox[1] <= bounds.getNorth() &&
          cell.bbox[3] >= bounds.getSouth(),
      );
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
              stale: t.resultRevision !== t.revision,
            };
            return rideFeatures(
              t.result!.segments ?? [],
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
      if (s.history && !m.getSource("history")) {
        m.addSource("history", {
          type: "vector",
          url: "pmtiles://https://fxi-io-media.sos-ch-gva-2.exo.io/layers/heatmap.pmtiles",
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
    m.on("cyclatractor-update", update);
    return () => {
      disposed = true;
      cancelPress();
      handle.remove();
      contextPopup?.remove();
      window.removeEventListener("online", changeConnection);
      window.removeEventListener("offline", changeConnection);
      markers.current?.destroy();
      markers.current = undefined;
      m.remove();
      map.current = undefined;
    };
  }, []);
  // A full style reload drops the app's sources and layers; `style.load` adds them back.
  useEffect(() => {
    const m = map.current;
    if (!m || appliedBasemap.current === basemap) return;
    appliedBasemap.current = basemap;
    m.setStyle(mapStyle(import.meta.env.VITE_MAPTILER_API_KEY, basemap), {
      diff: false,
    });
  }, [basemap]);
  // Markers reconcile by index; only anchors can change them, so nothing else belongs
  // in this dependency list. Recreating them on every data change dropped live drags.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!markers.current) markers.current = new MarkerLayer(m, handlers);
    markers.current.sync(anchors);
  }, [anchors]);
  // Redrawing the geojson sources is separate from the markers, and every rendered input
  // has to be listed here or its layer silently stops updating.
  useEffect(() => {
    map.current?.fire("cyclatractor-update");
  }, [
    editable,
    anchors,
    comparison,
    partial,
    debug,
    history,
    tracks,
    activeId,
    cells,
  ]);
  useEffect(() => {
    const m = map.current;
    if (!m || !command) return;
    const instant = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (command.kind === "zoomIn") return void m.zoomIn();
    if (command.kind === "zoomOut") return void m.zoomOut();
    if (command.kind === "resetNorth")
      return void m.easeTo({
        bearing: 0,
        pitch: 0,
        duration: instant ? 0 : 400,
      });
    const points = command.points ?? [];
    if (!points.length) return;
    if (points.length === 1)
      m.flyTo({
        center: points[0],
        zoom: 13,
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 700,
      });
    else {
      const bounds = new maplibregl.LngLatBounds(points[0], points[0]);
      points.forEach((p) => bounds.extend(p));
      m.fitBounds(bounds, {
        padding: {
          top: 110,
          // The panel is an overlay the map never reflows around, so its real height
          // has to be padded out explicitly or fits land underneath it.
          bottom: Math.min(bottomInset, innerHeight * 0.7),
          left: 45,
          right: 90,
        },
        maxZoom: 15,
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 700,
      });
    }
  }, [command, bottomInset]);
  return (
    <>
      <div ref={container} className="map" aria-label="Route map" />
      {mapError && (
        <p className="map-error" role="status" data-testid="map-error">
          {mapError}
        </p>
      )}
    </>
  );
}
