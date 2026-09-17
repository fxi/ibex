import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Route,
  Plus,
  MoreHorizontal,
  Eye,
  EyeOff,
  Trash2,
  SquarePen,
} from "lucide-react";
import { Elevation } from "../Elevation";
import { download, exportGPX } from "../gpx";
import type { Track } from "../tracks";
import type { PanelContext } from "./context";

export function exportTrack(t: Track) {
  if (t.result && t.resultRevision === t.revision)
    download(
      `${t.name.replace(/[^a-z0-9_-]/gi, "-")}.gpx`,
      exportGPX(t.result, t.name),
      "application/gpx+xml",
    );
}

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
  const { collection, active, updateTrack, select, add, duplicate } = tracks;
  const [confirming, setConfirming] = useState<string>();

  return (
    <>
      <div className="section-heading">
        <h1>Your tracks</h1>
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
      <div className="track-list">
        {collection?.tracks.map((t) => {
          const open = t.id === active?.id;
          return (
            <article
              key={t.id}
              className={`track-card ${open ? "active open" : ""}`}
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
                        : t.resultRevision !== t.revision
                          ? "Needs computation"
                          : "Ready"}
                    </small>
                  </span>
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
                      <Menu.Item onSelect={() => duplicate(t.id)}>
                        Duplicate
                      </Menu.Item>
                      <Menu.Item
                        onSelect={() =>
                          updateTrack(t.id, (old) => ({
                            ...old,
                            visible: !old.visible,
                          }))
                        }
                      >
                        {t.visible ? <EyeOff size={15} /> : <Eye size={15} />}{" "}
                        {t.visible ? "Hide" : "Show"}
                      </Menu.Item>
                      <Menu.Item
                        onSelect={() => fit(t.result?.geometry ?? t.anchors)}
                      >
                        Fit to map
                      </Menu.Item>
                      <Menu.Item
                        disabled={!t.result || t.resultRevision !== t.revision}
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

              {confirming === t.id && (
                <div className="confirm" role="alertdialog">
                  <span>{`Delete “${t.name}”?`}</span>
                  <button onClick={() => setConfirming(undefined)}>
                    Cancel
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      setConfirming(undefined);
                      tracks.remove(t.id);
                    }}
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              )}

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
    </>
  );
}
