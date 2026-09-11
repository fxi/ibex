import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  RefreshCw,
  LocateFixed,
  Search,
  Plus,
  Minus,
  Navigation,
} from "lucide-react";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { MapView, type MapCommand } from "./map/Map";
import { loadModels } from "./models";
import type { Point } from "./routing/types";
import type { UserProfile } from "./routing/profiles";
import { DEFAULT_CATALOGUE_URL, absoluteURL } from "./config";
import { useTracks } from "./state/useTracks";
import { useCatalogue } from "./state/useCatalogue";
import { useRouting } from "./state/useRouting";
import { useSearch } from "./state/useSearch";
import { usePanelHeight } from "./state/usePanelHeight";
import { WaypointMenu, type WaypointMenuState } from "./map/WaypointMenu";
import { Panel } from "./panel/Panel";
import type { PanelContext } from "./panel/context";

const catalogueURL = absoluteURL(
  import.meta.env.VITE_CATALOGUE_URL,
  DEFAULT_CATALOGUE_URL,
);

function App() {
  const [tab, setTab] = useState("tracks");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [command, setCommand] = useState<MapCommand>();
  const [online, setOnline] = useState(navigator.onLine);
  const [models, setModels] = useState<UserProfile[]>([]);
  const [debug, setDebug] = useState(false);
  const [history, setHistory] = useState(false);
  const [menu, setMenu] = useState<WaypointMenuState>();
  // When armed, the next map click inserts at this position instead of appending.
  const [insertAt, setInsertAt] = useState<number>();
  const [camera, setCamera] = useState({ bearing: 0, pitch: 0 });

  // `cancel` lives in useRouting but is needed by hooks declared before it, so it is
  // reached through a ref that is rebound on every render.
  const cancel = useRef<() => void>(() => {});

  const tracks = useTracks({
    onError: setError,
    beforeChange: () => {
      cancel.current();
      setError("");
      setStatus("");
      setInsertAt(undefined);
      setMenu(undefined);
    },
  });
  const data = useCatalogue({
    catalogueURL,
    onError: setError,
    onStatus: setStatus,
    onDataChange: () => cancel.current(),
  });
  const routing = useRouting({
    latest: tracks.latest,
    updateTrack: tracks.updateTrack,
    catalogue: data.catalogue,
    routableCells: data.routableCells,
    setError,
    setStatus,
    onMissingCells: (ids) => {
      data.setMissingCells(ids);
      data.markAll(ids, "add");
    },
  });
  cancel.current = routing.cancel;

  const search = useSearch({ online, setError });
  const panel = usePanelHeight();

  useEffect(() => {
    const connection = () => setOnline(navigator.onLine);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    return () => {
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
    };
  }, []);

  const reloadModels = () =>
    loadModels()
      .then(setModels)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    let disposed = false;
    loadModels()
      .then((v) => {
        if (!disposed) setModels(v);
      })
      .catch((e) => setError(String(e)));
    return () => {
      disposed = true;
    };
  }, []);

  const { active } = tracks;
  const fit = (points: Point[]) => {
    if (points.length) setCommand({ id: Date.now(), kind: "fit", points });
  };
  const moveCamera = (kind: "zoomIn" | "zoomOut" | "resetNorth") =>
    setCommand({ id: Date.now(), kind });
  const rotated = Math.abs(camera.bearing) > 0.5 || camera.pitch > 0.5;
  const canCompute =
    data.routableCells.length > 0 &&
    !!active &&
    active.anchors.length >= 2 &&
    !routing.busy;

  const ctx: PanelContext = {
    tracks,
    data,
    routing,
    online,
    canCompute,
    status,
    fit,
    setError,
    setStatus,
    setTab,
    debug,
    setDebug,
    history,
    setHistory,
    models,
    reloadModels,
  };

  return (
    <main>
      <MapView
        anchors={active?.anchors ?? []}
        comparison={
          routing.comparison &&
          routing.comparison.trackId === active?.id &&
          routing.comparison.revision === active?.revision
            ? routing.comparison.value
            : undefined
        }
        debug={debug}
        history={history}
        tracks={tracks.collection?.tracks ?? []}
        activeId={active?.id}
        cells={tab === "data" ? data.cells : undefined}
        onCell={(id) => data.toggleCell(id)}
        bottomInset={panel.open ? panel.height + 90 : 90}
        command={command}
        onCamera={setCamera}
        onMenu={(index, x, y) => {
          if (tab === "tracks") setMenu({ index, x, y });
        }}
        onPoint={(point) => {
          if (tab !== "tracks" || !active) return;
          if (insertAt !== undefined) {
            const anchors = [...active.anchors];
            anchors.splice(insertAt, 0, point);
            tracks.edit({ anchors });
          } else if (active.anchors.length < 12)
            tracks.edit({ anchors: [...active.anchors, point] });
          else setError("A track supports up to 12 waypoints.");
        }}
        onMove={(i, p) =>
          active &&
          tracks.edit({
            anchors: active.anchors.map((old, j) => (i === j ? p : old)),
          })
        }
      />
      <header className="brand">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
        <span>
          ibex<small>MAKE YOUR OWN WAY</small>
        </span>
      </header>
      <div className="map-actions">
        <button
          className="glow"
          aria-label="Compute active track"
          disabled={!canCompute}
          onClick={routing.compute}
        >
          <RefreshCw className={routing.busy ? "spin" : ""} />
        </button>
        <button
          aria-label="Find my location"
          onClick={() =>
            navigator.geolocation
              ? navigator.geolocation.getCurrentPosition(
                  (p) => fit([[p.coords.longitude, p.coords.latitude]]),
                  () =>
                    setError("Location unavailable. Check location permissions."),
                )
              : setError("Location is unavailable in this browser.")
          }
        >
          <LocateFixed />
        </button>
        <button
          aria-label="Search places"
          aria-expanded={search.open}
          onClick={() => search.setOpen(!search.open)}
        >
          <Search />
        </button>
        <button aria-label="Zoom in" onClick={() => moveCamera("zoomIn")}>
          <Plus />
        </button>
        <button aria-label="Zoom out" onClick={() => moveCamera("zoomOut")}>
          <Minus />
        </button>
        {rotated && (
          <button
            aria-label="Reset bearing and pitch"
            onClick={() => moveCamera("resetNorth")}
          >
            <Navigation
              style={{ transform: `rotate(${-camera.bearing}deg)` }}
            />
          </button>
        )}
      </div>
      {search.open && (
        <form className="search-box glass" onSubmit={search.search}>
          <label htmlFor="place-search">Find a place</label>
          <div className="row">
            <input
              id="place-search"
              value={search.query}
              onChange={(e) => search.setQuery(e.target.value)}
              placeholder="Town, mountain, address…"
            />
            <button disabled={!search.query.trim() || search.searching}>
              {search.searching ? "Searching…" : "Search"}
            </button>
          </div>
          {search.places.map((p, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                fit([p.point]);
                search.setOpen(false);
              }}
            >
              {p.name}
            </button>
          ))}
        </form>
      )}
      {menu && active && (
        <WaypointMenu
          state={menu}
          count={active.anchors.length}
          onClose={() => setMenu(undefined)}
          onRemove={(i) => {
            setMenu(undefined);
            tracks.edit({ anchors: active.anchors.filter((_, j) => j !== i) });
          }}
          onInsert={(i) => {
            setMenu(undefined);
            setInsertAt(i);
          }}
        />
      )}
      {insertAt !== undefined && (
        <div className="mode-hint glass" role="status">
          <span>Tap the map to insert waypoint {insertAt + 1}</span>
          <button onClick={() => setInsertAt(undefined)}>Cancel</button>
        </div>
      )}
      <Panel ctx={ctx} tab={tab} error={error} panel={panel} />
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
