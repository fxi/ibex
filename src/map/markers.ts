import maplibregl from "maplibre-gl";
import markerSvg from "./marker.svg?raw";
import type { Point } from "../routing/types";

export type MarkerCallbacks = {
  onMove: (index: number, point: Point) => void;
  /** A drag began on a waypoint, so the edit it will make can be previewed. */
  onDragStart: (index: number) => void;
  /** The dragged waypoint is now over `point`. */
  onDrag: (index: number, point: Point) => void;
  /** Right-click or long-press on a waypoint, in viewport coordinates. */
  onMenu: (index: number, x: number, y: number) => void;
};

/** Milliseconds a press must be held before it counts as a long-press, not a tap. */
const LONG_PRESS_MS = 500;

type Managed = {
  marker: maplibregl.Marker;
  element: HTMLElement;
  label: SVGTextElement | null;
  dispose: () => void;
};

function create(
  index: number,
  point: Point,
  map: maplibregl.Map,
  callbacks: { current: MarkerCallbacks },
): Managed {
  const element = document.createElement("div");
  element.innerHTML = markerSvg;
  const svg = element.firstElementChild as SVGSVGElement;
  svg.classList.add("anchor-marker");
  element.className = "anchor-marker-wrap";
  element.setAttribute("role", "button");
  element.tabIndex = 0;

  const label = svg.querySelector<SVGTextElement>(".marker_content");
  const marker = new maplibregl.Marker({ element, draggable: true })
    .setLngLat(point)
    .addTo(map);

  // The index changes as waypoints are inserted or removed, so read it at event time
  // from the element rather than closing over the value it was created with.
  const indexOf = () => Number(element.dataset.index);

  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let dragTimer: ReturnType<typeof setTimeout> | undefined;
  // A drag ends with a synthetic click on the element. Without this guard every drag
  // would also fire the press handlers and open the menu.
  let draggedRecently = false;

  marker.on("dragstart", () => {
    draggedRecently = true;
    clearTimeout(pressTimer);
    callbacks.current.onDragStart(indexOf());
  });
  marker.on("drag", () => {
    const p = marker.getLngLat();
    callbacks.current.onDrag(indexOf(), [p.lng, p.lat]);
  });
  marker.on("dragend", () => {
    const p = marker.getLngLat();
    callbacks.current.onMove(indexOf(), [p.lng, p.lat]);
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => (draggedRecently = false), 100);
  });

  const openMenu = (x: number, y: number) => {
    if (draggedRecently) return;
    callbacks.current.onMenu(indexOf(), x, y);
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY);
  };
  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    pressTimer = setTimeout(
      () => openMenu(touch.clientX, touch.clientY),
      LONG_PRESS_MS,
    );
  };
  const cancelPress = () => clearTimeout(pressTimer);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    const box = element.getBoundingClientRect();
    openMenu(box.left + box.width / 2, box.bottom);
  };

  element.addEventListener("contextmenu", onContextMenu);
  element.addEventListener("touchstart", onTouchStart, { passive: true });
  element.addEventListener("touchmove", cancelPress, { passive: true });
  element.addEventListener("touchend", cancelPress);
  element.addEventListener("touchcancel", cancelPress);
  element.addEventListener("keydown", onKeyDown);

  const managed: Managed = {
    marker,
    element,
    label,
    dispose() {
      clearTimeout(pressTimer);
      clearTimeout(dragTimer);
      element.removeEventListener("contextmenu", onContextMenu);
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", cancelPress);
      element.removeEventListener("touchend", cancelPress);
      element.removeEventListener("touchcancel", cancelPress);
      element.removeEventListener("keydown", onKeyDown);
      marker.remove();
    },
  };
  number(managed, index);
  return managed;
}

function number(managed: Managed, index: number) {
  managed.element.dataset.index = String(index);
  managed.element.setAttribute("aria-label", `Waypoint ${index + 1}`);
  if (managed.label) managed.label.textContent = String(index + 1);
}

/**
 * Reconciles waypoint markers by position rather than rebuilding them.
 *
 * The previous implementation recreated every marker DOM node whenever any map data
 * changed, which dropped in-progress drags and re-ran every entry animation. Here only
 * the difference is applied: existing markers are moved and renumbered in place.
 */
export class MarkerLayer {
  private markers: Managed[] = [];
  constructor(
    private map: maplibregl.Map,
    private callbacks: { current: MarkerCallbacks },
  ) {}

  sync(anchors: Point[]) {
    for (let i = this.markers.length; i < anchors.length; i++)
      this.markers.push(create(i, anchors[i], this.map, this.callbacks));
    while (this.markers.length > anchors.length) this.markers.pop()!.dispose();
    this.markers.forEach((managed, i) => {
      const current = managed.marker.getLngLat();
      const [lng, lat] = anchors[i];
      // Skip the write when unchanged so a drag in flight is never fought.
      if (current.lng !== lng || current.lat !== lat)
        managed.marker.setLngLat(anchors[i]);
      if (managed.element.dataset.index !== String(i)) number(managed, i);
    });
  }

  destroy() {
    this.markers.forEach((m) => m.dispose());
    this.markers = [];
  }
}
