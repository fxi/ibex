/**
 * Where the basemap's own files live: the vector tiles, the cycle routes, the fonts and
 * the sprite. All of it sits in the bucket beside the cells, named in `map.json` at the
 * data root, so nothing the map draws needs a key and nothing but that index is mutable.
 *
 * The index also lists the map packs: the same tiles cut per routing cell, and one world
 * pack, which the Data tab downloads with the cells so the map works offline.
 */
import { z } from "zod";
import { MAP_FILES, preference, savePreference, type MapManifest } from "../offline/store";

/**
 * The same Terrarium tiles the builder samples for grades (src/build/platform/terrainCache.ts),
 * so the relief on screen and the climbs in a route come from one surface.
 */
export const TERRAIN_TILES = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";

/** A bucket path below the data root: no scheme, no climbing out of it. */
const bucketPath = z
  .string()
  .min(1)
  .refine((p) => !/^[a-z]+:/i.test(p) && !p.split("/").includes(".."), "not a bucket path");

const packSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{8,64}$/),
  files: z
    .array(
      z.object({
        path: z.enum(MAP_FILES),
        url: bucketPath,
        bytes: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1),
});
export type MapPackEntry = z.infer<typeof packSchema>;

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
  /** The world far out, with the fonts and sprite: installed with the first cell. */
  world: packSchema.optional(),
  /** Map tiles per routing cell, keyed by cell id. */
  cells: z.record(z.string().regex(/^\d{1,2}-\d{1,8}-\d{1,8}$/), packSchema).optional(),
});

/** The same index with every entry resolved to an absolute URL. */
export type MapResources = Omit<z.infer<typeof mapIndexSchema>, "terrain" | "world" | "cells"> & {
  terrain: string | null;
  world?: MapPackEntry;
  cells: Record<string, MapPackEntry>;
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
  const pack = (entry: MapPackEntry): MapPackEntry => ({
    ...entry,
    files: entry.files.map((f) => ({ ...f, url: resolve(f.url) })),
  });
  return {
    basemap: resolve(index.basemap),
    cycleRoutes: index.cycleRoutes && resolve(index.cycleRoutes),
    glyphs: resolve(index.glyphs),
    sprite: resolve(index.sprite),
    terrain:
      index.terrain === undefined
        ? TERRAIN_TILES
        : index.terrain && resolve(index.terrain),
    world: index.world && pack(index.world),
    cells: Object.fromEntries(
      Object.entries(index.cells ?? {}).map(([id, entry]) => [id, pack(entry)]),
    ),
  };
}

/** What a map pack keeps on the device once installed, and where its files come from. */
export function mapPackJob(id: string, entry: MapPackEntry) {
  const manifest: MapManifest = {
    kind: "map",
    id,
    hash: entry.hash,
    files: entry.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  };
  const sources = Object.fromEntries(entry.files.map((f) => [f.path, f.url]));
  return { manifest, sources };
}

const CACHE_KEY = "ibex-map-index";
type Cached = { root: string; document: unknown };

async function fetchMapResources(dataRoot: string): Promise<MapResources> {
  try {
    const response = await fetch(mapIndexURL(dataRoot), { cache: "no-cache" });
    if (!response.ok) throw new Error(`map.json: HTTP ${response.status}`);
    const document: unknown = await response.json();
    const resources = parseMapIndex(document, dataRoot);
    await savePreference(CACHE_KEY, { root: dataRoot, document } satisfies Cached).catch(
      () => {},
    );
    return resources;
  } catch (error) {
    // Offline, the last index that parsed is what lets installed map packs draw at all.
    const cached = await preference<Cached>(CACHE_KEY).catch(() => undefined);
    if (cached?.root === dataRoot) {
      const parsed = (() => {
        try {
          return parseMapIndex(cached.document, dataRoot);
        } catch {
          return undefined;
        }
      })();
      if (parsed) return parsed;
    }
    throw error;
  }
}

/**
 * The map index, fetched once per page and shared by the map and the Data tab. A failure
 * is not kept, so the next caller (after the connection is back) tries again.
 */
let pending: { root: string; promise: Promise<MapResources> } | undefined;
export function loadMapResources(dataRoot: string): Promise<MapResources> {
  if (pending?.root !== dataRoot) {
    const promise = fetchMapResources(dataRoot);
    pending = { root: dataRoot, promise };
    promise.catch(() => {
      if (pending?.promise === promise) pending = undefined;
    });
  }
  return pending.promise;
}
