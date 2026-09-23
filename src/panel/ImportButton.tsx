import { useRef } from "react";
import { parseGPX } from "../importers/gpx";
import { importedTrack } from "../tracks";
import type { PanelContext } from "./context";

/** Files larger than this are not hand-recorded rides; refuse rather than hang. */
const MAX_IMPORT_BYTES = 20_000_000;

/**
 * A button that picks GPX files and adds each as an imported track, the first one active.
 * Tracks and Tools both offer it; the file input is labelled the same in either.
 */
export function ImportButton({
  ctx,
  className,
  children,
  label,
  onImported,
}: {
  ctx: PanelContext;
  className?: string;
  /** Names an icon-only button. */
  label?: string;
  children: React.ReactNode;
  onImported?: (count: number) => void;
}) {
  const { tracks, setError, setTab } = ctx;
  const input = useRef<HTMLInputElement>(null);

  async function importFiles(files: File[]) {
    setError("");
    const current = tracks.latest.current;
    if (!current) return;
    const added = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        if (file.size > MAX_IMPORT_BYTES)
          throw new Error("File is larger than 20 MB.");
        const parsed = parseGPX(
          await file.text(),
          file.name.replace(/\.gpx$/i, ""),
        );
        added.push(importedTrack(current.tracks.length + added.length, parsed));
      } catch (e) {
        failures.push(`${file.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (added.length)
      tracks.commit({
        ...current,
        activeId: added[0].id,
        tracks: [...current.tracks, ...added],
      });
    if (failures.length) setError(failures.join(" "));
    if (added.length) {
      onImported?.(added.length);
      setTab("tracks");
    }
  }

  return (
    <>
      <button
        className={className}
        aria-label={label}
        title={label}
        disabled={!tracks.collection}
        onClick={() => input.current?.click()}
      >
        {children}
      </button>
      <input
        ref={input}
        type="file"
        accept=".gpx,application/gpx+xml"
        multiple
        aria-label="Import tracks"
        style={{ display: "none" }}
        onChange={(e) => {
          // Snapshot before clearing: `e.target.files` is live, so resetting the
          // input to allow re-picking the same file would empty the list first.
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) void importFiles(files);
        }}
      />
    </>
  );
}
