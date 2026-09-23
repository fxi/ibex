/**
 * Where the basemap's own files live: the vector tiles, the cycle routes, the fonts and
 * the sprite. All of it sits in the bucket beside the cells, named in `map.json` at the
 * data root, so nothing the map draws needs a key and nothing but that index is mutable.
 */
import { z } from "zod";

/**
 * The same Terrarium tiles the builder samples for grades (src/build/platform/terrainCache.ts),
 * so the relief on screen and the climbs in a route come from one surface.
 */
export const TERRAIN_TILES = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";

const mapIndexSchema = z.object({
  /** Protomaps basemap archive, relative to the data root. */
  basemap: z.string().min(1),
  /** Cycle and MTB route relations as a PMTiles archive; absent draws none. */
  cycleRoutes: z.string().min(1).optional(),
  /** MapLibre glyph template with `{fontstack}` and `{range}`. */
  glyphs: z.string().includes("{fontstack}").includes("{range}"),
  /** Sprite base URL, without `.json`/`.png`. */
  sprite: z.string().min(1),
  /**
   * Terrarium relief tiles for hillshade and contours: absent means Mapterhorn, `null`
   * means none. The browser-test fixture turns it off, since relief is the one map input
   * no fixture file can stand in for.
   */
  terrain: z.string().includes("{z}").nullable().optional(),
});

/** The same index with every entry resolved to an absolute URL. */
export type MapResources = Omit<z.infer<typeof mapIndexSchema>, "terrain"> & {
  terrain: string | null;
};

export function mapIndexURL(dataRoot: string): string {
  return `${dataRoot.replace(/\/+$/, "")}/map.json`;
}

/**
 * Resolve the index against the data root. The glyph template is joined by hand because
 * `new URL` would percent-encode its braces.
 */
export function parseMapIndex(document: unknown, dataRoot: string): MapResources {
  const index = mapIndexSchema.parse(document);
  const root = `${dataRoot.replace(/\/+$/, "")}/`;
  const resolve = (path: string) =>
    /^[a-z]+:\/\//i.test(path) ? path : root + path.replace(/^\/+/, "");
  return {
    basemap: resolve(index.basemap),
    cycleRoutes: index.cycleRoutes && resolve(index.cycleRoutes),
    glyphs: resolve(index.glyphs),
    sprite: resolve(index.sprite),
    terrain:
      index.terrain === undefined
        ? TERRAIN_TILES
        : index.terrain && resolve(index.terrain),
  };
}

export async function loadMapResources(dataRoot: string): Promise<MapResources> {
  const response = await fetch(mapIndexURL(dataRoot), { cache: "no-cache" });
  if (!response.ok) throw new Error(`map.json: HTTP ${response.status}`);
  return parseMapIndex(await response.json(), dataRoot);
}
