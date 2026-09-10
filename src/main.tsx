import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as Tabs from "@radix-ui/react-tabs";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Route,
  Layers,
  Wrench,
  Settings,
  RefreshCw,
  LocateFixed,
  Search,
  Plus,
  MoreHorizontal,
  Download,
  Mountain,
  Bike,
  ChevronDown,
  Eye,
  EyeOff,
} from "lucide-react";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { MapView, type MapCommand } from "./map/Map";
import { ProfileEditor } from "./ProfileEditor";
import { Elevation } from "./Elevation";
import { loadModels } from "./models";
import {
  newTrack,
  trackId,
  loadTracks,
  saveTracks,
  editTrack,
  modelSnapshot,
  acceptResult,
  type Track,
  type TrackCollection,
} from "./tracks";
import { type ProfileInput, type UserProfile } from "./routing/profiles";
import {
  COST_MODEL_VERSION,
  type Point,
  type Comparison,
} from "./routing/types";
import { selectedRoute } from "./routing/selection";
import {
  listPacks,
  readManifest,
  type Installed,
  type Manifest,
} from "./offline/store";
import { storageEstimate } from "./offline/capabilities";
import { DEFAULT_REGION_MANIFEST } from "./config";
import { download, exportGPX } from "./gpx";
import RoutingWorker from "./workers/route.worker.ts?worker&inline";
import DataWorker from "./workers/data.worker.ts?worker&inline";
const manifestURL = new URL(
  import.meta.env.VITE_REGION_MANIFEST || DEFAULT_REGION_MANIFEST,
  new URL(import.meta.env.BASE_URL, location.origin),
).href;
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
function App() {
  const [saving, setSaving] = useState(false);
  const saveRevision = useRef(0);
  const [collection, setCollection] = useState<TrackCollection>();
  const state = useRef(collection);
  state.current = collection;
  const [tab, setTab] = useState("tracks"),
    [expanded, setExpanded] = useState(false),
    [collapsed, setCollapsed] = useState(false);
  const [pack, setPack] = useState<Installed>(),
    [catalog, setCatalog] = useState<Manifest>();
  const [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number>(),
    [storage, setStorage] = useState("");
  const [online, setOnline] = useState(navigator.onLine),
    [models, setModels] = useState<UserProfile[]>([]);
  const [debug, setDebug] = useState(false),
    [history, setHistory] = useState(false),
    [attract, setAttract] = useState(false);
  const [comparison, setComparison] = useState<{
    trackId: string;
    revision: number;
    value: Comparison;
  }>();
  const [command, setCommand] = useState<MapCommand>();
  const [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState("");
  const [places, setPlaces] = useState<{ name: string; point: Point }[]>([]),
    [searching, setSearching] = useState(false);
  const searchGeneration = useRef(0),
    searchController = useRef<AbortController | undefined>(undefined);
  const routeWorker = useRef<Worker | undefined>(undefined),
    dataWorker = useRef<Worker | undefined>(undefined),
    generation = useRef(0);
  const saveQueue = useRef(Promise.resolve());
  const active = collection?.tracks.find((t) => t.id === collection.activeId);
  function commit(next: TrackCollection) {
    state.current = next;
    setSaving(true);
    saveRevision.current++;
    setCollection(next);
  }
  function cancel() {
    generation.current++;
    routeWorker.current?.terminate();
    routeWorker.current = undefined;
    setBusy(false);
  }
  function updateTrack(id: string, fn: (track: Track) => Track) {
    const current = state.current;
    if (current)
      commit({
        ...current,
        tracks: current.tracks.map((t) => (t.id === id ? fn(t) : t)),
      });
  }
  function edit(changes: Parameters<typeof editTrack>[1]) {
    if (!active) return;
    cancel();
    setError("");
    setStatus("");
    updateTrack(active.id, (t) => editTrack(t, changes));
  }
  function select(id: string) {
    cancel();
    setError("");
    setStatus("");
    setAttract(false);
    if (state.current) commit({ ...state.current, activeId: id });
  }
  function add(duplicate = false) {
    if (!state.current || !active) return;
    cancel();
    const fresh = newTrack(state.current.tracks.length, active.profile);
    const track = duplicate
      ? {
          ...structuredClone(active),
          id: fresh.id,
          name: `${active.name} copy`,
          color: fresh.color,
          visible: true,
        }
      : fresh;
    commit({
      ...state.current,
      activeId: track.id,
      tracks: [...state.current.tracks, track],
    });
    setTab("tracks");
    setError("");
    setStatus("");
  }
  useEffect(() => {
    let disposed = false;
    const w = new DataWorker();
    dataWorker.current = w;
    w.onmessage = ({ data }) => {
      if (data.type === "progress") setProgress(data.fraction);
      if (data.type === "installed") {
        cancel();
        setPack(data.pack);
        setProgress(undefined);
        setError("");
      }
      if (data.type === "error") {
        setError(data.error);
        setProgress(undefined);
      }
      if (data.type === "removed") {
        cancel();
        setPack(undefined);
        setStatus("Region removed");
      }
    };
    loadTracks()
      .then((v) => {
        if (!disposed) commit(v);
      })
      .catch((e) => {
        if (!disposed) setError(`Unable to restore tracks: ${String(e)}`);
      });
    listPacks()
      .then((packs) => {
        if (!disposed) {
          setPack(
            packs
              .filter((p) => p.manifest.costModelVersion === COST_MODEL_VERSION)
              .sort((a, b) => b.installedAt.localeCompare(a.installedAt))[0],
          );
        }
      })
      .catch(() => setError("Browser storage unavailable"));
    readManifest(manifestURL)
      .then((v) => {
        if (!disposed) setCatalog(v);
      })
      .catch(() => {});
    loadModels()
      .then((v) => {
        if (!disposed) setModels(v);
      })
      .catch((e) => setError(String(e)));
    storageEstimate()
      .then((e) => {
        if (!disposed && e.quota)
          setStorage(
            `${((e.quota - (e.usage ?? 0)) / 1e9).toFixed(1)} GB available`,
          );
      })
      .catch(() => {});
    const connection = () => setOnline(navigator.onLine);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    return () => {
      disposed = true;
      w.terminate();
      routeWorker.current?.terminate();
      searchController.current?.abort();
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
    };
  }, []);
  useEffect(() => {
    if (!collection) return;
    const revision = saveRevision.current;
    saveQueue.current = saveQueue.current
      .then(() => saveTracks(collection))
      .then(() => {
        if (revision === saveRevision.current) setSaving(false);
      })
      .catch(() =>
        setError("Tracks could not be saved. Check available browser storage."),
      );
  }, [collection]);
  useEffect(() => {
    if (!saving) return;
    const preventLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [saving]);
  function compute() {
    if (!active || !pack || active.anchors.length < 2) return;
    cancel();
    const id = ++generation.current,
      trackId = active.id,
      revision = active.revision;
    const worker = new RoutingWorker();
    routeWorker.current = worker;
    setBusy(true);
    setError("");
    setStatus("Preparing local data…");
    worker.onmessage = ({ data }) => {
      const current = state.current?.tracks.find((t) => t.id === trackId);
      if (
        data.id !== generation.current ||
        current?.revision !== revision ||
        state.current?.activeId !== trackId
      )
        return;
      if (data.type === "progress") setStatus(data.label);
      if (data.type === "result") {
        const result = selectedRoute(data.comparison);
        setComparison({ trackId, revision, value: data.comparison });
        if (result?.status === "ok") {
          updateTrack(trackId, (t) =>
            acceptResult(t, revision, result, pack.manifest.version),
          );
          setStatus("Route ready");
        } else
          setError(
            result?.status === "outside-coverage"
              ? "A waypoint is outside the downloaded region."
              : result?.status === "snap-failed"
                ? "No suitable connection within 250 m. Move a waypoint onto a suitable road."
                : result?.status === "budget-exceeded"
                  ? "Search budget reached. Simplify the route or review terrain limits."
                  : "No route connects these waypoints under this model. Review terrain and access limits.",
          );
        setBusy(false);
        worker.terminate();
      }
      if (data.type === "error") {
        setError(data.error);
        setBusy(false);
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      if (id === generation.current) {
        setError(`Routing stopped. ${e.message || "Try a shorter route."}`);
        setBusy(false);
        worker.terminate();
      }
    };
    worker.postMessage({
      id,
      pack,
      request: {
        anchors: active.anchors,
        profile: active.profile,
        attraction: active.attraction,
      },
    });
  }
  function useModel(p: ProfileInput) {
    edit({ profile: modelSnapshot(p) });
  }
  function exportTrack(t: Track) {
    if (t.result && t.resultRevision === t.revision)
      download(
        `${t.name.replace(/[^a-z0-9_-]/gi, "-")}.gpx`,
        exportGPX(t.result),
        "application/gpx+xml",
      );
  }
  function fit(points: Point[]) {
    if (points.length) setCommand({ id: Date.now(), points });
  }
  async function search(e: React.FormEvent) {
    e.preventDefault();
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    const id = ++searchGeneration.current;
    setSearching(true);
    setError("");
    setPlaces([]);
    try {
      const key = import.meta.env.VITE_MAPTILER_API_KEY;
      if (!key || !online)
        throw new Error(
          "Place search needs an internet connection and map access key.",
        );
      const response = await fetch(
        `https://api.maptiler.com/geocoding/${encodeURIComponent(query.trim())}.json?key=${encodeURIComponent(key)}&limit=5`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error("Place search is unavailable.");
      const data = await response.json();
      if (id === searchGeneration.current) {
        setPlaces(
          data.features.map((f: { place_name: string; center: Point }) => ({
            name: f.place_name,
            point: f.center,
          })),
        );
        if (!data.features.length) setError("No places found.");
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(String(e));
    } finally {
      if (id === searchGeneration.current) setSearching(false);
    }
  }
  const shownComparison =
    comparison &&
    comparison.trackId === active?.id &&
    comparison?.revision === active?.revision
      ? comparison.value
      : undefined;
  const sameModel = (p: ProfileInput) =>
    !!active &&
    JSON.stringify(modelSnapshot(p)) === JSON.stringify(active.profile);
  const editorValue: ProfileInput = active
    ? sameModel(active.profile.bike)
      ? active.profile.bike
      : (models.find((p) => sameModel(p)) ?? active.profile)
    : "gravel";
  const region = catalog ?? pack?.manifest;
  const stale = active?.result && active.resultRevision !== active.revision;
  const canCompute = !!pack && !!active && active.anchors.length >= 2 && !busy;
  return (
    <main>
      <MapView
        anchors={active?.anchors ?? []}
        attraction={active?.attraction}
        comparison={shownComparison}
        debug={debug}
        history={history}
        tracks={collection?.tracks ?? []}
        activeId={active?.id}
        coverage={tab === "data" ? region?.bbox : undefined}
        command={command}
        onPoint={(point) => {
          if (tab !== "tracks" || !active) return;
          if (attract) {
            edit({ attraction: { point, radiusM: 2500, strength: 0.35 } });
            setAttract(false);
          } else if (active.anchors.length < 12)
            edit({ anchors: [...active.anchors, point] });
          else setError("A track supports up to 12 waypoints.");
        }}
        onMove={(i, p) =>
          active &&
          edit({ anchors: active.anchors.map((old, j) => (i === j ? p : old)) })
        }
      />
      <header className="brand">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
        <span>
          ibex<small>MAKE YOUR OWN WAY</small>
        </span>
      </header>
      <div className="connection">
        <i className={pack ? "saved" : ""} />
        {pack
          ? `Region saved ${isSecureContext ? "offline" : "locally"}`
          : online
            ? "Online · download a region"
            : "Offline · region required"}
      </div>
      <div className="map-actions">
        <button
          className="glow"
          aria-label="Compute active track"
          disabled={!canCompute}
          onClick={compute}
        >
          <RefreshCw className={busy ? "spin" : ""} />
        </button>
        <button
          aria-label="Find my location"
          onClick={() =>
            navigator.geolocation
              ? navigator.geolocation.getCurrentPosition(
                  (p) => fit([[p.coords.longitude, p.coords.latitude]]),
                  () =>
                    setError(
                      "Location unavailable. Check location permissions.",
                    ),
                )
              : setError("Location is unavailable in this browser.")
          }
        >
          <LocateFixed />
        </button>
        <button
          aria-label="Search places"
          aria-expanded={searchOpen}
          onClick={() => setSearchOpen(!searchOpen)}
        >
          <Search />
        </button>
      </div>
      {searchOpen && (
        <form className="search-box glass" onSubmit={search}>
          <label htmlFor="place-search">Find a place</label>
          <div className="row">
            <input
              id="place-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Town, mountain, address…"
            />
            <button disabled={!query.trim() || searching}>
              {searching ? "Searching…" : "Search"}
            </button>
          </div>
          {places.map((p, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                fit([p.point]);
                setSearchOpen(false);
              }}
            >
              {p.name}
            </button>
          ))}
        </form>
      )}
      <section
        className={`panel glass ${expanded ? "expanded" : ""} ${collapsed ? "collapsed" : ""}`}
        aria-label="Route planner"
      >
        <div className="panel-handle">
          <span className="save-status" role="status">
            {saving ? "Saving…" : "Saved"}
          </span>
          <button
            aria-label={collapsed ? "Open panel" : "Collapse panel"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            <span />
          </button>
          <button
            className="expand-button"
            aria-label={expanded ? "Compact panel" : "Expand panel"}
            onClick={() => {
              setExpanded(!expanded);
              setCollapsed(false);
            }}
          >
            <ChevronDown
              style={{ transform: expanded ? undefined : "rotate(180deg)" }}
              size={16}
            />
          </button>
        </div>
        <Tabs.Root
          value={tab}
          onValueChange={(v) => {
            setTab(v);
            setCollapsed(false);
            setAttract(false);
          }}
        >
          <Tabs.List className="tabs" aria-label="Planner tabs">
            {[
              ["tracks", "Tracks", Route],
              ["data", "Data", Layers],
              ["tools", "Tools", Wrench],
              ["configure", "Configure", Settings],
            ].map(([id, label, Icon]) => {
              const I = Icon as typeof Route;
              return (
                <Tabs.Trigger key={String(id)} value={String(id)}>
                  <I size={23} />
                  <span>{String(label)}</span>
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
          <div className="panel-content">
            {error && (
              <p className="error" role="alert">
                {error}
                <button aria-label="Dismiss error" onClick={() => setError("")}>
                  ×
                </button>
              </p>
            )}
            {busy && (
              <div className="calculation" role="status">
                <RefreshCw className="spin" size={16} />
                {status}
                <button
                  onClick={() => {
                    cancel();
                    setStatus("Cancelled");
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
            <Tabs.Content value="tracks">
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
                {collection?.tracks.map((t) => (
                  <article
                    key={t.id}
                    className={`track-card ${t.id === active?.id ? "active" : ""}`}
                    style={{ "--track-color": t.color } as React.CSSProperties}
                  >
                    <button
                      className="track-select"
                      aria-label={`Select ${t.name}`}
                      aria-pressed={t.id === active?.id}
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
                          {t.profile.name} ·{" "}
                          {t.result
                            ? `${(t.result.distanceM / 1000).toFixed(1)} km · ↗ ${t.result.ascentM === null ? "—" : Math.round(t.result.ascentM)} m`
                            : `${t.anchors.length} waypoints`}
                        </small>
                        <small className="track-state">
                          {!t.visible ? "Hidden · " : ""}
                          {t.resultRevision !== t.revision
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
                          <Menu.Item
                            onSelect={() => {
                              select(t.id);
                              const current = state.current!;
                              const copy = {
                                ...structuredClone(t),
                                id: trackId(),
                                name: `${t.name} copy`,
                                color: newTrack(current.tracks.length).color,
                              };
                              commit({
                                ...current,
                                activeId: copy.id,
                                tracks: [...current.tracks, copy],
                              });
                            }}
                          >
                            Duplicate
                          </Menu.Item>
                          <Menu.Item
                            onSelect={() => {
                              const name = window
                                .prompt("Track name", t.name)
                                ?.trim();
                              if (name)
                                updateTrack(t.id, (old) => ({ ...old, name }));
                            }}
                          >
                            Rename
                          </Menu.Item>
                          <Menu.Item
                            onSelect={() =>
                              updateTrack(t.id, (old) => ({
                                ...old,
                                visible: !old.visible,
                              }))
                            }
                          >
                            {t.visible ? (
                              <EyeOff size={15} />
                            ) : (
                              <Eye size={15} />
                            )}{" "}
                            {t.visible ? "Hide" : "Show"}
                          </Menu.Item>
                          <Menu.Item
                            onSelect={() =>
                              fit(t.result?.geometry ?? t.anchors)
                            }
                          >
                            Fit to map
                          </Menu.Item>
                          <Menu.Item
                            disabled={
                              !t.result || t.resultRevision !== t.revision
                            }
                            onSelect={() => exportTrack(t)}
                          >
                            Export GPX
                          </Menu.Item>
                          <Menu.Item
                            className="danger"
                            onSelect={() => {
                              if (!confirm(`Delete “${t.name}”?`)) return;
                              cancel();
                              const current = state.current!;
                              let tracks = current.tracks.filter(
                                (v) => v.id !== t.id,
                              );
                              if (!tracks.length) tracks = [newTrack()];
                              commit({
                                ...current,
                                tracks,
                                activeId:
                                  current.activeId === t.id
                                    ? tracks[0].id
                                    : current.activeId,
                              });
                            }}
                          >
                            Delete
                          </Menu.Item>
                        </Menu.Content>
                      </Menu.Portal>
                    </Menu.Root>
                  </article>
                ))}
              </div>
              {active && (
                <details className="track-details" key={active.id}>
                  <summary>Edit track · {active.name}</summary>
                  <label>
                    Track color
                    <input
                      type="color"
                      value={active.color}
                      onChange={(e) =>
                        updateTrack(active.id, (t) => ({
                          ...t,
                          color: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <p>
                    Tap the map to add waypoints. Drag numbered markers to move
                    them.
                  </p>
                  {active.anchors.map((p, i) => (
                    <div className="waypoint" key={i}>
                      <b>{i + 1}</b>
                      <span>
                        {p[1].toFixed(4)}, {p[0].toFixed(4)}
                      </span>
                      <button
                        aria-label={`Remove waypoint ${i + 1}`}
                        onClick={() =>
                          edit({
                            anchors: active.anchors.filter((_, j) => j !== i),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <div className="row">
                    <button
                      aria-pressed={attract}
                      onClick={() => setAttract(!attract)}
                    >
                      {attract
                        ? "Tap an area to attract"
                        : "Draw me through here"}
                    </button>
                    <button
                      onClick={() =>
                        edit({ anchors: [], attraction: undefined })
                      }
                    >
                      Reset waypoints
                    </button>
                  </div>
                  {active.attraction && (
                    <label>
                      Attraction radius
                      <input
                        aria-label="Attraction radius"
                        type="range"
                        min="500"
                        max="6000"
                        step="250"
                        value={active.attraction.radiusM}
                        onChange={(e) =>
                          edit({
                            attraction: {
                              ...active.attraction!,
                              radiusM: +e.target.value,
                            },
                          })
                        }
                      />
                      {(active.attraction.radiusM / 1000).toFixed(1)} km
                      <button onClick={() => edit({ attraction: undefined })}>
                        Remove attraction
                      </button>
                    </label>
                  )}
                  {active.result && (
                    <div className="result">
                      <Elevation route={active.result} />
                      {stale && (
                        <p>
                          Waypoints or model changed. Compute to update this
                          route.
                        </p>
                      )}
                      <p>
                        {active.result.hikeABikeM > 0 &&
                          `${(active.result.hikeABikeM / 1000).toFixed(2)} km hike-a-bike. `}
                        {active.result.ferryM > 0 &&
                          `${(active.result.ferryM / 1000).toFixed(2)} km by ferry; check service times. `}
                        {Math.round(
                          (100 * active.result.uncertainM) /
                            Math.max(1, active.result.distanceM),
                        )}
                        % with uncertain map attributes.
                      </p>
                      <button
                        disabled={!!stale}
                        onClick={() => exportTrack(active)}
                      >
                        Export your route
                      </button>
                    </div>
                  )}
                  <details
                    className="lab"
                    onToggle={(e) => setDebug(e.currentTarget.open)}
                  >
                    <summary>Inside the route</summary>
                    {shownComparison ? (
                      <>
                        <p>
                          Cost difference:{" "}
                          {shownComparison.relativeCost === null
                            ? "unavailable"
                            : `${(shownComparison.relativeCost * 100).toFixed(1)}%`}
                        </p>
                        <p>
                          Full graph:{" "}
                          {shownComparison.reference.metrics.explored} explored
                          · Corridor:{" "}
                          {shownComparison.corridor.metrics.explored} explored
                        </p>
                        <button
                          onClick={() =>
                            download(
                              "ibex-diagnostics.json",
                              JSON.stringify(shownComparison, null, 2),
                              "application/json",
                            )
                          }
                        >
                          Export diagnostics
                        </button>
                      </>
                    ) : (
                      <p>Compute this track to inspect routing diagnostics.</p>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={history}
                        onChange={(e) => setHistory(e.target.checked)}
                      />
                      Your rides · online reference layer
                    </label>
                  </details>
                </details>
              )}
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
            </Tabs.Content>
            <Tabs.Content value="data">
              <div className="section-heading">
                <div>
                  <h1>Your map data</h1>
                  <p>Download once. Find your way locally.</p>
                </div>
                <Layers />
              </div>
              {region ? (
                <article className="data-card">
                  <div className="region-thumbnail">
                    <Mountain />
                  </div>
                  <div>
                    <h2>{region.name}</h2>
                    <p>
                      {(
                        region.files.reduce((sum, f) => sum + f.bytes, 0) / 1e6
                      ).toFixed(1)}{" "}
                      MB · Regional pack
                    </p>
                    <small>
                      {pack ? "Installed" : "Available to download"}
                    </small>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Show region coverage"
                    onClick={() =>
                      fit([
                        [region.bbox[0], region.bbox[1]],
                        [region.bbox[2], region.bbox[3]],
                      ])
                    }
                  >
                    <Search size={20} />
                  </button>
                </article>
              ) : (
                <p>
                  Region catalog unavailable. Connect to the internet to load
                  available data.
                </p>
              )}
              {(!pack ||
                (catalog && catalog.version !== pack.manifest.version)) && (
                <button
                  className="primary wide"
                  disabled={progress !== undefined || !online}
                  onClick={() => {
                    setProgress(0);
                    setError("");
                    dataWorker.current?.postMessage({
                      id: 1,
                      type: "install",
                      url: manifestURL,
                    });
                  }}
                >
                  <Download size={20} />
                  {progress !== undefined
                    ? `Saving ${Math.round(progress * 100)}%`
                    : pack
                      ? "Install available update"
                      : `Save ${isSecureContext ? "offline" : "locally"}`}
                </button>
              )}
              {progress !== undefined && (
                <>
                  <progress value={progress} max="1" />
                  <button
                    onClick={() =>
                      dataWorker.current?.postMessage({ id: 1, type: "cancel" })
                    }
                  >
                    Cancel download
                  </button>
                </>
              )}
              {pack && (
                <details>
                  <summary>Saved region · {pack.manifest.name}</summary>
                  <p>
                    OSM {pack.manifest.osmTimestamp.slice(0, 10)} ·{" "}
                    {Math.round(pack.manifest.terrainCoverage * 100)}% terrain
                    coverage
                  </p>
                  <p>{pack.manifest.attribution}</p>
                  <button
                    disabled={progress !== undefined}
                    onClick={() =>
                      dataWorker.current?.postMessage({
                        id: 2,
                        type: "remove",
                        pack,
                      })
                    }
                  >
                    Remove downloaded region
                  </button>
                </details>
              )}
              <p className="hint">{storage}</p>
              <p className="note">
                Downloaded data supports local routing. The background map and
                place search need an internet connection.
              </p>
              <div className="coming-next">
                <Layers size={18} />
                <div>
                  <strong>Smaller downloads, coming next</strong>
                  <p>
                    Selectable grid tiles, targeting 40–50 MB each. Regional
                    downloads are available today.
                  </p>
                </div>
              </div>
            </Tabs.Content>
            <Tabs.Content value="tools">
              <div className="section-heading">
                <div>
                  <h1>Ready for a fresh route?</h1>
                  <p>
                    {active?.name ?? "Loading track…"} · {active?.profile.name}
                  </p>
                </div>
              </div>
              <button
                className="primary compute"
                disabled={!canCompute}
                onClick={compute}
              >
                <RefreshCw size={42} className={busy ? "spin" : ""} />
                <span>{busy ? "Computing…" : "Compute current track"}</span>
              </button>
              <p className="hint">
                {!pack
                  ? "Download a region in Data to begin."
                  : (active?.anchors.length ?? 0) < 2
                    ? "Add at least two waypoints on the map."
                    : "Uses the waypoints and model of your active track."}
              </p>
              {!busy && status && <p role="status">{status}</p>}
            </Tabs.Content>
            <Tabs.Content value="configure">
              <div className="section-heading">
                <div>
                  <h1>Choose your way</h1>
                  <p>Model for {active?.name ?? "your active track"}</p>
                </div>
                <Settings />
              </div>
              <div className="model-list">
                {(["gravel", "road", "touring", "scenic"] as const).map((p) => (
                  <button
                    key={p}
                    className="model-row"
                    aria-pressed={sameModel(p)}
                    onClick={() => useModel(p)}
                  >
                    <Bike />
                    <span>{p[0].toUpperCase() + p.slice(1)}</span>
                    <i />
                  </button>
                ))}
                {models.map((p) => (
                  <button
                    key={p.name}
                    className="model-row"
                    aria-pressed={sameModel(p)}
                    onClick={() => useModel(p)}
                  >
                    <Mountain />
                    <span>{p.name}</span>
                    <i />
                  </button>
                ))}
              </div>
              {active && (
                <ProfileEditor
                  key={active.id}
                  value={editorValue}
                  onChange={(p) => {
                    useModel(p);
                    loadModels()
                      .then(setModels)
                      .catch((e) => setError(String(e)));
                  }}
                />
              )}
              <p className="note">
                Each track keeps its own model settings. Editing a model leaves
                other tracks as they were.
              </p>
            </Tabs.Content>
          </div>
        </Tabs.Root>
      </section>
      <div className="map-caption">
        A little less traffic. A little more possibility.
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
