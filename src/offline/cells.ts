/**
 * Presentation state for one downloadable grid cell. Derived on every render from the
 * catalogue plus what is actually installed — never persisted, so the two can never
 * disagree. Selection is transient intent and deliberately not stored either.
 */
import type { BBox, CellId } from "../geo/grid";
import type { Catalogue, CatalogueCell } from "./catalogue";
import type { Installed } from "./store";

export type CellState =
  /** Published but not offered, or absent from the catalogue entirely. */
  | "unavailable"
  | "available"
  | "selected"
  | "queued"
  | "downloading"
  | "installed"
  /** Installed, but the catalogue offers a newer version of the same cell. */
  | "update-available"
  /** Installed from a different graph generation, so it cannot join a route. */
  | "foreign-release"
  | "failed";

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
  "foreign-release": "#b29aff",
  failed: "#ed4242",
};

export type CellActivity = {
  selected?: ReadonlySet<CellId>;
  queued?: ReadonlySet<CellId>;
  downloading?: CellId;
  failed?: ReadonlyMap<CellId, string>;
};

/**
 * In-flight activity outranks stored state so progress stays visible, then installed state
 * outranks selection: a cell the user already has is never merely "selected".
 */
export function cellState(
  cell: CatalogueCell,
  installed: Installed | undefined,
  release: string,
  activity: CellActivity = {},
): CellState {
  if (activity.downloading === cell.id) return "downloading";
  if (activity.failed?.has(cell.id)) return "failed";
  if (activity.queued?.has(cell.id)) return "queued";
  if (installed) {
    const manifest = installed.manifest as { release?: string };
    if (manifest.release && manifest.release !== release)
      return "foreign-release";
    return installed.manifest.version === cell.version
      ? "installed"
      : "update-available";
  }
  if (!cell.available) return "unavailable";
  if (activity.selected?.has(cell.id)) return "selected";
  return "available";
}

export function mapCells(
  catalogue: Catalogue,
  installed: Installed[],
  activity: CellActivity = {},
): MapCell[] {
  const byId = new Map(installed.map((p) => [p.manifest.id, p]));
  return catalogue.cells.map((cell) => ({
    id: cell.id,
    bbox: cell.bbox as BBox,
    state: cellState(cell, byId.get(cell.id), catalogue.release, activity),
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
