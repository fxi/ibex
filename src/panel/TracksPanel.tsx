import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Route,
  Plus,
  MoreHorizontal,
  Mountain,
  Eye,
  EyeOff,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Elevation } from "../Elevation";
import { SURFACE_STYLE, rideTotals } from "../map/rideStyle";
import { SurfaceSample } from "./SurfaceSample";
import { download, exportGPX } from "../gpx";
import { modelSnapshot, type Track } from "../tracks";
import type { Point } from "../routing/types";
import type { PanelContext } from "./context";

const examples: { name: string; anchors: Point[] }[] = [
  {
    name: "Along the Arve",
    anchors: [
      [6.146, 46.189],
      [6.235, 46.177],
    ],
  },
  {
    name: "Geneva → Salève",
    anchors: [
      [6.151, 46.201],
      [6.171, 46.119],
    ],
  },
  {
    name: "Geneva → Voirons",
    anchors: [
      [6.151, 46.201],
      [6.37, 46.22],
    ],
  },
];

export function exportTrack(t: Track) {
  if (t.result && t.resultRevision === t.revision)
    download(
      `${t.name.replace(/[^a-z0-9_-]/gi, "-")}.gpx`,
      exportGPX(t.result, t.name),
      "application/gpx+xml",
    );
}

export function TracksPanel({ ctx }: { ctx: PanelContext }) {
  const { tracks, routing, fit, models, canCompute } = ctx;
  const { collection, active, updateTrack, edit, select, add, duplicate } =
    tracks;
  const [confirming, setConfirming] = useState<string>();

  const stale = active?.result && active.resultRevision !== active.revision;
  /** Preset names plus saved models, matched to the track's own snapshot by value. */
  const presets = ["gravel", "road", "touring", "scenic"] as const;
  const same = (track: Track, name: string) =>
    JSON.stringify(track.profile) ===
    JSON.stringify(
      modelSnapshot(
        (presets as readonly string[]).includes(name)
          ? (name as (typeof presets)[number])
          : (models.find((m) => m.name === name) ?? track.profile),
      ),
    );

  return (
    <>
      <div className="section-heading">
        <div>
          <h1>Your tracks</h1>
          <p>A different way, every day.</p>
        </div>
        <button
          className="icon-button"
          aria-label="New track"
          disabled={!active}
          onClick={() => add()}
        >
          <Plus />
        </button>
      </div>
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
                  {t.kind === "imported" ? (
                    <p className="hint">
                      An imported track is kept exactly as recorded. Duplicate
                      it to plan a new route along the same way.
                    </p>
                  ) : (
                    <button
                      className="primary wide"
                      disabled={!canCompute}
                      onClick={routing.compute}
                    >
                      <RefreshCw
                        size={18}
                        className={routing.busy ? "spin" : ""}
                      />
                      {routing.busy ? "Computing…" : "Reprocess waypoints"}
                    </button>
                  )}
                  {/* The run is started here now, so its outcome is reported here too. */}
                  {!routing.busy && ctx.status && (
                    <p className="hint" role="status">
                      {ctx.status}
                    </p>
                  )}

                  <div className="track-meta">
                    <label>
                      Name
                      <input
                        value={t.name}
                        onChange={(e) =>
                          updateTrack(t.id, (old) => ({
                            ...old,
                            name: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Colour
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
                    </label>
                  </div>

                  {t.kind === "planned" && (
                    <label>
                      Profile
                      <select
                        value={
                          presets.find((p) => same(t, p)) ??
                          models.find((m) => same(t, m.name))?.name ??
                          ""
                        }
                        onChange={(e) => {
                          const name = e.target.value;
                          const chosen = (
                            presets as readonly string[]
                          ).includes(name)
                            ? (name as (typeof presets)[number])
                            : models.find((m) => m.name === name);
                          if (chosen) edit({ profile: modelSnapshot(chosen) });
                        }}
                      >
                        {/* An edited model matches nothing in the list until it is saved. */}
                        <option value="">{t.profile.name} (custom)</option>
                        {presets.map((p) => (
                          <option key={p} value={p}>
                            {p[0].toUpperCase() + p.slice(1)}
                          </option>
                        ))}
                        {models.map((m) => (
                          <option key={m.name} value={m.name}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {t.kind === "planned" && (
                    <div className="waypoints">
                      <p className="hint">
                        Tap the map to add waypoints. Drag markers to move them;
                        long-press or right-click one to insert or remove.
                      </p>
                      {t.anchors.map((p, i) => (
                        <div className="waypoint" key={i}>
                          <b>{i + 1}</b>
                          <span>
                            {p[1].toFixed(4)}, {p[0].toFixed(4)}
                          </span>
                          <button
                            aria-label={`Remove waypoint ${i + 1}`}
                            onClick={() =>
                              edit({
                                anchors: t.anchors.filter((_, j) => j !== i),
                              })
                            }
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      {t.anchors.length > 0 && (
                        <button onClick={() => edit({ anchors: [] })}>
                          Reset waypoints
                        </button>
                      )}
                    </div>
                  )}

                  {t.result && (
                    <div className="result">
                      <Elevation route={t.result} />
                      <RideLegend segments={t.result.segments ?? []} color={t.color} />
                      {stale && (
                        <p>
                          Waypoints or profile changed. Reprocess to update this
                          route.
                        </p>
                      )}
                      <p>
                        {t.result.hikeABikeM > 0 &&
                          `${(t.result.hikeABikeM / 1000).toFixed(2)} km hike-a-bike. `}
                        {t.result.ferryM > 0 &&
                          `${(t.result.ferryM / 1000).toFixed(2)} km by ferry; check service times. `}
                        {Math.round(
                          (100 * t.result.uncertainM) /
                            Math.max(1, t.result.distanceM),
                        )}
                        % with uncertain map attributes.
                      </p>
                      <button disabled={!!stale} onClick={() => exportTrack(t)}>
                        Export your route
                      </button>
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {active && !active.anchors.length && (
        <div className="empty-state">
          <Mountain size={28} />
          <h2>Where will you go?</h2>
          <p>Tap the map to start a track, or try a local route.</p>
          <div className="examples">
            {examples.map((e) => (
              <button
                key={e.name}
                onClick={() => {
                  edit({ anchors: e.anchors });
                  fit(e.anchors);
                }}
              >
                {e.name} ↗
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * What the route is made of, in the same colours the map draws. Only classes actually
 * present are listed, so a plain tarmac ride does not carry a legend it does not need.
 */
function RideLegend({
  segments,
  color,
}: {
  segments: import("../routing/types").RouteSegment[];
  color: string;
}) {
  const totals = rideTotals(segments);
  const present = SURFACE_STYLE.filter((s) => (totals.get(s.ride) ?? 0) > 0);
  if (present.length < 2) return null;
  return (
    <ul className="ride-legend">
      {present.map((s) => (
        <li key={s.ride}>
          <SurfaceSample ride={s.ride} color={color} width={26} />
          {s.label}
          <b>{((totals.get(s.ride) ?? 0) / 1000).toFixed(1)} km</b>
        </li>
      ))}
    </ul>
  );
}
