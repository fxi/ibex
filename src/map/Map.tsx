import { selectedRoute } from "../routing/selection";
import { insertionIndex, nearestPosition, snapToLines } from "./routeEditing";
import { MarkerLayer, type MarkerCallbacks } from "./markers";
import {
  anchorVertices,
  pinchesAround,
  routeHandles,
  type Pinch,
  type Pinches,
  type RouteGrab,
} from "../routing/localEdit";
import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { Comparison, Point, RouteResult } from "../routing/types";
import {
  mapResourceURL,
  mapStyle,
  osmEditURL,
  streetViewURL,
  type Basemap,
} from "./style";
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
/** How far, in pixels, a right-click reaches to snap Street View onto a way. */
const SNAP_PX = 16;
/**
 * Screen distance between route handles. Laid out per whole zoom level, so handles hold
 * still while the map pans and only regroup when the zoom level changes.
 */
const HANDLE_SPACING_PX = 500;
/** The hover handle gives way to a route handle this close, so the handle can be reached. */
const HANDLE_CLEAR_PX = 16;
/** Handles drawn at most, for a route winding back and forth across the whole screen. */
const MAX_HANDLES = 400;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** Basemap road classes a panorama can stand on: not rail, lifts or ferry lines. */
const STREET_CLASSES = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "minor",
  "service",
  "track",
  "path",
  "busway",
]);

