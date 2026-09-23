/**
 * The right-click menu on the map: include a point in the route, open the way in the OSM
 * editor, or look at it in Street View.
 *
 * It owns its popup, so the rest of the map closes it through `close()` rather than
 * reaching for a shared variable — the popup used to be an outer binding that three
 * unrelated places cleared. Snapping is the interesting part: the menu's two links are
 * about a *way*, not about the pixel clicked, so the point is pulled onto a visible track
 * first and a drawn road or trail second. Satellite draws no roads, and away from any way
 * the raw click is used, leaving Google to pick the closest panorama.
 */
import maplibregl from "maplibre-gl";
import { snapToLines } from "./routeEditing";
import { hotelsURL, osmEditURL, streetViewURL } from "./style";
import { freshResult, type Track } from "../tracks";
import type { Point } from "../routing/types";

/** Basemap road kinds a panorama can stand on: not rail, lifts or ferry lines. */
const STREET_KINDS = new Set([
  "highway",
  "major_road",
  "minor_road",
  "path",
  "other",
]);

/** How far, in pixels, a right-click reaches to snap onto a way. */
const SNAP_PX = 16;

export type ContextMenu = {
  /** Open at a point in map pixels. */
  open: (point: maplibregl.Point) => void;
  /** Close it if it is open; safe to call when it is not. */
  close: () => void;
};

export function createContextMenu(options: {
  map: maplibregl.Map;
  /** Visible tracks, read at open time rather than captured. */
  tracks: () => Track[];
  /** The route stretch under a point, when the pointer is on the active route. */
  locate: (point: maplibregl.Point) => { index: number } | undefined;
  /** Include a point in the route as a new waypoint. */
  onInclude: (index: number, point: Point) => void;
  /** Called before opening, so the hover handle does not sit over the menu. */
  beforeOpen: () => void;
}): ContextMenu {
  const { map: m, tracks, locate, onInclude, beforeOpen } = options;
  let popup: maplibregl.Popup | undefined;
  const close = () => {
    popup?.remove();
    popup = undefined;
  };

  const streetPoint = (point: maplibregl.Point): Point => {
    const project = (p: Point): Point => {
      const q = m.project(p);
      return [q.x, q.y];
    };
    const at: Point = [point.x, point.y];
    const lines = tracks()
      .filter((t) => t.visible)
      .map(freshResult)
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => r.geometry.map(project));
    const roads = m
      .queryRenderedFeatures([
        [point.x - SNAP_PX, point.y - SNAP_PX],
        [point.x + SNAP_PX, point.y + SNAP_PX],
      ])
      .filter(
        (f) =>
          f.sourceLayer === "cycle_routes" ||
          (f.sourceLayer === "roads" && STREET_KINDS.has(f.properties.kind)),
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
      snapToLines(lines, at, SNAP_PX) ?? snapToLines(roads, at, SNAP_PX) ?? at;
    const q = m.unproject(snapped);
    return [q.lng, q.lat];
  };

  const open = (point: maplibregl.Point) => {
    const hit = locate(point);
    const street = streetPoint(point);
    beforeOpen();
    close();
    const location = m.unproject(point);
    const menu = document.createElement("div");
    menu.className = "map-context-menu";
    const action = (label: string, run: () => void, disabled = false) => {
      const button = document.createElement("button");
      button.textContent = label;
      button.disabled = disabled;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        close();
        run();
      });
      menu.append(button);
    };
    // Including is a change to the route, where dragging a handle is an adjustment to it:
    // one waypoint and no pinches, so the whole stretch from the previous waypoint to the
    // next is routed again. Legs it does not touch are still reused.
    if (hit)
      action("Include in route", () =>
        onInclude(hit.index, [location.lng, location.lat]),
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
    // Where the rider pointed, not the nearest road: a hotel need not sit on one.
    action("Hotels near here", () =>
      window.open(
        hotelsURL([location.lng, location.lat]),
        "_blank",
        "noopener,noreferrer",
      ),
    );
    // Dismissing by tapping the map would drop a waypoint in the Edit tab, so the menu
    // closes itself.
    menu.append(
      Object.assign(document.createElement("hr"), { className: "menu-rule" }),
    );
    action("Close", () => {});
    popup = new maplibregl.Popup({
      closeButton: false,
      className: "map-context-popup",
    })
      .setLngLat(location)
      .setDOMContent(menu)
      .addTo(m);
  };

  return { open, close };
}
