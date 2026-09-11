import { useEffect, useRef, useState } from "react";
import { preference, savePreference } from "../offline/store";

const KEY = "panel-height";
const MIN = 240;
/** Leave room for the brand header and the map controls above the panel. */
const TOP_GUTTER = 120;

const clamp = (px: number) =>
  Math.max(MIN, Math.min(px, Math.max(MIN, window.innerHeight - TOP_GUTTER)));

/** A sensible first height when nothing is stored, scaled to the viewport. */
const initial = () => clamp(Math.round(window.innerHeight * 0.42));

export type PanelHeight = ReturnType<typeof usePanelHeight>;

/**
 * The planner panel's height is explicit rather than content-driven.
 *
 * The panel is bottom-anchored, so any content-sized height moves its top edge whenever
 * the tab, an error banner or an expanded section changes — the layout shift this
 * replaces. Holding one resolved pixel height means switching tabs cannot move anything,
 * and the user's chosen size survives collapsing and reloading.
 */
export function usePanelHeight() {
  const [height, setHeight] = useState(initial);
  const [open, setOpen] = useState(true);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    let disposed = false;
    preference<number>(KEY)
      .then((v) => {
        if (!disposed && typeof v === "number" && Number.isFinite(v))
          setHeight(clamp(v));
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  // A window resize can leave a stored height taller than the viewport.
  useEffect(() => {
    const onResize = () => setHeight((h) => clamp(h));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Persist once the height settles. Doing this in an effect rather than inside a state
  // updater keeps the write out of render, where StrictMode would run it twice.
  const loaded = useRef(false);
  useEffect(() => {
    if (resizing) return;
    if (!loaded.current) {
      // Skip the first settle: it is the default, before the stored value has arrived.
      loaded.current = true;
      return;
    }
    const timer = setTimeout(
      () => savePreference(KEY, height).catch(() => {}),
      120,
    );
    return () => clearTimeout(timer);
  }, [height, resizing]);

  function startResize(event: React.PointerEvent<HTMLElement>) {
    if (!open) return;
    const target = event.currentTarget;
    const startY = event.clientY;
    const startHeight = height;
    setResizing(true);
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) =>
      // The panel grows upward, so dragging up (negative delta) makes it taller.
      setHeight(clamp(startHeight - (e.clientY - startY)));
    const stop = () => {
      setResizing(false);
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      target.removeEventListener("pointercancel", stop);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
    target.addEventListener("pointercancel", stop);
  }

  return { height, open, setOpen, startResize, resizing };
}
