import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { PMTiles, Protocol, type Source } from "pmtiles";
import { readRange, type Installed } from "../offline/store";
import type {
  Attraction,
  Comparison,
  Point,
  RouteResult,
} from "../routing/types";
import { customMapStyle, mapResourceURL, mapStyle } from "./style";
const empty = { type: "FeatureCollection" as const, features: [] };
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);
export function MapView({
  pack,
  remoteMap,
  anchors,
  attraction,
  comparison,
  partial,
  debug,
  history,
  onPoint,
  onMove,
  onError,
}: {
  pack?: Installed;
  remoteMap: string;
  anchors: Point[];
  attraction?: Attraction;
  comparison?: Comparison;
  partial?: RouteResult;
  debug: boolean;
  history: boolean;
  onPoint: (p: Point) => void;
  onMove: (i: number, p: Point) => void;
  onError: (error: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    map = useRef<maplibregl.Map | undefined>(undefined),
    markers = useRef<maplibregl.Marker[]>([]);
  const handlers = useRef({ onPoint, onMove, onError });
  handlers.current = { onPoint, onMove, onError };
  const snapshot = useRef({
    anchors,
    attraction,
    comparison,
    partial,
    debug,
    history,
  });
  snapshot.current = {
    anchors,
    attraction,
    comparison,
    partial,
    debug,
    history,
  };
  useEffect(() => {
    let url = `pmtiles://${remoteMap}`;
    if (pack) {
      const key = `cyclatractor-${pack.directory}`;
      const source: Source = {
        getKey: () => key,
        getBytes: async (offset, length) => ({
          data: await readRange(pack, "basemap.pmtiles", offset, length),
        }),
      };
      protocol.add(new PMTiles(source));
      url = `pmtiles://${key}`;
    }
    const customURL = customMapStyle(import.meta.env.VITE_MAPTILER_API_KEY);
    let usingCustom = Boolean(customURL && navigator.onLine);
    const m = new maplibregl.Map({
      container: container.current!,
      style: usingCustom ? customURL! : mapStyle(url),
      transformRequest: (resource) => ({
        url: mapResourceURL(resource, import.meta.env.VITE_MAPTILER_API_KEY),
      }),
      center: [6.205, 46.19],
      zoom: 10.7,
      minZoom: 7,
      maxZoom: 16,
      attributionControl: { compact: true },
      maxBounds: [
        [5.6, 45.8],
        [6.8, 46.6],
      ],
    });
    map.current = m;
    m.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );
    m.on("click", (e) =>
      handlers.current.onPoint([e.lngLat.lng, e.lngLat.lat]),
    );
    m.on("idle", () => {
      if (
        container.current &&
        m
          .queryRenderedFeatures()
          .some((f) => usingCustom || f.source === "basemap")
      )
        container.current.dataset.ready = "true";
    });
    let reported = false,
      disposed = false;
    m.on("error", () => {
      if (disposed) return;
      if (usingCustom) {
        usingCustom = false;
        m.setStyle(mapStyle(url));
        return;
      }
      if (!reported && !disposed) {
        reported = true;
        handlers.current.onError(
          "Map data unavailable. Build or install the Geneva region.",
        );
      }
    });
    m.on("style.load", () => {
      for (const id of [
        "field",
        "corridor",
        "reference",
        "route",
        "attraction",
      ])
        m.addSource(id, { type: "geojson", data: empty });
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
        paint: { "line-color": "#cb6241", "line-width": 4 },
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
    const places: [string, Point][] = [
      ["GENÈVE", [6.1432, 46.2044]],
      ["Annemasse", [6.235, 46.195]],
      ["LE SALÈVE", [6.19, 46.1]],
      ["LES VOIRONS", [6.37, 46.235]],
      ["Saint-Julien", [6.081, 46.145]],
      ["Lac Léman", [6.25, 46.32]],
    ];
    const placeMarkers: maplibregl.Marker[] = [];
    for (const [name, p] of places) {
      const el = document.createElement("div");
      el.className = "place-label";
      el.textContent = name;
      el.hidden = usingCustom;
      placeMarkers.push(
        new maplibregl.Marker({ element: el }).setLngLat(p).addTo(m),
      );
    }
    m.on("style.load", () => {
      for (const marker of placeMarkers)
        marker.getElement().hidden = usingCustom;
    });
    const changeConnection = () => {
      usingCustom = Boolean(customURL && navigator.onLine);
      m.setStyle(usingCustom ? customURL! : mapStyle(url));
    };
    window.addEventListener("online", changeConnection);
    window.addEventListener("offline", changeConnection);
    function update() {
      const s = snapshot.current;
      const route = s.comparison?.corridor ?? s.partial;
      (m.getSource("field") as maplibregl.GeoJSONSource)?.setData(
        s.debug && s.comparison?.fieldView ? s.comparison.fieldView : empty,
      );
      const line = (geometry: Point[]) => ({
        type: "Feature" as const,
        properties: {},
        geometry: { type: "LineString" as const, coordinates: geometry },
      });
      (m.getSource("route") as maplibregl.GeoJSONSource)?.setData(
        route?.status === "ok" ? line(route.geometry) : empty,
      );
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
  }, [pack?.directory, remoteMap]);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    m.fire("cyclatractor-update");
    markers.current.forEach((marker) => marker.remove());
    markers.current = anchors.map((p, i) => {
      const element = document.createElement("button");
      element.className = "anchor-marker";
      element.textContent = String.fromCharCode(65 + i);
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
    pack?.directory,
  ]);
  return (
    <div ref={container} className="map" aria-label="Geneva basin route map" />
  );
}
