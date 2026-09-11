import { useEffect, useRef } from "react";

export type WaypointMenuState = { index: number; x: number; y: number };

/**
 * A small menu pinned to a waypoint marker.
 *
 * Radix's dropdown wants a trigger element it owns; these markers are maplibre-managed
 * DOM created outside React, so the menu is positioned from the event coordinates
 * instead. It keeps the panel's `.menu.glass` styling so it reads as the same control.
 */
export function WaypointMenu({
  state,
  count,
  onClose,
  onRemove,
  onInsert,
}: {
  state: WaypointMenuState;
  count: number;
  onClose: () => void;
  onRemove: (index: number) => void;
  /** Arm an insertion at this position in the waypoint list. */
  onInsert: (index: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Defer: the press that opened the menu must not immediately close it.
    const timer = setTimeout(
      () => window.addEventListener("pointerdown", onDown),
      0,
    );
    box.current?.querySelector("button")?.focus();
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  // Keep the menu on screen when a marker sits near the right or bottom edge.
  const left = Math.min(state.x, window.innerWidth - 190);
  const top = Math.min(state.y, window.innerHeight - 160);

  return (
    <div
      ref={box}
      className="menu glass waypoint-menu"
      role="menu"
      aria-label={`Waypoint ${state.index + 1}`}
      style={{ left, top }}
    >
      <strong>Waypoint {state.index + 1}</strong>
      <button role="menuitem" onClick={() => onInsert(state.index)}>
        Insert waypoint before
      </button>
      <button role="menuitem" onClick={() => onInsert(state.index + 1)}>
        Insert waypoint after
      </button>
      <button
        role="menuitem"
        className="danger"
        disabled={count <= 0}
        onClick={() => onRemove(state.index)}
      >
        Remove
      </button>
    </div>
  );
}
