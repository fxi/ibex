import { useEffect, useRef, useState } from "react";
import { preference, savePreference } from "../offline/store";

const KEY = "panel-height";
/** Leave room for the brand header and the map controls above the panel. */
const TOP_GUTTER = 120;
/** Below this the pointer was held still: a tap on the handle, not a drag. */
const SLOP = 4;
/**
 * A drag that ends shorter than this was reducing the panel, not choosing a size, so it
 * does not become the height the handle expands back to.
 */
const MIN_EXPANDED = 160;

const clamp = (px: number) =>
  Math.max(0, Math.min(px, Math.max(0, window.innerHeight - TOP_GUTTER)));

/** A sensible first height when nothing is stored, scaled to the viewport. */
const initial = () => clamp(Math.round(window.innerHeight * 0.42));

export type PanelHeight = ReturnType<typeof usePanelHeight>;

/**
 * The planner panel's content height is explicit rather than content-driven.
 *
 * The panel is bottom-anchored, so any content-sized height moves its top edge whenever
 * the tab, an error banner or an expanded section changes — the layout shift this
 * replaces. Holding one resolved pixel height means switching tabs cannot move anything.
 *
 * The panel never closes. Reduced is the content at zero, so the tabs stay on screen and
 * are still the way back; the handle expands it again. Whatever height the user drags to
 * becomes the one a tap returns to, and that is what is remembered across reloads.
 */
export function usePanelHeight() {
  const [height, setHeight] = useState(initial);
  // The user's chosen size: where a tap expands back to, and what is persisted.
  const [expanded, setExpanded] = useState(initial);
  const [resizing, setResizing] = useState(false);
  // A drag ends in a click event too; that one must not also toggle.
  const dragged = useRef(false);

  useEffect(() => {
    let disposed = false;
    preference<number>(KEY)
      .then((v) => {
        if (disposed || typeof v !== "number" || !Number.isFinite(v)) return;
        const stored = clamp(v);
        if (stored < MIN_EXPANDED) return;
        setExpanded(stored);
        setHeight(stored);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  // A window resize can leave a stored height taller than the viewport.
  useEffect(() => {
    const onResize = () => {
      setHeight((h) => clamp(h));
      setExpanded((h) => clamp(h));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Persist the chosen size once it settles, not the live drag and not the reduced state:
  // reopening the app on a panel the user had folded away for a moment would be wrong.
  // An effect rather than a state updater keeps the write out of render, where StrictMode
  // would run it twice.
  const loaded = useRef(false);
  useEffect(() => {
    if (resizing) return;
    if (!loaded.current) {
      // Skip the first settle: it is the default, before the stored value has arrived.
      loaded.current = true;
      return;
    }
    const timer = setTimeout(
      () => savePreference(KEY, expanded).catch(() => {}),
      120,
    );
    return () => clearTimeout(timer);
  }, [expanded, resizing]);

  function toggle() {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    setHeight((h) => (h > 0 ? 0 : clamp(expanded)));
  }

  function startResize(event: React.PointerEvent<HTMLElement>) {
    const target = event.currentTarget;
    const startY = event.clientY;
    const startHeight = height;
    let latest = startHeight;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      if (!dragged.current) {
        if (Math.abs(e.clientY - startY) <= SLOP) return;
        dragged.current = true;
        setResizing(true);
      }
      // The panel grows upward, so dragging up (negative delta) makes it taller.
      latest = clamp(startHeight - (e.clientY - startY));
      setHeight(latest);
    };
    const stop = (e: PointerEvent) => {
      setResizing(false);
      if (dragged.current && latest >= MIN_EXPANDED) setExpanded(latest);
      // A cancelled gesture is followed by no click, so the flag that suppresses that
      // click has to be cleared here or it would swallow the next tap instead.
      if (e.type === "pointercancel") dragged.current = false;
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      target.removeEventListener("pointercancel", stop);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
    target.addEventListener("pointercancel", stop);
  }

  return { height, reduced: height <= 0, toggle, startResize, resizing };
}
