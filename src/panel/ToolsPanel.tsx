import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { parseGPX } from "../importers/gpx";
import { importedTrack } from "../tracks";
import { exportTrack } from "./TracksPanel";
import type { PanelContext } from "./context";

/** Files larger than this are not hand-recorded rides; refuse rather than hang. */
const MAX_IMPORT_BYTES = 20_000_000;

export function ToolsPanel({ ctx }: { ctx: PanelContext }) {
  const { tracks, setError, setTab } = ctx;
  const { collection, latest, commit } = tracks;
  const input = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState("");

  const exportable =
    collection?.tracks.filter(
      (t) => t.result && t.resultRevision === t.revision,
    ) ?? [];

  async function importFiles(files: File[]) {
    setError("");
    setNotice("");
    const current = latest.current;
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
        added.push(
          importedTrack(current.tracks.length + added.length, parsed),
        );
      } catch (e) {
        failures.push(`${file.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (added.length)
      commit({
        ...current,
        activeId: added[0].id,
        tracks: [...current.tracks, ...added],
      });
    if (failures.length) setError(failures.join(" "));
    if (added.length) {
      setNotice(
        `Imported ${added.length} ${added.length === 1 ? "track" : "tracks"}.`,
      );
      setTab("tracks");
    }
  }

  return (
    <>
      <div className="section-heading">
        <div>
          <h1>Tools</h1>
          <p>Bring rides in, take routes out.</p>
        </div>
      </div>

      <button
        className="primary wide"
        disabled={!exportable.length}
        onClick={() => exportable.forEach(exportTrack)}
      >
        <Download size={20} />
        {exportable.length
          ? `Export all tracks (${exportable.length})`
          : "Nothing to export yet"}
      </button>
      <p className="hint">
        Exports every track with an up-to-date route, one GPX file each.
      </p>

      <button className="wide" onClick={() => input.current?.click()}>
        <Upload size={20} />
        Import tracks
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
      <p className="hint">
        GPX files are added as reference tracks: they draw on the map and export
        again unchanged, but they are never re-routed. FIT support comes later.
      </p>
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
