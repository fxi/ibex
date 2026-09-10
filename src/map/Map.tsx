import { selectedRoute } from "../routing/selection";
import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import type {
  Attraction,
  Comparison,
  Point,
  RouteResult,
} from "../routing/types";
import { customMapStyle, mapResourceURL } from "./style";
import type { Track } from "../tracks";
export type MapCommand = { id: number; points: Point[] };
const empty = { type: "FeatureCollection" as const, features: [] };
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);
export function MapView({
  anchors,
  attraction,
  comparison,
  partial,
  debug,
  history,
  onPoint,
  onMove,
  tracks,
  activeId,
  coverage,
  command,
}: {
  tracks: Track[];
  activeId?: string;
  coverage?: [number, number, number, number];
  command?: MapCommand;
  anchors: Point[];
  attraction?: Attraction;
  comparison?: Comparison;
  partial?: RouteResult;
  debug: boolean;
  history: boolean;
  onPoint: (p: Point) => void;
  onMove: (i: number, p: Point) => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    map = useRef<maplibregl.Map | undefined>(undefined),
    markers = useRef<maplibregl.Marker[]>([]);
  const [mapError, setMapError] = useState("");
  const handlers = useRef({ onPoint, onMove });
  handlers.current = { onPoint, onMove };
  const snapshot = useRef({
    anchors,
    attraction,
    comparison,
    partial,
    debug,
    history,
    tracks,
    activeId,
    coverage,
  });
  snapshot.current = {
    anchors,
    attraction,
    comparison,
    partial,
    debug,
    history,
    tracks,
    activeId,
    coverage,
  };
  useEffect(() => {
    const key = import.meta.env.VITE_MAPTILER_API_KEY;
    if (!key?.trim()) {
      setMapError("Map unavailable: no map access key is configured.");
      return;
    }
    const m = new maplibregl.Map({
      container: container.current!,
      style: customMapStyle(key),
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
    m.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );
    m.on("click", (e) =>
      handlers.current.onPoint([e.lngLat.lng, e.lngLat.lat]),
    );
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
        "coverage",
        "field",
        "corridor",
        "reference",
        "route",
        "attraction",
      ])
        m.addSource(id, { type: "geojson", data: empty });
      m.addLayer({
        id: "coverage-fill",
        type: "fill",
        source: "coverage",
        paint: { "fill-color": "#2485ff", "fill-opacity": 0.1 },
      });
      m.addLayer({
        id: "coverage-line",
        type: "line",
        source: "coverage",
        paint: {
          "line-color": "#72b4ff",
          "line-width": 2,
          "line-dasharray": [3, 2],
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
        paint: { "line-color": "#fffdf5", "line-width": 8 },
      });
      m.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["case", ["get", "active"], 5, 3],
          "line-opacity": ["case", ["get", "stale"], 0.5, 1],
        },
      });
      m.addLayer({
        id: "attraction",
        type: "circle",
        source: "attraction",
        paint: {
          "circle-radius": 35,
          "circle-color": "#dba748",
          "circle-opacity": 0.25,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#b58731",
        },
      });
      update();
    });
    function update() {
      if (!m.getSource("route")) return;
      const s = snapshot.current;
      const route = selectedRoute(s.comparison, s.partial);
      const b = s.coverage;
      (m.getSource("coverage") as maplibregl.GeoJSONSource)?.setData(
        b
          ? {
              type: "Feature",
              properties: {},
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [b[0], b[1]],
                    [b[2], b[1]],
                    [b[2], b[3]],
                    [b[0], b[3]],
                    [b[0], b[1]],
                  ],
                ],
              },
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
          .map((t) => ({
            ...line(t.result!.geometry),
            properties: {
              color: t.color,
              active: t.id === s.activeId,
              stale: t.resultRevision !== t.revision,
            },
          })),
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
      (m.getSource("attraction") as maplibregl.GeoJSONSource)?.setData(
        s.attraction
          ? {
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: s.attraction.point },
            }
          : empty,
      );
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
      window.removeEventListener("online", changeConnection);
      window.removeEventListener("offline", changeConnection);
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
      m.remove();
      map.current = undefined;
    };
  }, []);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    m.fire("cyclatractor-update");
    markers.current.forEach((marker) => marker.remove());
    markers.current = anchors.map((p, i) => {
      const element = document.createElement("button");
      element.className = "anchor-marker";
      element.textContent = String(i + 1);
      element.setAttribute("aria-label", `Move waypoint ${i + 1}`);
      const marker = new maplibregl.Marker({ element, draggable: true })
        .setLngLat(p)
        .addTo(m);
      marker.on("dragend", () => {
        const p = marker.getLngLat();
        handlers.current.onMove(i, [p.lng, p.lat]);
      });
      return marker;
    });
  }, [
    anchors,
    attraction,
    comparison,
    partial,
    debug,
    history,
    tracks,
    activeId,
    coverage,
  ]);
  useEffect(() => {
    const m = map.current;
    if (!m || !command?.points.length) return;
    if (command.points.length === 1)
      m.flyTo({
        center: command.points[0],
        zoom: 13,
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 700,
      });
    else {
      const bounds = new maplibregl.LngLatBounds(
        command.points[0],
        command.points[0],
      );
      command.points.forEach((p) => bounds.extend(p));
      m.fitBounds(bounds, {
        padding: {
          top: 110,
          bottom: Math.min(innerHeight * 0.48, 430),
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
