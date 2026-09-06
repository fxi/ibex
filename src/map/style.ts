import type { StyleSpecification } from "maplibre-gl";
import downloaded from "./custom-style.json";

/** Authenticate only MapTiler resources; never modify unrelated URLs. */
export function mapResourceURL(
  resource: string,
  key: string | undefined,
): string {
  if (!key?.trim() || !resource.startsWith("https://api.maptiler.com/"))
    return resource;
  const url = new URL(resource);
  url.searchParams.set("key", key.trim());
  return url.href;
}

/** The bundled JSON is the only style, independent of connectivity. */
export function customMapStyle(key: string | undefined): StyleSpecification {
  return JSON.parse(
    JSON.stringify(downloaded).replaceAll(
      "INSERT_YOUR_OWN_API_KEY",
      encodeURIComponent(key?.trim() ?? ""),
    ),
  ) as StyleSpecification;
}
