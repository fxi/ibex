/**
 * Every source and layer the app draws, in the order they stack.
 *
 * This is declaration, not behaviour: it adds empty GeoJSON sources and the paint that
 * reads them, and is re-run on every `style.load` — switching the basemap discards the
 * whole style, so these go back on top of the new one. Nothing here needs tearing down;
 * removing the map takes it all with it. Data arrives separately, through syncSources.
 */
import type maplibregl from "maplibre-gl";
import {
  CENTER_COLOR,
  SURFACE_STYLE,
  trackColorExpression,
  trackWidthExpression,
} from "./rideStyle";

/** Below this zoom the grid is context only: one stray click must not queue an area. */
export const MIN_SELECT_ZOOM = 5;
/** What a source holds until data arrives, and what it is reset to. */
export const empty = { type: "FeatureCollection" as const, features: [] };

export function addAppLayers(m: maplibregl.Map) {
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
    // setData call rather than a layer rebuild. No symbol layer: labelling needs the
    // basemap's glyphs, which stay online-only, so sizes live in the panel instead.
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
}
