/** Rebuilt local pack; deployment may override with the matching model-4 manifest. */
export const DEFAULT_REGION_MANIFEST = `${import.meta.env.BASE_URL}packs/geneva/manifest.json`;
/** Catalogue of downloadable grid cells; the region manifest above is the legacy path. */
export const DEFAULT_CATALOGUE_URL = `${import.meta.env.BASE_URL}packs/geneva-grid/catalogue.json`;

/** Resolve a configured override against the deployment base, as the region manifest does. */
export function absoluteURL(configured: string, fallback: string): string {
  return new URL(
    configured || fallback,
    new URL(import.meta.env.BASE_URL, location.origin),
  ).href;
}
