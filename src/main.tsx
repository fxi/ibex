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
import { BASEMAPS, type Basemap } from "./map/style";
import { BasemapControl } from "./map/BasemapControl";
import { loadModels } from "./models";
import type { Point } from "./routing/types";
import {
  anchorVertices,
  applyLocalEdit,
  type Pinches,
  type RouteGrab,
} from "./routing/localEdit";
import { LIMITS } from "./offline/validate";
import type { Profile } from "./routing/profiles";
import { DEFAULT_CATALOGUE_URL, absoluteURL } from "./config";
import { useTracks } from "./state/useTracks";
import { useCatalogue } from "./state/useCatalogue";
import { useRouting } from "./state/useRouting";
import { useSearch } from "./state/useSearch";
import { usePanelHeight } from "./state/usePanelHeight";
import { WaypointMenu, type WaypointMenuState } from "./map/WaypointMenu";
import { Panel } from "./panel/Panel";
import type { PanelContext } from "./panel/context";

const BASEMAP_KEY = "ibex.basemap";
function storedBasemap(): Basemap {
  try {
    const value = localStorage.getItem(BASEMAP_KEY);
    if (BASEMAPS.some((b) => b.id === value)) return value as Basemap;
  } catch {
    // Storage unavailable: fall through to the default.
  }
  return "outdoor";
}

const catalogueURL = absoluteURL(
  import.meta.env.VITE_CATALOGUE_URL,
  DEFAULT_CATALOGUE_URL,
);

function App() {
  const [tab, setTab] = useState("tracks");
  const [cursor, setCursor] = useState<Point>();
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [command, setCommand] = useState<MapCommand>();
  const [online, setOnline] = useState(navigator.onLine);
  const [models, setModels] = useState<Profile[]>([]);
  const [debug, setDebug] = useState(false);
  const [history, setHistory] = useState(false);
  const [basemap, setBasemapState] = useState<Basemap>(storedBasemap);
  const setBasemap = (value: Basemap) => {
    setBasemapState(value);
    try {
      localStorage.setItem(BASEMAP_KEY, value);
    } catch {
      // Private windows may refuse storage; the choice then lasts this session only.
    }
  };
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

  // Undo and redo route edits from the keyboard, except where a field has its own undo.
  const shortcuts = useRef(tracks);
  shortcuts.current = tracks;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable]"))
        return;
      e.preventDefault();
      if (key === "y" || e.shiftKey) shortcuts.current.redo();
      else shortcuts.current.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  /**
   * Move or insert a waypoint. Pinches from the map keep the edit between the nearest route
   * handles: they become waypoints, and the legs outside them are kept rather than routed
   * again. Each edit is a step that undo can take back.
   */
  const reshape = (grab: RouteGrab, point: Point, pinches?: Pinches) => {
    if (!active) return;
    const route =
      active.resultRevision === active.revision ? active.result : undefined;
    const vertices = route && anchorVertices(route, active.anchors.length);
    const edit = applyLocalEdit(
      active.anchors,
      grab,
      point,
      route && vertices && pinches ? { route, vertices, pinches } : undefined,
    );
    if (edit.anchors.length > LIMITS.anchorsMax) {
      setError(`A track supports up to ${LIMITS.anchorsMax} waypoints.`);
      return;
    }
    tracks.edit({ anchors: edit.anchors });
    routing.computeKeeping(edit.kept);
  };
  const fit = (points: Point[]) => {
    if (points.length) setCommand({ id: Date.now(), kind: "fit", points });
  };
  // The mark is state and the nudge is a one-shot instruction, so they are carried
  // separately: a re-render must not clear the dot, and the camera must not re-ease.
  const locate = (point?: Point) => {
    setCursor(point);
    if (point) setCommand({ id: Date.now(), kind: "locate", points: [point] });
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
    locate,
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

  // Editing is a mode, and the Edit tab is that mode: only there does the map take waypoint
  // taps, drags and marker menus, so browsing tracks or reading the legend cannot move one.
  const editing = tab === "edit";

  return (
    <main>
      <MapView
        editable={editing}
        onInclude={(index, point, pinches) => {
          if (active?.kind !== "planned") return;
          reshape({ kind: "insert", index, position: index }, point, pinches);
        }}
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
        basemap={basemap}
        tracks={tracks.collection?.tracks ?? []}
        activeId={active?.id}
        cells={tab === "data" ? data.cells : undefined}
        onCell={(id) => data.toggleCell(id)}
        bottomInset={panel.open ? panel.height + 90 : 90}
        command={command}
        cursor={cursor}
        onCamera={setCamera}
        onMenu={(index, x, y) => {
          if (editing) setMenu({ index, x, y });
        }}
        onPoint={(point) => {
          if (!editing || !active) return;
          if (active.anchors.length >= LIMITS.anchorsMax) {
            setError(`A track supports up to ${LIMITS.anchorsMax} waypoints.`);
            return;
          }
          const anchors = [...active.anchors];
          anchors.splice(insertAt ?? anchors.length, 0, point);
          tracks.edit({ anchors });
        }}
        onMove={(i, p, pinches) =>
          reshape({ kind: "move", index: i }, p, pinches)
        }
      />
      <header className="brand">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
        <span>ibex</span>
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
          aria-expanded={search.open}
          onClick={() => search.setOpen(!search.open)}
        >
          <Search />
        </button>
        <BasemapControl value={basemap} onChange={setBasemap} />
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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
