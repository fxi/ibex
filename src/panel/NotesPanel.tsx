import { useEffect, useMemo, useRef, useState } from "react";
import {
  Croissant,
  Crosshair,
  Droplet,
  RefreshCw,
  ShoppingCart,
  StickyNote,
} from "lucide-react";
import { SectionHeading } from "./SectionHeading";
import type { PanelContext } from "./context";
import { MAX_RADIUS_M } from "../state/useNotes";
import {
  NOTE_COLORS,
  NOTE_LABELS,
  type Note,
  type NoteKind,
} from "../notes/types";

const ICONS: Record<NoteKind, typeof StickyNote> = {
  manual: StickyNote,
  water: Droplet,
  food: Croissant,
  supermarket: ShoppingCart,
};

/**
 * Notes along a track: the rider's own, and places found along the way — drinking water,
 * bakeries and supermarkets, about one per kilometre, the one closest to the route winning.
 */
export function NotesPanel({ ctx }: { ctx: PanelContext }) {
  const { notes: state, tracks, online, locate } = ctx;
  const { index, notes, area, progress } = state;
  const track = tracks.active;

  // Read from the route as it stands, so a re-route moves every kilometre with it.
  const rows = useMemo(
    () =>
      notes
        .map((note) => ({ note, at: index?.locate(note.point, state.bufferM) }))
        .sort(
          (a, b) =>
            (a.at?.m ?? Infinity) - (b.at?.m ?? Infinity) ||
            a.note.text.localeCompare(b.note.text),
        ),
    [notes, index, state.bufferM],
  );
  const places = notes.filter((n) => n.kind !== "manual").length;

  if (!track)
    return (
      <>
        <SectionHeading title="Notes" />
        <div className="empty-state">Select or create a track first.</div>
      </>
    );

  return (
    <>
      <SectionHeading
        title="Notes"
        info="Your own notes along the track, and drinking water, bakeries and
          supermarkets found beside it in OpenStreetMap: about one per kilometre, the
          closest to the route winning, with water kept at most 10 km apart where there
          is any. A search sends the stretch searched to the public Overpass API; what
          it finds is saved with the track and goes into the GPX export."
      />
      <div className="notes-toolbar">
        <div
          className="segmented"
          role="group"
          aria-label="Distance from the route"
        >
          {[500, 1000].map((m) => (
            <button
              key={m}
              aria-pressed={state.bufferM === m}
              onClick={() => state.setBufferM(m)}
            >
              ±{m < 1000 ? `${m} m` : `${m / 1000} km`}
            </button>
          ))}
        </div>
        <button
          disabled={!index || !online || !!progress}
          title={
            !index
              ? "Compute the route first"
              : !online
                ? "Finding places needs a connection"
                : undefined
          }
          onClick={() => state.search("route")}
        >
          Find along route
        </button>
      </div>
      {area ? (
        <div className="notes-area">
          <label>
            Search area · {(area.radiusM / 1000).toFixed(0)} km
            <input
              type="range"
              min={1000}
              max={MAX_RADIUS_M}
              step={500}
              value={area.radiusM}
              onChange={(e) =>
                state.setArea({ ...area, radiusM: Number(e.target.value) })
              }
            />
          </label>
          <div className="row">
            <button
              disabled={
                !index || !online || !!progress || !state.areaSpans.length
              }
              onClick={() => state.search("area")}
            >
              {state.areaSpans.length ? "Search area" : "Area misses the route"}
            </button>
            <button onClick={() => state.setArea(undefined)}>
              Remove area
            </button>
          </div>
        </div>
      ) : (
        <p className="hint">
          Right-click or long-press the map to add a note, or to search one area
          only.
        </p>
      )}
      {progress && (
        <div className="calculation" role="status">
          <RefreshCw className="spin" size={16} />
          Searching {progress.done}/{progress.total}…
          <button onClick={state.cancel}>Cancel</button>
        </div>
      )}
      {rows.length > 0 && (
        <section className="notes-list">
          <h3>
            {places} places · {notes.length - places} notes
            {places > 0 && (
              <button className="link" onClick={state.clearPlaces}>
                Clear places
              </button>
            )}
          </h3>
          <ul>
            {rows.map(({ note, at }) => (
              <NoteRow
                key={note.id}
                note={note}
                at={at}
                focus={state.focusId === note.id}
                onFocused={() => state.setFocusId(undefined)}
                onLocate={() => locate(note.point)}
                onEdit={(text) => state.edit(note.id, text)}
                onRemove={() => state.remove(note.id)}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function NoteRow({
  note,
  at,
  focus,
  onFocused,
  onLocate,
  onEdit,
  onRemove,
}: {
  note: Note;
  at?: { m: number; offsetM: number };
  focus: boolean;
  onFocused: () => void;
  onLocate: () => void;
  onEdit: (text: string) => void;
  onRemove: () => void;
}) {
  const Icon = ICONS[note.kind];
  const label = note.text || NOTE_LABELS[note.kind];
  // Typing stays local and is saved on leaving the field: every save writes the whole
  // collection, routes included.
  const [draft, setDraft] = useState<string>();
  const text = draft ?? note.text;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) {
      input.current?.focus();
      onFocused();
    }
  }, [focus, onFocused]);
  return (
    <li className="place">
      <Icon
        size={15}
        color={NOTE_COLORS[note.kind]}
        aria-label={NOTE_LABELS[note.kind]}
      />
      <small className="place-km">
        {at ? `${(at.m / 1000).toFixed(1)} km` : "off route"}
      </small>
      {note.kind === "manual" ? (
        <input
          ref={input}
          value={text}
          placeholder="Write a note…"
          aria-label="Note text"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (text !== note.text) onEdit(text);
            setDraft(undefined);
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      ) : (
        <span title={note.hours}>
          {label}
          {at && at.offsetM >= 50 && (
            <small> · {Math.round(at.offsetM)} m off</small>
          )}
        </span>
      )}
      <button
        className="locate-button"
        aria-label={`Show ${label} on the map`}
        onClick={onLocate}
      >
        <Crosshair size={13} />
      </button>
      <button aria-label={`Remove ${label}`} onClick={onRemove}>
        ×
      </button>
    </li>
  );
}