/** One-shot imperative camera instruction. `id` makes repeats of the same action distinct. */
export type MapCommand = {
  id: number;
  kind: "fit" | "zoomIn" | "zoomOut" | "resetNorth" | "locate";
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
  cursor,
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
  /** Waypoint `i` was dropped at `p`; `pinches` keep the edit between the nearest handles. */
  onMove: (i: number, p: Point, pinches?: Pinches) => void;
  onInclude: (index: number, point: Point, pinches?: Pinches) => void;
  editable: boolean;
  /** Right-click or long-press on waypoint `i`, in viewport coordinates. */
  onMenu: (i: number, x: number, y: number) => void;
  /** Camera orientation, so the compass control can point north. */
  onCamera: (camera: { bearing: number; pitch: number }) => void;
  /** A grid cell was clicked while the Data tab is showing the grid. */
  onCell: (id: string) => void;
  /**
   * One point marked on the map, or nothing. State rather than a command, so a re-render
   * cannot drop the mark the way a one-shot camera instruction would.
   */
  cursor?: Point;
}) {
  const container = useRef<HTMLDivElement>(null),
    map = useRef<maplibregl.Map | undefined>(undefined),
    markers = useRef<MarkerLayer | undefined>(undefined);
  // Waypoint drags are previewed on the map, so markers report to it, not to the props.
  const markerCallbacks = useRef<MarkerCallbacks>({
    onMove: () => {},
    onDragStart: () => {},
    onDrag: () => {},
    onMenu: () => {},
  });
  const [mapError, setMapError] = useState("");
  const appliedBasemap = useRef(basemap);
  // Read at fit time only: as an effect dependency, every panel resize replayed the last
  // camera command and moved the map without the user asking.
  const bottomInsetRef = useRef(bottomInset);
  bottomInsetRef.current = bottomInset;
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
    let handleGrab: RouteGrab = { kind: "insert", index: 1, position: 0 };
    let contextPopup: maplibregl.Popup | undefined;
    // Handles are laid out for one route at one zoom level (see routing/localEdit), and
    // kept until either changes.
    let layout:
      | {
          route: RouteResult;
          zoom: number;
          vertices: number[];
          handles: Pinch[];
        }
      | undefined;
    const layoutFor = () => {
      const s = snapshot.current;
      const track = s.tracks.find((t) => t.id === s.activeId);
      if (
        track?.kind !== "planned" ||
        !track.visible ||
        track.resultRevision !== track.revision ||
        track.result?.status !== "ok"
      )
        return;
      const route = track.result;
      const zoom = Math.round(m.getZoom());
      if (layout?.route === route && layout.zoom === zoom) return layout;
      const vertices = anchorVertices(route, s.anchors.length);
      if (!vertices) return;
      // Web Mercator at 512-pixel tiles, as MapLibre draws it.
      const handles = routeHandles(
        route.geometry,
        vertices,
        ([, lat]) =>
          (HANDLE_SPACING_PX *
            EARTH_CIRCUMFERENCE_M *
            Math.cos((lat * Math.PI) / 180)) /
          (512 * 2 ** zoom),
      );
      layout = { route, zoom, vertices, handles };
      return layout;
    };
    /** The same layout, only while the route is being edited on the map. */
    const editableLayout = () => {
      const s = snapshot.current;
      return s.editable && s.anchors.length >= 2 ? layoutFor() : undefined;
    };
    /** The leg a fractional route position falls on, numbered by its end waypoint. */
    const legOf = (vertices: number[], position: number) => {
      const leg = vertices.findIndex((v, k) => k > 0 && v >= position);
      return leg < 0 ? vertices.length - 1 : leg;
    };
    const pinchesFor = (grab: RouteGrab): Pinches | undefined => {
      const l = layoutFor();
      return l && pinchesAround(l.vertices, l.handles, grab);
    };
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
      const l = layoutFor();
      return {
        ...nearest,
        index: l
          ? legOf(l.vertices, nearest.position)
          : insertionIndex(line, s.anchors.map(project), nearest.position),
      };
    };

    // Route handles are real markers, so a finger can drag them where no hover exists.
    type HandleMarker = {
      marker: maplibregl.Marker;
      element: HTMLElement;
      handle: Pinch;
    };
    const handleMarkers: HandleMarker[] = [];
    /** Mark the stops an edit would branch from, so the user sees them before acting. */
    const highlight = (pinches?: Pinches) => {
      for (const { element, handle: h } of handleMarkers)
        element.classList.toggle(
          "is-branch",
          h === pinches?.before || h === pinches?.after,
        );
    };
    const handleGrabOf = (h: Pinch): RouteGrab | undefined => {
      const l = layoutFor();
      return (
        l && {
          kind: "insert",
          index: legOf(l.vertices, h.position),
          position: h.position,
        }
      );
    };
    const createHandleMarker = (): HandleMarker => {
      const element = document.createElement("div");
      element.className = "route-handle";
      element.title = "Drag to reshape route";
      element.setAttribute("aria-label", "Drag to reshape route");
      element.append(
        Object.assign(document.createElement("span"), {
          className: "route-handle-dot",
        }),
      );
      const managed: HandleMarker = {
        element,
        marker: new maplibregl.Marker({ element, draggable: true }),
        handle: { position: 0, point: [0, 0] },
      };
      const { marker } = managed;
      marker.on("dragstart", () => {
        const grab = handleGrabOf(managed.handle);
        if (grab) begin(grab);
      });
      marker.on("drag", () => {
        const p = marker.getLngLat();
        preview([p.lng, p.lat]);
      });
      marker.on("dragend", () => {
        suppressClickUntil = Date.now() + 400;
        const p = marker.getLngLat();
        const edit = finishEdit();
        marker.setLngLat(managed.handle.point);
        if (edit?.grab.kind === "insert")
          handlers.current.onInclude(
            edit.grab.index,
            [p.lng, p.lat],
            edit.pinches,
          );
      });
      element.addEventListener("mouseenter", () => {
        if (dragging) return;
        const grab = handleGrabOf(managed.handle);
        highlight(grab && pinchesFor(grab));
      });
      element.addEventListener("mouseleave", () => {
        if (!dragging) highlight();
      });
      element.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openContextMenu(m.project(managed.handle.point));
      });
      return managed;
    };
    /** Draw the handles that fall on or near the screen; never while a drag holds one. */
    const syncHandles = () => {
      if (dragging) return;
      const l = editableLayout();
      const { clientWidth: width, clientHeight: height } = m.getContainer();
      const pad = HANDLE_SPACING_PX;
      const shown = (l?.handles ?? [])
        .filter((h) => {
          const q = m.project(h.point);
          return (
            q.x >= -pad &&
            q.x <= width + pad &&
            q.y >= -pad &&
            q.y <= height + pad
          );
        })
        .slice(0, MAX_HANDLES);
      while (handleMarkers.length < shown.length)
        handleMarkers.push(createHandleMarker());
      while (handleMarkers.length > shown.length)
        handleMarkers.pop()!.marker.remove();
      shown.forEach((h, i) => {
        const managed = handleMarkers[i];
        managed.handle = h;
        managed.marker.setLngLat(h.point);
        if (!managed.element.isConnected) managed.marker.addTo(m);
      });
      highlight();
    };

    m.on("mousemove", (e) => {
      if (dragging || e.originalEvent.buttons) return;
      // Over a route handle, that handle is the target and has highlighted its own branches.
      if (
        (e.originalEvent.target as Element | null)?.closest?.(".route-handle")
      ) {
        handle.remove();
        return;
      }
      const hit = locate(e.point);
      const nearHandle =
        hit &&
        handleMarkers.some(({ handle: h }) => {
          const q = m.project(h.point);
          return (
            Math.hypot(q.x - hit.point[0], q.y - hit.point[1]) < HANDLE_CLEAR_PX
          );
        });
      if (!hit || hit.distance > 12 || nearHandle) {
        handle.remove();
        highlight();
        return;
      }
      handleGrab = { kind: "insert", index: hit.index, position: hit.position };
      highlight(pinchesFor(handleGrab));
      handle.setLngLat(m.unproject(hit.point));
      if (!handleElement.isConnected) handle.addTo(m);
    });

    // While a drag is under way, dashed lines run to the pointer from both stops the edit
    // branches from, a pinch or the neighbouring waypoint: the stretch the drop will
    // reroute, and nothing beyond it. Pinches get a dot, since they are not waypoints yet.
    let editing: { grab: RouteGrab; pinches?: Pinches } | undefined;
    const branches = ({ grab, pinches }: NonNullable<typeof editing>) => {
      const anchors = snapshot.current.anchors;
      const [lower, upper] =
        grab.kind === "move"
          ? [grab.index - 1, grab.index + 1]
          : [grab.index - 1, grab.index];
      return [
        pinches?.before?.point ?? anchors[lower],
        pinches?.after?.point ?? anchors[upper],
      ].filter((p): p is Point => p !== undefined);
    };
    const preview = (pointer?: Point) => {
      const s = snapshot.current;
      const properties = {
        color: s.tracks.find((t) => t.id === s.activeId)?.color ?? CENTER_COLOR,
      };
      const pins = [editing?.pinches?.before, editing?.pinches?.after].filter(
        (pin): pin is Pinch => pin !== undefined,
      );
      (
        m.getSource("edit-preview") as maplibregl.GeoJSONSource | undefined
      )?.setData(
        pointer && editing
          ? {
              type: "FeatureCollection",
              features: [
                ...branches(editing).map((from) => ({
                  type: "Feature" as const,
                  properties,
                  geometry: {
                    type: "LineString" as const,
                    coordinates: [from, pointer],
                  },
                })),
                ...pins.map((pin) => ({
                  type: "Feature" as const,
                  properties,
                  geometry: { type: "Point" as const, coordinates: pin.point },
                })),
              ],
            }
          : empty,
      );
    };
    const begin = (grab: RouteGrab) => {
      dragging = true;
      contextPopup?.remove();
      editing = { grab, pinches: pinchesFor(grab) };
      highlight(editing.pinches);
    };
    const finishEdit = () => {
      const edit = editing;
      editing = undefined;
      dragging = false;
      preview();
      highlight();
      return edit;
    };
    handle.on("dragstart", () => begin(handleGrab));
    handle.on("drag", () => {
      const p = handle.getLngLat();
      preview([p.lng, p.lat]);
    });
    handle.on("dragend", () => {
      suppressClickUntil = Date.now() + 400;
      const p = handle.getLngLat();
      handle.remove();
      const edit = finishEdit();
      handlers.current.onInclude(
        handleGrab.index,
        [p.lng, p.lat],
        edit?.pinches,
      );
    });
    markerCallbacks.current = {
      onMenu: (i, x, y) => handlers.current.onMenu(i, x, y),
      onDragStart: (i) => begin({ kind: "move", index: i }),
      onDrag: (_, p) => preview(p),
      onMove: (i, p) => handlers.current.onMove(i, p, finishEdit()?.pinches),
    };
    // Street View and the OSM editor snap to a visible track first, then to a drawn road or
    // trail, so a loose right-click still lands on the way. Satellite draws no roads; there, and away from
    // any way, the click itself is used and Google picks the closest panorama.
    const streetPoint = (point: maplibregl.Point): Point => {
      const project = (p: Point): Point => {
        const q = m.project(p);
        return [q.x, q.y];
      };
      const at: Point = [point.x, point.y];
      const tracks = snapshot.current.tracks
        .filter((t) => t.visible && t.result?.status === "ok")
        .map((t) => t.result!.geometry.map(project));
      const roads = m
        .queryRenderedFeatures([
          [point.x - SNAP_PX, point.y - SNAP_PX],
          [point.x + SNAP_PX, point.y + SNAP_PX],
        ])
        .filter(
          (f) =>
            f.sourceLayer === "trail" ||
            (f.sourceLayer === "transportation" &&
              STREET_CLASSES.has(f.properties.class)),
        )
        .flatMap((f): Point[][] =>
          f.geometry.type === "LineString"
            ? [f.geometry.coordinates as Point[]]
            : f.geometry.type === "MultiLineString"
              ? (f.geometry.coordinates as Point[][])
              : [],
        )
        .map((line) => line.map(project));
      const snapped =
        snapToLines(tracks, at, SNAP_PX) ??
        snapToLines(roads, at, SNAP_PX) ??
        at;
      const q = m.unproject(snapped);
      return [q.lng, q.lat];
    };
    const openContextMenu = (point: maplibregl.Point) => {
      const hit = locate(point);
      const street = streetPoint(point);
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
      // Including is a change to the route, where dragging a handle is an adjustment to it:
      // one waypoint and no pinches, so the whole stretch from the previous waypoint to the
      // next is routed again. Legs it does not touch are still reused.
      if (hit)
        action("Include in route", () =>
          handlers.current.onInclude(hit.index, [location.lng, location.lat]),
        );
      action("Edit in OSM", () =>
        window.open(
          osmEditURL(street, m.getZoom()),
          "_blank",
          "noopener,noreferrer",
        ),
      );
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
      openContextMenu(e.point);
    });
    // The handle sits under the cursor whenever it is near the route, so a right-click
    // there lands on the marker element and never reaches the map's own listener.
    handleElement.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const box = m.getCanvasContainer().getBoundingClientRect();
      openContextMenu(
        new maplibregl.Point(event.clientX - box.left, event.clientY - box.top),
      );
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
        openContextMenu(e.point);
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
      for (const id of [
        "cells",
        "field",
        "corridor",
        "reference",
        "route",
        "edit-preview",
        "cursor",
      ])
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
      // Added last, so a pinch dot is never hidden under the route it sits on.
      m.addLayer({
        id: "edit-preview-line",
        type: "line",
        source: "edit-preview",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 4,
          "line-dasharray": [2, 1.5],
          "line-opacity": 0.9,
        },
      });
      m.addLayer({
        id: "edit-preview-pinch",
        type: "circle",
        source: "edit-preview",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 8,
          "circle-color": ["get", "color"],
          "circle-stroke-color": CENTER_COLOR,
          "circle-stroke-width": 3,
        },
      });
      // Last of all: pointing at a section from the Stats tab has to be visible on top of
      // whatever it lands on. A circle layer rather than a DOM marker, so it pans and
      // zooms with the map and nothing has to be kept in sync with a transform.
      m.addLayer({
        id: "cursor-dot",
        type: "circle",
        source: "cursor",
        paint: {
          "circle-radius": 7,
          // The track's colour inside a white ring, like a pinch dot: the fallback colour
          // is itself `CENTER_COLOR`, so filling with that would hide the dot in its own
          // ring on a track that has no colour yet.
          "circle-color": ["get", "color"],
          "circle-stroke-color": CENTER_COLOR,
          "circle-stroke-width": 3,
        },
      });
      update();
    });
    function update() {
      if (!dragging) handle.remove();
      contextPopup?.remove();
      syncHandles();
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
      handleMarkers.forEach(({ marker }) => marker.remove());
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
    if (!markers.current) markers.current = new MarkerLayer(m, markerCallbacks);
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
    // Handled before the shared `points` path below, which treats a single point as a
    // flyTo at zoom 13 — that is right for "fit one thing" and wrong here, where the
    // rider is reading the route and would lose the overview they are reading it against.
    if (command.kind === "locate") {
      const target = command.points?.[0];
      if (target && !m.getBounds().contains(target))
        m.easeTo({ center: target, duration: instant ? 0 : 400 });
      return;
    }
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
          bottom: Math.min(bottomInsetRef.current, innerHeight * 0.7),
          left: 45,
          right: 90,
        },
        maxZoom: 15,
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 700,
      });
    }
  }, [command]);
  // Fed separately from `update()`, which owns the route sources: the two change on
  // different beats, and pointing at a section must not wait on a routing result. A
  // basemap switch re-runs `style.load`, which re-adds every source empty, so the mark is
  // cleared until the next locate — cheaper than keeping a second copy of it in sync.
  // Held as a string so the effect re-runs when the colour actually changes. Depending on
  // the tracks array instead would re-send the mark on every render, since the array is
  // rebuilt each time.
  const cursorColor =
    tracks.find((t) => t.id === activeId)?.color ?? CENTER_COLOR;
  useEffect(() => {
    const source = map.current?.getSource("cursor") as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!source) return;
    source.setData(
      cursor
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: { color: cursorColor },
                geometry: { type: "Point", coordinates: cursor },
              },
            ],
          }
        : empty,
    );
  }, [cursor, cursorColor]);
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
