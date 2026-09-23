import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { exportTrack, freshResult } from "../tracks";

import type { PanelContext } from "./context";
import { ImportButton } from "./ImportButton";
import { SectionHeading } from "./SectionHeading";

export function ToolsPanel({ ctx }: { ctx: PanelContext }) {
  const { collection } = ctx.tracks;
  const [notice, setNotice] = useState("");

  const exportable = collection?.tracks.filter(freshResult) ?? [];

  return (
    <>
      <SectionHeading title="Tools" info="Bring rides in, take routes out." />

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

      <ImportButton
        ctx={ctx}
        className="wide"
        onImported={(n) =>
          setNotice(`Imported ${n} ${n === 1 ? "track" : "tracks"}.`)
        }
      >
        <Upload size={20} />
        Import tracks
      </ImportButton>
      <p className="hint">
        GPX files are added as reference tracks: they draw on the map and export
        again unchanged. Convert one from its menu to plan it with a profile.
        FIT support comes later.
      </p>
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
