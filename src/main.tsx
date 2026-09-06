import { storageEstimate } from "./offline/capabilities";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { MapView } from "./map/Map";
import {
  listPacks,
  preference,
  readManifest,
  savePreference,
  type Installed,
  type Manifest,
} from "./offline/store";
import type {
  Attraction,
  Comparison,
  Point,
  Profile,
  RouteResult,
} from "./routing/types";
import { download, exportGPX } from "./gpx";
import { Elevation } from "./Elevation";
import { DEFAULT_REGION_MANIFEST } from "./config";
import RoutingWorker from "./workers/route.worker.ts?worker&inline";
import DataWorker from "./workers/data.worker.ts?worker&inline";
const base = new URL(import.meta.env.BASE_URL, location.origin);
const manifestURL = new URL(
  import.meta.env.VITE_REGION_MANIFEST || DEFAULT_REGION_MANIFEST,
  base,
).href;
const remoteMap = new URL("basemap.pmtiles", manifestURL).href;
const examples: { name: string; anchors: Point[] }[] = [
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
  {
    name: "Along the Arve",
    anchors: [
      [6.146, 46.189],
      [6.235, 46.177],
    ],
  },
];
function App() {
  const [pack, setPack] = useState<Installed>(),
    [catalog, setCatalog] = useState<Manifest>(),
    [anchors, setAnchors] = useState<Point[]>([]),
    [profile, setProfile] = useState<Profile>("gravel"),
    [attraction, setAttraction] = useState<Attraction>();
  const [comparison, setComparison] = useState<Comparison>(),
    [partial, setPartial] = useState<RouteResult>(),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<number>();
  const [debug, setDebug] = useState(false),
    [history, setHistory] = useState(false),
    [tool, setTool] = useState<"waypoint" | "attraction">("waypoint"),
    [online, setOnline] = useState(navigator.onLine),
    [ready, setReady] = useState(false),
    [packsReady, setPacksReady] = useState(false),
    [storage, setStorage] = useState("");
  const routeWorker = useRef<Worker | undefined>(undefined),
    dataWorker = useRef<Worker | undefined>(undefined),
    generation = useRef(0);
  useEffect(() => {
    const w = new DataWorker();
    dataWorker.current = w;
    w.onmessage = (e) => {
      const message = e.data;
      if (message.type === "progress") setProgress(message.fraction);
      if (message.type === "installed") {
        setPack(message.pack);
        setProgress(undefined);
        setError("");
      }
      if (message.type === "error") {
        setError(message.error);
        setProgress(undefined);
      }
      if (message.type === "removed") {
        setPack(undefined);
        setComparison(undefined);
        setPartial(undefined);
      }
    };
    listPacks()
      .then((packs) => setPack(packs[0]))
      .catch(() => setError("Browser storage unavailable"))
      .finally(() => setPacksReady(true));
    readManifest(manifestURL)
      .then(setCatalog)
      .catch(() => {});
    preference<{ anchors: Point[]; profile: Profile; attraction?: Attraction }>(
      "plan",
    )
      .then((plan) => {
        if (plan) {
          setAnchors(plan.anchors);
          setProfile(plan.profile);
          setAttraction(plan.attraction);
        }
        setReady(true);
      })
      .catch(() => setReady(true));
    storageEstimate().then((e) =>
      setStorage(
        e.quota
          ? `${((e.quota - (e.usage ?? 0)) / 1e9).toFixed(1)} GB estimated available`
          : "",
      ),
    );
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      w.terminate();
      routeWorker.current?.terminate();
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    if (ready)
      savePreference("plan", { anchors, profile, attraction }).catch(() => {});
  }, [anchors, profile, attraction, ready]);
  useEffect(() => {
    const id = ++generation.current;
    routeWorker.current?.terminate();
    setBusy(false);
    setComparison(undefined);
    setPartial(undefined);
    if (!pack || anchors.length < 2) return;
    const timer = setTimeout(() => {
      const worker = new RoutingWorker();
      routeWorker.current = worker;
      setBusy(true);
      setError("");
      setStatus("Preparing local data…");
      worker.onmessage = (e) => {
        if (e.data.id !== generation.current) return;
        const message = e.data;
        if (message.type === "progress") setStatus(message.label);
        if (message.type === "partial") setPartial(message.route);
        if (message.type === "result") {
          setComparison(message.comparison);
          setBusy(false);
          setStatus("Comparison complete");
          worker.terminate();
        }
        if (message.type === "error") {
          setError(message.error);
          setBusy(false);
          worker.terminate();
        }
      };
      worker.onerror = (event) => {
        if (id === generation.current) {
          setError(
            `Routing worker stopped${event.message ? `: ${event.message}` : ". Try a shorter route or reload."}`,
          );
          setBusy(false);
        }
      };
      worker.postMessage({
        id,
        pack,
        request: { anchors, profile, attraction },
      });
    }, 300);
    return () => {
      clearTimeout(timer);
      routeWorker.current?.terminate();
    };
  }, [anchors, profile, attraction, pack]);
  const result = comparison?.corridor ?? partial;
  const addPoint = (point: Point) => {
    if (tool === "attraction") {
      setAttraction({ point, radiusM: 2500, strength: 0.35 });
      setTool("waypoint");
    } else setAnchors((a) => (a.length < 12 ? [...a, point] : a));
  };
  const changeAnchor = (i: number, p: Point) =>
    setAnchors((a) => a.map((old, j) => (i === j ? p : old)));
  const install = () => {
    setProgress(0);
    setError("");
    dataWorker.current?.postMessage({
      id: 1,
      type: "install",
      url: manifestURL,
    });
  };
  return (
    <main>
      {packsReady && (pack || online) && (
        <MapView
          pack={pack}
          remoteMap={remoteMap}
          anchors={anchors}
          attraction={attraction}
          comparison={comparison}
          partial={partial}
          debug={debug}
          history={history}
          onPoint={addPoint}
          onMove={changeAnchor}
          onError={setError}
        />
      )}
      <header className="brand">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
        <div>
          <h1>
            cyclatractor<span> / </span>
          </h1>
          <p>THE WAY YOU WOULD CHOOSE.</p>
        </div>
        <span className="lab-badge">FIELD NOTES · 01</span>
      </header>
      <div className={`connection ${pack ? "installed" : ""}`}>
        <span className="status-dot" />
        {pack
          ? isSecureContext
            ? "Region saved offline"
            : "Region saved locally"
          : online
            ? "Online · region not saved"
            : "Offline · region required"}
      </div>
      <section className="panel" aria-label="Route planner">
        <div className="eyebrow">
          GENEVA BASIN <span>46°12′ N · 6°09′ E</span>
        </div>
        <h2>
          Find your
          <br />
          <em>kind of road.</em>
        </h2>
        <p className="intro">
          From the river to the ridgeline.
          <br />A little less traffic. A little more possibility.
        </p>
        <div className="profiles" aria-label="Cycling profile">
          {(["gravel", "road", "touring"] as Profile[]).map((p) => (
            <button
              key={p}
              aria-pressed={profile === p}
              onClick={() => setProfile(p)}
            >
              {p === "gravel" ? "⌁" : p === "road" ? "↗" : "△"}{" "}
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
        <div className="waypoints">
          {anchors.length === 0 ? (
            <div className="empty-waypoints">
              <b>A</b>
              <span>Tap the map to start exploring</span>
            </div>
          ) : (
            anchors.map((p, i) => (
              <div className="waypoint" key={i}>
                <b>{String.fromCharCode(65 + i)}</b>
                <span>
                  {p[1].toFixed(4)}° N, {p[0].toFixed(4)}° E
                </span>
                <button
                  aria-label={`Remove waypoint ${i + 1}`}
                  onClick={() => setAnchors((a) => a.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))
          )}
          {anchors.length === 1 && (
            <p className="hint">Choose your destination on the map.</p>
          )}
        </div>
        <div className="tools">
          <button
            className={tool === "attraction" ? "selected" : ""}
            onClick={() =>
              setTool((t) => (t === "attraction" ? "waypoint" : "attraction"))
            }
          >
            ⊕{" "}
            {tool === "attraction"
              ? "Tap an area to attract"
              : "Draw me through here"}
          </button>
          <button
            onClick={() => {
              setAnchors([]);
              setAttraction(undefined);
            }}
          >
            Reset
          </button>
        </div>
        {attraction && (
          <div className="attraction-controls">
            <label>
              Attraction radius{" "}
              <input
                aria-label="Attraction radius"
                type="range"
                min="500"
                max="6000"
                step="250"
                value={attraction.radiusM}
                onChange={(e) =>
                  setAttraction({ ...attraction, radiusM: +e.target.value })
                }
              />
              {(attraction.radiusM / 1000).toFixed(1)} km
            </label>
            <button onClick={() => setAttraction(undefined)}>Remove</button>
          </div>
        )}
        {!anchors.length && (
          <div className="examples">
            <span>A PLACE TO BEGIN</span>
            {examples.map((example) => (
              <button
                key={example.name}
                onClick={() => setAnchors(example.anchors)}
              >
                {example.name}
                <span>↗</span>
              </button>
            ))}
          </div>
        )}
        {!pack && (
          <div className="download-card">
            <div>
              <strong>Take the region with you</strong>
              <p>
                {isSecureContext
                  ? "Local routing. A map that stays."
                  : "Local routing available. Use HTTPS to reopen offline."}
              </p>
            </div>
            <button
              className="primary"
              disabled={progress !== undefined || !online}
              onClick={install}
            >
              {progress !== undefined
                ? `Saving ${Math.round(progress * 100)}%`
                : `Save ${isSecureContext ? "offline" : "locally"}${catalog ? ` · ${Math.round(catalog.files.reduce((s, f) => s + f.bytes, 0) / 1e6)} MB` : ""}`}
              <span>↓</span>
            </button>
            {progress !== undefined && (
              <button
                onClick={() =>
                  dataWorker.current?.postMessage({ id: 1, type: "cancel" })
                }
              >
                Cancel download
              </button>
            )}
            <small>{storage}</small>
          </div>
        )}
        {busy && (
          <div className="calculation" role="status">
            <span className="spinner" />
            {status}
            <button
              onClick={() => {
                generation.current++;
                routeWorker.current?.terminate();
                setBusy(false);
                setStatus("Cancelled");
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {result && result.status !== "ok" && (
          <p role="status" className="error">
            {
              {
                "outside-coverage":
                  "A waypoint is outside the downloaded region.",
                "snap-failed":
                  "No accessible cycling connection within 250 m of a waypoint.",
                "no-path": "No route found in the available graph.",
                "budget-exceeded":
                  "Search budget reached. Try closer waypoints.",
              }[result.status]
            }
          </p>
        )}
        {result?.status === "ok" && (
          <div className="result">
            <Elevation route={result} />
            <div className="route-stats">
              <div>
                <strong>{(result.distanceM / 1000).toFixed(1)}</strong>
                <span>kilometres</span>
              </div>
              <div>
                <strong>
                  {result.ascentM === null ? "—" : Math.round(result.ascentM)}
                </strong>
                <span>metres climbing</span>
              </div>
            </div>
            {result.ascentM === null && (
              <p className="hint">Elevation is incomplete on this route.</p>
            )}
            <p className="hint">
              {Math.round(
                (result.uncertainM / Math.max(1, result.distanceM)) * 100,
              )}
              % with uncertain map attributes
            </p>
            <button
              className="primary"
              onClick={() =>
                download(
                  "cyclatractor.gpx",
                  exportGPX(result),
                  "application/gpx+xml",
                )
              }
            >
              Export your route <span>↗</span>
            </button>
          </div>
        )}
        <details
          className="lab"
          open={debug}
          onToggle={(e) => setDebug(e.currentTarget.open)}
        >
          <summary>
            Inside the route <span>＋</span>
          </summary>
          <p>Territory first. A valid path second.</p>
          <div className="legend">
            <i className="orange" />
            Semantic route <i className="blue" />
            Full graph
          </div>
          {comparison && (
            <>
              <table>
                <thead>
                  <tr>
                    <th>Measured</th>
                    <th>Full graph</th>
                    <th>Corridor</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [
                      "Time",
                      ...[comparison.reference, comparison.corridor].map(
                        (r) => `${(r.metrics.durationMs / 1000).toFixed(2)} s`,
                      ),
                    ],
                    [
                      "Explored",
                      ...[comparison.reference, comparison.corridor].map((r) =>
                        r.metrics.explored.toLocaleString(),
                      ),
                    ],
                    [
                      "Graph read",
                      ...[comparison.reference, comparison.corridor].map(
                        (r) => `${(r.metrics.loadedBytes / 1e6).toFixed(1)} MB`,
                      ),
                    ],
                  ].map((row) => (
                    <tr key={row[0]}>
                      {row.map((v, i) => (
                        <td key={i}>{v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                Cost difference:{" "}
                {comparison.relativeCost === null
                  ? "unavailable"
                  : `${(comparison.relativeCost * 100).toFixed(1)}%`}{" "}
                · {comparison.corridor.metrics.expansions} expansions
              </p>
              <div className="components">
                {Object.entries(comparison.corridor.components).map(
                  ([name, value]) => (
                    <div key={name}>
                      <span>{name}</span>
                      <meter
                        min={0}
                        max={Math.max(1, comparison.corridor.cost)}
                        value={Math.max(0, value)}
                      />
                      <span>{Math.round(value)}</span>
                    </div>
                  ),
                )}
              </div>
              <button
                onClick={() =>
                  download(
                    "cyclatractor-debug.json",
                    JSON.stringify(
                      {
                        request: { anchors, profile, attraction },
                        packVersion: pack?.manifest.version,
                        comparison,
                      },
                      null,
                      2,
                    ),
                    "application/json",
                  )
                }
              >
                Export local diagnostics
              </button>
            </>
          )}
          <label className="toggle">
            <input
              type="checkbox"
              checked={history}
              onChange={(e) => setHistory(e.target.checked)}
            />
            Your rides · online reference layer
          </label>
        </details>
        {pack && (
          <details className="pack-details">
            <summary>Saved region · {pack.manifest.name}</summary>
            <p>
              OSM {pack.manifest.osmTimestamp.slice(0, 10)} · v
              {pack.manifest.version.slice(0, 8)}
            </p>
            <p>
              {Math.round(pack.manifest.terrainCoverage * 100)}% of edges have
              terrain profiles
            </p>
            {catalog && catalog.version !== pack.manifest.version && (
              <button onClick={install}>Install available update</button>
            )}
            <button
              onClick={() =>
                dataWorker.current?.postMessage({ id: 2, type: "remove", pack })
              }
            >
              Remove downloaded region
            </button>
          </details>
        )}
        <footer>
          MADE FOR THE LONG WAY HOME <span>↗</span>
        </footer>
      </section>
      <div className="map-caption">
        <span>↗</span> JURA · SALÈVE · VOIRONS{" "}
        <small>Experimental cycling routes · OSM + Mapterhorn</small>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
