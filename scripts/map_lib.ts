/**
 * What the map scripts share: where the Protomaps builds, fonts and sprite come from, and
 * the few helpers every one of them needs. `basemap.ts` and `map_cells.ts` cut the same
 * build, and they must agree on which one is the latest.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const BUILDS = "https://build-metadata.protomaps.dev/builds.json";
export const ASSETS = "https://protomaps.github.io/basemaps-assets";
/** The fonts the Protomaps layers and the app's own labels ask for. */
export const FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"];
export const SPRITES = ["light.json", "light.png", "light@2x.json", "light@2x.png"];
/** Mapterhorn's planet relief, z0 to 12: the tiles the map draws online, as one archive. */
export const MAPTERHORN = "https://download.mapterhorn.com/planet.pmtiles";

export const protomapsBuild = (build: string) => `https://build.protomaps.com/${build}.pmtiles`;

export function run(command: string, argv: string[], options: { quiet?: boolean } = {}) {
  if (!options.quiet) console.log(`  $ ${command} ${argv.join(" ")}`);
  const result = spawnSync(command, argv, { stdio: options.quiet ? "pipe" : "inherit" });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}${result.stderr ? `: ${result.stderr}` : ""}`);
  return result;
}

export async function latestBuild(): Promise<string> {
  const builds = (await (await fetch(BUILDS)).json()) as { key: string }[];
  const key = builds.map((b) => b.key).sort().at(-1);
  if (!key) throw new Error("No Protomaps build listed");
  return key.replace(/\.pmtiles$/, "");
}

export async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Fetch a URL, or nothing for a 404: not every font covers every glyph range. */
export async function download(url: string): Promise<Uint8Array | undefined> {
  // GitHub Pages answers the odd 503 across 768 requests; one of them once stopped a
  // publish after the 6 GB archive was already up.
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url);
    if (response.status === 404) return undefined;
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    if (response.status < 500 || attempt === 5)
      throw new Error(`${url}: HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}
