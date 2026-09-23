import { useState } from "react";
import { Route } from "lucide-react";
import { DEFAULT_PROFILE_ID } from "../models";
import type { Track } from "../tracks";
import type { PanelContext } from "./context";
import { Modal } from "./Modal";

/**
 * Ask which profile to plan an imported track with, then convert it. The only choice is
 * the profile: where the waypoints go is the router's to find (see routing/convert).
 */
export function ConvertDialog({
  ctx,
  track,
  onClose,
}: {
  ctx: PanelContext;
  track: Track;
  onClose: () => void;
}) {
  const { models, convert, data } = ctx;
  const [id, setId] = useState(
    models.find((m) => m.id === DEFAULT_PROFILE_ID)?.id ?? models[0]?.id,
  );
  const profile = models.find((m) => m.id === id);
  const ready = data.routableCells.length > 0;
  return (
    <Modal title={`Convert “${track.name}”`} onClose={onClose}>
      <p>
        Ibex routes along the recording and adds a waypoint wherever the route
        parts from it. The recording is kept as it is.
      </p>
      <label className="modal-field">
        Profile
        <select
          aria-label="Profile to convert with"
          value={id ?? ""}
          onChange={(e) => setId(e.target.value)}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      {!ready && (
        <p className="hint">Add map data along the ride first, in Data.</p>
      )}
      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          disabled={!profile || !ready || !!convert.converting}
          onClick={() => {
            if (!profile) return;
            onClose();
            // The new track is planned in Edit, which is also where its passes report.
            ctx.setTab("edit");
            void convert.convert(track.id, profile);
          }}
        >
          <Route size={16} /> Convert
        </button>
      </div>
    </Modal>
  );
}
