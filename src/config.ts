/** Catalogue of downloadable grid cells — the only routing-data source. */
export const DEFAULT_CATALOGUE_URL = `${import.meta.env.BASE_URL}packs/geneva-grid/catalogue.json`;

/** Resolve a configured override against the deployment base. */
export function absoluteURL(configured: string, fallback: string): string {
  return new URL(
    configured || fallback,
    new URL(import.meta.env.BASE_URL, location.origin),
  ).href;
}
