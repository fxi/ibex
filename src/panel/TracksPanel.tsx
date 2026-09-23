import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Route,
  Plus,
  MoreHorizontal,
  Eye,
  EyeClosed,
  Import,
  Search,
  Trash2,
  SquarePen,
} from "lucide-react";
import { Elevation } from "../Elevation";

import { exportTrack, freshResult } from "../tracks";
import type { PanelContext } from "./context";
import { ConvertDialog } from "./ConvertDialog";
import { ImportButton } from "./ImportButton";
import { Modal } from "./Modal";

/**
 * The tracks there are, and which one is active.
 *
 * Identity only: a card names a track, colours it and says where it stands. Everything that
 * changes the route — its profile, its waypoints, computing it, undoing an edit — lives in
 * the Edit tab, which the pencil on each card opens. Keeping the two apart lets the list
 * stay a list however many tracks it holds, and makes "the map is editable" mean one tab.
 */
export function TracksPanel({ ctx }: { ctx: PanelContext }) {
  const { tracks, fit, setTab } = ctx;
  const {
    collection,
    active,
    updateTrack,
    setVisibility,
    select,
    add,
    duplicate,
  } = tracks;
  const [confirming, setConfirming] = useState<string>();
  const [converting, setConverting] = useState<string>();
  const [query, setQuery] = useState("");
  const deleting = collection?.tracks.find((t) => t.id === confirming);
  const toConvert = collection?.tracks.find((t) => t.id === converting);
  const others = (id: string) =>
    collection?.tracks.filter((o) => o.id !== id) ?? [];
  const needle = query.trim().toLowerCase();
  const shown =
    collection?.tracks.filter(
      (t) =>
        !needle ||
        [t.name, t.kind === "imported" ? "imported" : t.profile.name].some(
          (s) => s.toLowerCase().includes(needle),
        ),
    ) ?? [];

  return (
    <>
      {/* The tab already says "Tracks"; the heading stays for screen readers only. */}
      <h1 className="visually-hidden">Your tracks</h1>
      <div className="tracks-toolbar">
        <label className="track-search">
          <Search size={16} aria-hidden />
          <input
            type="search"
            placeholder="Search tracks"
            aria-label="Search tracks"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <ImportButton ctx={ctx} className="tracks-import">
          <Import size={16} />
          Import
        </ImportButton>
        <button
          className="icon-button"
          aria-label="New track"
          disabled={!collection}
          onClick={() => add()}
        >
          <Plus />
        </button>
      </div>
      {collection && !collection.tracks.length && (
        <button className="empty-state" onClick={() => add()}>
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
          No track, add one to start
        </button>
      )}
      {!!collection?.tracks.length && !shown.length && (
        <p className="hint">No track matches “{query.trim()}”.</p>
      )}
      <div className="track-list">
        {shown.map((t) => {
          const open = t.id === active?.id;
          return (
            <article
              key={t.id}
              className={`track-card ${open ? "active open" : ""} ${
                t.visible ? "" : "is-hidden"
              }`}
              style={{ "--track-color": t.color } as React.CSSProperties}
            >
              <div className="track-head">
                <button
                  className="track-select"
                  aria-label={`Select ${t.name}`}
                  aria-pressed={open}
                  aria-expanded={open}
                  onClick={() => select(t.id)}
                >
                  <i className="track-dot" />
                  {t.result ? (
                    <div className="sparkline">
                      <Elevation route={t.result} />
                    </div>
                  ) : (
                    <Route className="empty-spark" />
                  )}
                  <span className="track-copy">
                    <strong>{t.name}</strong>
                    <small>
                      {t.kind === "imported" ? "Imported" : t.profile.name} ·{" "}
                      {t.result
                        ? `${(t.result.distanceM / 1000).toFixed(1)} km · ↗ ${t.result.ascentM === null ? "—" : Math.round(t.result.ascentM)} m`
                        : `${t.anchors.length} waypoints`}
                    </small>
                    <small className="track-state">
                      {!t.visible ? "Hidden · " : ""}
                      {t.kind === "imported"
                        ? "Reference"
                        : !freshResult(t)
                          ? "Needs computation"
                          : "Ready"}
                    </small>
                  </span>
                </button>
                {/* Out of the menu: hiding a track to read the map under it is a glance, not a
                    decision, and a hidden track needs one tap to come back. */}
                <button
                  className="icon-button"
                  aria-label={`${t.visible ? "Hide" : "Show"} ${t.name}`}
                  aria-pressed={!t.visible}
                  title={t.visible ? "Hide on the map" : "Show on the map"}
                  onClick={() =>
                    updateTrack(t.id, (old) => ({
                      ...old,
                      visible: !old.visible,
                    }))
                  }
                >
                  {t.visible ? <Eye size={18} /> : <EyeClosed size={18} />}
                </button>
                <button
                  className="icon-button"
                  aria-label={`Edit ${t.name}`}
                  title="Edit"
                  onClick={() => {
                    select(t.id);
                    setTab("edit");
                  }}
                >
                  <SquarePen size={18} />
                </button>
                <Menu.Root>
                  <Menu.Trigger
                    className="icon-button"
                    aria-label={`Actions for ${t.name}`}
                  >
                    <MoreHorizontal size={20} />
                  </Menu.Trigger>
                  <Menu.Portal>
                    <Menu.Content className="menu glass" sideOffset={6}>
                      {/* A copy of a recording is the same recording; what one wants
                          from it is a track the router can reshape. */}
                      {t.kind === "imported" ? (
                        <Menu.Item onSelect={() => setConverting(t.id)}>
                          Convert to planned track…
                        </Menu.Item>
                      ) : (
                        <Menu.Item onSelect={() => duplicate(t.id)}>
                          Duplicate
                        </Menu.Item>
                      )}
                      <Menu.Item
                        disabled={
                          t.visible && !others(t.id).some((o) => o.visible)
                        }
                        // Keeps this one on the map, since the point is to see it alone.
                        onSelect={() => setVisibility((o) => o.id === t.id)}
                      >
                        Hide all others
                      </Menu.Item>
                      <Menu.Item
                        disabled={others(t.id).every((o) => o.visible)}
                        onSelect={() =>
                          setVisibility((o) =>
                            o.id === t.id ? o.visible : true,
                          )
                        }
                      >
                        Show all others
                      </Menu.Item>
                      <Menu.Item
                        onSelect={() => fit(t.result?.geometry ?? t.anchors)}
                      >
                        Fit to map
                      </Menu.Item>
                      <Menu.Item
                        disabled={!freshResult(t)}
                        onSelect={() => exportTrack(t)}
                      >
                        Export GPX
                      </Menu.Item>
                      <Menu.Item
                        className="danger"
                        onSelect={() => setConfirming(t.id)}
                      >
                        Delete
                      </Menu.Item>
                    </Menu.Content>
                  </Menu.Portal>
                </Menu.Root>
              </div>

              {open && (
                <div className="track-body">
                  <div className="track-name">
                    <input
                      type="color"
                      aria-label="Track colour"
                      value={t.color}
                      onChange={(e) =>
                        updateTrack(t.id, (old) => ({
                          ...old,
                          color: e.target.value,
                        }))
                      }
                    />
                    <input
                      aria-label="Track name"
                      value={t.name}
                      onChange={(e) =>
                        updateTrack(t.id, (old) => ({
                          ...old,
                          name: e.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {deleting && (
        <Modal
          alert
          title={`Delete “${deleting.name}”?`}
          onClose={() => setConfirming(undefined)}
        >
          <p>The track and its route are removed from this device.</p>
          <div className="modal-actions">
            <button onClick={() => setConfirming(undefined)}>Cancel</button>
            <button
              className="danger"
              onClick={() => {
                setConfirming(undefined);
                tracks.remove(deleting.id);
              }}
            >
              <Trash2 size={16} /> Delete
            </button>
          </div>
        </Modal>
      )}
      {toConvert && (
        <ConvertDialog
          ctx={ctx}
          track={toConvert}
          onClose={() => setConverting(undefined)}
        />
      )}
    </>
  );
}
