import { useEffect, useRef, useState } from "react";
import { Layers } from "lucide-react";
import { BASEMAPS, type Basemap } from "./style";

/** Compact base map picker, opened from the map controls column. */
export function BasemapControl({
  value,
  onChange,
}: {
  value: Basemap;
  onChange: (value: Basemap) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <div className="basemap-control" ref={box}>
      <button
        aria-label="Base map"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Layers />
      </button>
      {open && (
        <div className="basemap-menu" role="radiogroup" aria-label="Base map">
          {BASEMAPS.map((b) => (
            <button
              key={b.id}
              role="radio"
              aria-checked={value === b.id}
              onClick={() => {
                onChange(b.id);
                setOpen(false);
              }}
            >
              <i className={`basemap-swatch ${b.id}`} />
              <span>{b.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
