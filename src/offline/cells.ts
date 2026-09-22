/**
 * Presentation state for one downloadable grid cell. Derived on every render from the
 * catalogue plus what is actually installed — never persisted, so the two can never
 * disagree. Selection is transient intent and deliberately not stored either.
 */
import type { BBox, CellId } from "../geo/grid";
import type { Catalogue, CatalogueCell } from "./catalogue";
import type { Installed } from "./store";

export type CellState =
  /** Not built yet, so there is nothing to download: the grid still shows it. */
  | "unavailable"
  | "available"
  | "selected"
  | "queued"
  | "downloading"
  | "installed"
  /** Installed, but the catalogue offers a newer version of the same cell. */
  | "update-available"
  /** Installed and marked to be downloaded again on the next run. */
  | "marked-refresh"
  /** Installed and marked for deletion on the next run. */
  | "marked-remove"
  | "failed";

/**
 * What the user has asked to happen to a cell on the next run. Intent is transient and
 * deliberately unpersisted: nothing should still be pending after a reload.
 */
export type CellIntent = "add" | "refresh" | "remove";

export type MapCell = { id: CellId; bbox: BBox; state: CellState };

/** Data-driven paint values, kept beside the states so a new state cannot be missed. */
export const CELL_COLORS: Record<CellState, string> = {
  unavailable: "#41525f",
  available: "#8fa3b8",
  selected: "#2485ff",
  queued: "#2485ff",
  downloading: "#2485ff",
  installed: "#54d5ba",
  "update-available": "#ffb34d",
  "marked-refresh": "#ffb34d",
  "marked-remove": "#ed4242",
  failed: "#ed4242",
};

export type CellActivity = {
  intents?: ReadonlyMap<CellId, CellIntent>;
  queued?: ReadonlySet<CellId>;
  downloading?: CellId;
  failed?: ReadonlyMap<CellId, string>;
};

/**
 * One click advances a cell through the actions available to it, and back to doing
 * nothing. A cell the user does not have can only be added; a cell they do have can be
 * refreshed or removed — so the two cases cycle through different lengths.
 */
export function nextIntent(
  held: boolean,
  current: CellIntent | undefined,
): CellIntent | undefined {
  if (!held) return current === "add" ? undefined : "add";
  if (current === "refresh") return "remove";
  if (current === "remove") return undefined;
  return "refresh";
}

/**
 * In-flight activity outranks stored state so progress stays visible, then installed state
 * outranks selection: a cell the user already has is never merely "selected".
 *
 * `entry` is the catalogue's record of the cell, or nothing at all — the grid covers the
 * whole world and most of it has not been built yet, so "no entry" is an ordinary state
 * and reads as `unavailable`.
 */
export function cellState(
  id: CellId,
  entry: CatalogueCell | undefined,
  installed: Installed | undefined,
  activity: CellActivity = {},
): CellState {
  if (activity.downloading === id) return "downloading";
  if (activity.failed?.has(id)) return "failed";
  if (activity.queued?.has(id)) return "queued";
  const intent = activity.intents?.get(id);
  if (installed) {
    // Intent outranks the stored state: a cell marked for removal must read as marked
    // even while it is still installed and routable.
    if (intent === "refresh") return "marked-refresh";
    if (intent === "remove") return "marked-remove";
    // A cell is stale when the catalogue offers different bytes than the ones installed.
    // That is the whole rule: there is no release to belong to.
    if (!entry) return "installed";
    return installed.manifest.hash === entry.hash ? "installed" : "update-available";
  }
  if (!entry) return "unavailable";
  if (intent === "add") return "selected";
  return "available";
}

/** Every cell's state by id, for painting a grid the catalogue only partly covers. */
export function cellStates(
  catalogue: Catalogue | undefined,
  installed: Installed[],
  activity: CellActivity = {},
): Map<CellId, CellState> {
  const byId = new Map(installed.map((p) => [p.manifest.id, p]));
  const entries = new Map((catalogue?.cells ?? []).map((c) => [c.id, c]));
  const states = new Map<CellId, CellState>();
  for (const id of new Set([...entries.keys(), ...byId.keys()]))
    states.set(id, cellState(id, entries.get(id), byId.get(id), activity));
  return states;
}

export function mapCells(
  catalogue: Catalogue | undefined,
  installed: Installed[],
  activity: CellActivity = {},
): MapCell[] {
  const byId = new Map(installed.map((p) => [p.manifest.id, p]));
  return (catalogue?.cells ?? []).map((cell) => ({
    id: cell.id,
    bbox: cell.bbox as BBox,
    state: cellState(cell.id, cell, byId.get(cell.id), activity),
  }));
}

/** Cells that hold data the user can remove, including ones no longer in the catalogue. */
export function installedCells(
  installed: Installed[],
  catalogue?: Catalogue,
): Installed[] {
  const published = new Set(catalogue?.cells.map((c) => c.id) ?? []);
  return installed
    .filter((p) => /^\d{1,2}-\d{1,8}-\d{1,8}$/.test(p.manifest.id))
    .sort((a, b) =>
      published.has(b.manifest.id) === published.has(a.manifest.id)
        ? a.manifest.id.localeCompare(b.manifest.id)
        : published.has(a.manifest.id)
          ? -1
          : 1,
    );
}

/** Pack sizes span kilobytes (fixtures) to tens of megabytes (real cells). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}
