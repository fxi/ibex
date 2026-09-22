import { insertionIndex, nearestPosition } from "./routeEditing";
import { LONG_PRESS_MS, MarkerLayer, type MarkerCallbacks } from "./markers";
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
import { mapResourceURL, mapStyle, type Basemap } from "./style";
import { freshResult, type Track } from "../tracks";

import type { CellState } from "../offline/cells";
import type { CellId } from "../geo/grid";
import { CENTER_COLOR } from "./rideStyle";
import { addAppLayers, empty, MIN_SELECT_ZOOM } from "./layers";
import { createContextMenu } from "./contextMenu";
import { syncSources } from "./sources";
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

/** One-shot imperative camera instruction. `id` makes repeats of the same action distinct. */
export type MapCommand = {
  id: number;
  kind: "fit" | "zoomIn" | "zoomOut" | "resetNorth" | "locate";
  points?: Point[];
};
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
  grid,
  cellStates,
  gridZoom,
  command,
  cursor,
  bottomInset,
  basemap,
}: {
  basemap: Basemap;
  tracks: Track[];
  activeId?: string;
  /** Whether the download grid is drawn at all: it belongs to the Data tab. */
  grid: boolean;
  cellStates?: Map<CellId, CellState>;
  gridZoom?: number;
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
    grid,
    cellStates,
    gridZoom,
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
    grid,
    cellStates,
    gridZoom,
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
    //
    // A cell nobody has built is drawn but not selectable, and must not swallow the click:
    // the grid covers the whole world, so otherwise every click anywhere outside the built
    // area would be eaten by a grey square instead of dropping a waypoint.
    m.on("click", "cells-fill", (e) => {
      if (m.getZoom() < MIN_SELECT_ZOOM) return;
      const properties = e.features?.[0]?.properties;
      if (properties?.state === "unavailable") return;
      const id = properties?.id;
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
      const route = track && freshResult(track);
      if (track?.kind !== "planned" || !track.visible || !route) return;
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
      const route = track && freshResult(track);
      if (
        !s.editable ||
        track?.kind !== "planned" ||
        !track.visible ||
        !route ||
        s.anchors.length < 2
      )
        return;
      const project = (p: Point): Point => {
        const q = m.project(p);
        return [q.x, q.y];
      };
      const line = route.geometry.map(project);
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
      contextMenu.close();
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
    const contextMenu = createContextMenu({
      map: m,
      tracks: () => snapshot.current.tracks,
      locate,
      onInclude: (index, point) => handlers.current.onInclude(index, point),
      beforeOpen: () => handle.remove(),
    });
    const openContextMenu = (point: maplibregl.Point) => contextMenu.open(point);
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
        // Same gesture as a waypoint marker's long-press, but over maplibre's touch
        // events rather than a DOM element, so only the duration is shared.
      }, LONG_PRESS_MS);
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
      addAppLayers(m);
      update();
    });
    function update() {
      if (!dragging) handle.remove();
      contextMenu.close();
      syncHandles();
      syncSources(m, snapshot.current);
    }
    m.on("ibex-update", update);
    return () => {
      disposed = true;
      cancelPress();
      handle.remove();
      handleMarkers.forEach(({ marker }) => marker.remove());
      contextMenu.close();
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
  // Markers reconcile by index; only the anchors and the editing mode can change them, so
  // nothing else belongs in this dependency list. Recreating them on every data change
  // dropped live drags. Waypoints are handles for editing, and editing is the Edit tab:
  // elsewhere the map shows the route itself, with nothing on it that invites a drag.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!markers.current) markers.current = new MarkerLayer(m, markerCallbacks);
    markers.current.sync(editable ? anchors : []);
  }, [anchors, editable]);
  // Redrawing the geojson sources is separate from the markers, and every rendered input
  // has to be listed here or its layer silently stops updating.
  useEffect(() => {
    map.current?.fire("ibex-update");
  }, [
    editable,
    anchors,
    comparison,
    partial,
    debug,
    history,
    tracks,
    activeId,
    grid,
    cellStates,
    gridZoom,
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
