import { pointerURL } from "./offline/catalogue";

/**
 * Root of the published data tree (see docs/data-format.md). Unset, it is the app's own
 * `data/` path, which the dev and preview servers serve from a locally staged release.
 */
export const DATA_POINTER_URL = pointerURL(
  new URL(
    import.meta.env.VITE_DATA_URL || `${import.meta.env.BASE_URL}data`,
    new URL(import.meta.env.BASE_URL, location.origin),
  ).href,
);

/** Optional PMTiles archive for the historical ride overlay; unset hides the toggle. */
export const HEATMAP_URL = import.meta.env.VITE_HEATMAP_URL?.trim() ?? "";
