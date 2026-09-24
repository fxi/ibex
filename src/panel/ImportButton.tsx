import { useRef } from "react";
import { parseGPX } from "../importers/gpx";
import { defaultProfile } from "../models";
import { importedTrack, plannedTrack, type Track } from "../tracks";
import type { PanelContext } from "./context";

/** Files larger than this are not hand-recorded rides; refuse rather than hang. */
const MAX_IMPORT_BYTES = 20_000_000;

/**
 * A button that picks GPX files and adds each as a track, the first one active: an Ibex
 * export comes back as the planned track it was, anything else as an imported recording.
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
  const { tracks, routing, models, setError, setTab } = ctx;
  const input = useRef<HTMLInputElement>(null);

  async function importFiles(files: File[]) {
    setError("");
    const current = tracks.latest.current;
    if (!current) return;
    const added: Track[] = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        if (file.size > MAX_IMPORT_BYTES)
          throw new Error("File is larger than 20 MB.");
        const parsed = parseGPX(
          await file.text(),
          file.name.replace(/\.gpx$/i, ""),
        );
        const index = current.tracks.length + added.length;
        added.push(
          parsed.plan
            ? plannedTrack(
                index,
                parsed.name,
                parsed.plan.waypoints,
                models.find((m) => m.id === parsed.plan!.profileId) ??
                  defaultProfile(),
              )
            : importedTrack(index, parsed),
        );
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
      // Routes the active track, when the data for it is installed; otherwise it waits.
      if (added[0].kind === "planned") void routing.compute();
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
