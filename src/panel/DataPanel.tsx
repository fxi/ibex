import { Search, Download, Trash2, RefreshCw } from "lucide-react";
import { CELL_COLORS, formatBytes } from "../offline/cells";
import { coverageBBox } from "../offline/catalogue";
import { cellLabel, cellSizeM, parseCellId } from "../geo/grid";
import type { PanelContext } from "./context";
import { SectionHeading } from "./SectionHeading";

export function DataPanel({ ctx }: { ctx: PanelContext }) {
  const { data, online, fit } = ctx;
  const {
    catalogue,
    catalogueError,
    notice,
    installed,
    cells,
    savedCells,
    routableCells,
    intents,
    queuedCells,
    downloadingCell,
    failedCells,
    missingCells,
    progress,
    storage,
    markAll,
    toggleCell,
    clearIntents,
    process,
    cancelDownloads,
  } = data;

  const busy = downloadingCell !== undefined;
  const pending = intents.size;
  const stale =
    cells?.filter((c) => c.state === "update-available").map((c) => c.id) ?? [];
  const held = savedCells.map((p) => p.manifest.id);
  // Only downloads cost bytes; removals are what the run reclaims.
  const adding = [...intents]
    .filter(([, i]) => i !== "remove")
    .map(([id]) => id);
  const bytes =
    catalogue?.cells
      .filter((c) => adding.includes(c.id))
      .reduce((sum, c) => sum + c.bytes, 0) ?? 0;

  return (
    <>
      <SectionHeading
        title="Your map data"
        info="Click the grid to select, update or remove areas."
      />

      {/* Readiness is reported whether or not there is a connection: being offline is
          exactly when it matters that the data is already here. Connectivity only
          governs whether new downloads can run. */}
      <div className={`connection-row ${online ? "" : "offline"}`}>
        <i className={routableCells.length ? "saved" : ""} />
        <span>
          {routableCells.length
            ? `${routableCells.length} ${routableCells.length === 1 ? "area" : "areas"} ready for offline routing`
            : "No areas saved yet"}
        </span>
        {!online && <em>Offline · downloads unavailable</em>}
      </div>

      {notice && <p className="hint">{notice}</p>}
      {catalogueError && <p className="hint">{catalogueError}</p>}

      {!catalogue ? (
        <p>
          Map area catalogue unavailable. Connect to the internet to load
          available data.
        </p>
      ) : (
        <fieldset className="data-body" disabled={!online}>
          <button
            className="primary wide"
            disabled={!pending || busy}
            onClick={process}
          >
            <Download size={20} />
            {pending
              ? `Process ${pending} cell ${pending === 1 ? "change" : "changes"}${
                  bytes ? ` · ${formatBytes(bytes)}` : ""
                }`
              : "No pending changes"}
          </button>
          {pending > 0 && !busy && (
            <button onClick={clearIntents}>Clear pending changes</button>
          )}

          {busy && (
            <>
              <progress value={progress ?? 0} max="1" />
              <button onClick={cancelDownloads}>
                {`Cancel · ${queuedCells.size} remaining`}
              </button>
            </>
          )}

          {failedCells.size > 0 && (
            <>
              {/* The reason is per-cell, so it belongs here rather than in the
                  panel-wide error banner. Distinct messages only. */}
              <p className="error" role="alert">
                {[...new Set(failedCells.values())].join(" ")}
              </p>
              <button onClick={() => data.download([...failedCells.keys()])}>
                {`Retry ${failedCells.size} failed`}
              </button>
            </>
          )}

          <section className="cell-grid">
            <header>
              <div>
                <strong>Saved areas</strong>
                <small>
                  {savedCells.length} of {catalogue.cells.length} ·{" "}
                  {Math.round(
                    cellSizeM(parseCellId(catalogue.cells[0].id)) / 1000,
                  )}{" "}
                  km each
                </small>
              </div>
            </header>
            {savedCells.length === 0 ? (
              <p className="hint">
                Click a square on the map to choose an area.
              </p>
            ) : (
              <ul>
                {savedCells.map((pack) => {
                  const id = pack.manifest.id;
                  const label = cellLabel(parseCellId(id));
                  const state =
                    cells?.find((c) => c.id === id)?.state ?? "installed";
                  const needed = missingCells.includes(id);
                  return (
                    <li
                      key={id}
                      className={
                        "cell cell-" + state + (needed ? " cell-needed" : "")
                      }
                      style={
                        {
                          "--cell-color": CELL_COLORS[state],
                        } as React.CSSProperties
                      }
                    >
                      <span className="cell-name">{label}</span>
                      <span className="cell-state">
                        {state === "downloading" && progress !== undefined
                          ? Math.round(progress * 100) + "%"
                          : state}
                      </span>
                      <button
                        className="icon-button"
                        aria-label={"Update area " + label}
                        disabled={busy}
                        onClick={() => markAll([id], "refresh")}
                      >
                        <RefreshCw size={15} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={"Remove area " + label}
                        disabled={busy}
                        onClick={() => markAll([id], "remove")}
                      >
                        <Trash2 size={15} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={"Zoom to area " + label}
                        onClick={() =>
                          fit([
                            [pack.manifest.bbox[0], pack.manifest.bbox[1]],
                            [pack.manifest.bbox[2], pack.manifest.bbox[3]],
                          ])
                        }
                      >
                        <Search size={15} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {/* The map grid is the primary way to choose areas, but it needs a
                rendered basemap and a pointer. This list keeps the same actions
                reachable by keyboard, and usable when the map cannot load. */}
            <details className="all-areas">
              <summary>{`All areas (${catalogue.cells.length})`}</summary>
              <ul>
                {catalogue.cells.map((cell) => {
                  const state =
                    cells?.find((c) => c.id === cell.id)?.state ?? "available";
                  const label = cellLabel(parseCellId(cell.id));
                  return (
                    <li
                      key={cell.id}
                      className={"cell cell-" + state}
                      style={
                        {
                          "--cell-color": CELL_COLORS[state],
                        } as React.CSSProperties
                      }
                    >
                      <button
                        className="cell-toggle"
                        aria-label={"Select area " + label}
                        disabled={busy}
                        onClick={() => toggleCell(cell.id)}
                      >
                        <span className="cell-name">{label}</span>
                        <span className="cell-size">
                          {formatBytes(cell.bytes)}
                        </span>
                        <span className="cell-state">{state}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </details>
            <div className="row bulk">
              <button
                disabled={!held.length || busy}
                onClick={() => markAll(held, "remove")}
              >
                Delete all
              </button>
              <button
                disabled={!stale.length || busy}
                onClick={() => markAll(stale, "refresh")}
              >
                {`Update all stale${stale.length ? ` (${stale.length})` : ""}`}
              </button>
              <button
                disabled={!installed.length}
                onClick={() => {
                  const b = coverageBBox(catalogue);
                  fit([
                    [b[0], b[1]],
                    [b[2], b[3]],
                  ]);
                }}
              >
                Zoom to all
              </button>
            </div>
          </section>
        </fieldset>
      )}

      <p className="hint">{storage}</p>
      <p className="note">
        Downloaded data supports local routing. The background map and place
        search need an internet connection.
      </p>
    </>
  );
}
