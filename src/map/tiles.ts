/**
 * One protocol for every map tile, glyph and sprite: `ibex://`.
 *
 * Each request is answered from the map packs on the device when one covers it, and from
 * the bucket otherwise. The same style therefore draws online and offline, and a
 * downloaded area costs no bandwidth when online either.
 *
 *   ibex://basemap/{z}/{x}/{y}   Protomaps vector tiles
 *   ibex://routes/{z}/{x}/{y}    cycle-route vector tiles
 *   ibex://terrain/{z}/{x}/{y}   Terrarium relief
 *   ibex://glyphs/{fontstack}/{range}.pbf
 *   ibex://sprite/light[@2x].{json,png}
 *
 * Map packs are cut per z9 routing cell from zoom 7 up (`scripts/map_cells.ts`), so a tile
 * at z9 or deeper belongs to exactly one cell, and one at z7 or z8 to any installed cell
 * beneath it. The world pack covers z0 to 6 and holds the fonts and the sprite.
 */
import { PMTiles, type RangeResponse, type Source } from "pmtiles";
import type { MapResources } from "./resources";
import { readFile, readRange, type MapInstalled } from "../offline/store";

export const TILE_PROTOCOL = "ibex";
/** The z9 routing grid the map packs are cut on. */
const PACK_ZOOM = 9;
/** The shallowest zoom a cell's map pack holds; shallower comes from the world pack. */
export const PACK_MINZOOM = 7;
/**
 * Map packs stop at z14 (half the size of z15, measured 2026-11-21) and the online source
 * stops there too, so the map looks the same with and without a connection; MapLibre
 * overzooms past it.
 */
export const BASEMAP_MAXZOOM = 14;

export type TileLayer = "basemap" | "routes" | "terrain";
const LAYER_FILE: Record<TileLayer, "basemap.pmtiles" | "routes.pmtiles" | "terrain.pmtiles"> = {
  basemap: "basemap.pmtiles",
  routes: "routes.pmtiles",
  terrain: "terrain.pmtiles",
};

export const tileURL = (layer: TileLayer) => `${TILE_PROTOCOL}://${layer}/{z}/{x}/{y}`;
export const GLYPHS_URL = `${TILE_PROTOCOL}://glyphs/{fontstack}/{range}.pbf`;
export const SPRITE_URL = `${TILE_PROTOCOL}://sprite/light`;

/** An installed pack's file read by range, so a tile never loads the whole archive. */
class PackSource implements Source {
  constructor(
    private pack: MapInstalled,
    private path: string,
  ) {}
  getKey() {
    return `${this.pack.directory}/${this.path}`;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: await readRange(this.pack, this.path, offset, length) };
  }
}

type Open = { pack: MapInstalled; archives: Map<TileLayer, PMTiles> };
const open = (pack: MapInstalled): Open => ({
  pack,
  archives: new Map(
    (Object.keys(LAYER_FILE) as TileLayer[])
      .filter((layer) => pack.manifest.files.some((f) => f.path === LAYER_FILE[layer]))
      .map((layer) => [layer, new PMTiles(new PackSource(pack, LAYER_FILE[layer]))]),
  ),
});

let cells = new Map<string, Open>();
let world: (Open & { assets?: Promise<Map<string, string>> }) | undefined;
let remote: MapResources | undefined;
const remoteArchives = new Map<string, PMTiles>();

/** The bucket's files, for whatever no installed pack covers. */
export function setRemote(resources: MapResources | undefined) {
  remote = resources;
}

/** The installed map packs. Archives already open stay open, with their header cache. */
export function setPacks(packs: readonly MapInstalled[]) {
  const next = new Map<string, Open>();
  let nextWorld: typeof world;
  for (const pack of packs) {
    const kept =
      pack.manifest.id === "world"
        ? world?.pack.directory === pack.directory
          ? world
          : undefined
        : cells.get(pack.manifest.id)?.pack.directory === pack.directory
          ? cells.get(pack.manifest.id)
          : undefined;
    const entry = kept ?? open(pack);
    if (pack.manifest.id === "world") nextWorld = entry;
    else next.set(pack.manifest.id, entry);
  }
  cells = next;
  world = nextWorld;
}

export const hasPacks = () => cells.size > 0;

/** The installed archive answering for this tile, if any pack covers it. */
export function localArchive(layer: TileLayer, z: number, x: number, y: number) {
  if (z >= PACK_ZOOM) {
    const shift = z - PACK_ZOOM;
    return cells.get(`${PACK_ZOOM}-${x >> shift}-${y >> shift}`)?.archives.get(layer);
  }
  if (z >= PACK_MINZOOM) {
    const shift = PACK_ZOOM - z;
    for (const [id, open] of cells) {
      const [, cx, cy] = id.split("-").map(Number);
      if (cx >> shift === x && cy >> shift === y) {
        const archive = open.archives.get(layer);
        if (archive) return archive;
      }
    }
    return undefined;
  }
  return world?.archives.get(layer);
}

function remoteArchive(url: string): PMTiles {
  let archive = remoteArchives.get(url);
  if (!archive) {
    archive = new PMTiles(url);
    remoteArchives.set(url, archive);
  }
  return archive;
}

/** A tile that is not there; distinct from a failure, so it can be drawn as nothing. */
export class TileUnavailable extends Error {
  constructor(what: string) {
    super(`Map tile unavailable offline: ${what}`);
    this.name = "TileUnavailable";
  }
}

/**
 * The bytes of one tile. An installed pack is authoritative for what it covers: a tile it
 * lacks is empty there, not something to fetch. `undefined` means an empty tile.
 */
export async function tile(
  layer: TileLayer,
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer | undefined> {
  const local = localArchive(layer, z, x, y);
  if (local) return (await local.getZxy(z, x, y, signal))?.data;
  if (!remote) throw new TileUnavailable(`${layer} ${z}/${x}/${y}`);
  if (layer === "terrain") {
    if (!remote.terrain) return undefined;
    const url = remote.terrain
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
    const response = await fetch(url, { signal }).catch(() => undefined);
    if (!response?.ok) throw new TileUnavailable(`${layer} ${z}/${x}/${y}`);
    return response.arrayBuffer();
  }
  const url = layer === "basemap" ? remote.basemap : remote.cycleRoutes;
  if (!url) return undefined;
  try {
    return (await remoteArchive(url).getZxy(z, x, y, signal))?.data;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TileUnavailable(`${layer} ${z}/${x}/${y}`);
  }
}

/** The world pack's fonts and sprite, as base64 keyed by `glyphs/…` and `sprite/…`. */
function worldAssets(): Promise<Map<string, string>> | undefined {
  const current = world;
  if (!current?.pack.manifest.files.some((f) => f.path === "assets.json")) return undefined;
  current.assets ??= readFile(current.pack, "assets.json").then(
    (bytes) =>
      new Map(Object.entries(JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>)),
  );
  return current.assets;
}

const decodeBase64 = (text: string) => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

/** A glyph range or sprite file, by its path below `ibex://`. */
export async function asset(path: string, signal?: AbortSignal): Promise<ArrayBuffer | undefined> {
  const saved = (await worldAssets()?.catch(() => undefined))?.get(path);
  if (saved !== undefined) return decodeBase64(saved);
  if (!remote) return undefined;
  let url: string | undefined;
  const glyph = path.match(/^glyphs\/([^/]+)\/(\d+-\d+)\.pbf$/);
  if (glyph)
    url = remote.glyphs
      .replace("{fontstack}", encodeURIComponent(glyph[1]))
      .replace("{range}", glyph[2]);
  const sprite = path.match(/^sprite\/[^/]+?((?:@2x)?\.(?:json|png))$/);
  if (sprite) url = remote.sprite + sprite[1];
  if (!url) return undefined;
  const response = await fetch(url, { signal }).catch(() => undefined);
  return response?.ok ? response.arrayBuffer() : undefined;
}

type Request = { url: string };
/** MapLibre's `addProtocol` handler. */
export async function protocol(
  request: Request,
  controller: AbortController,
): Promise<{ data: ArrayBuffer | object }> {
  // MapLibre fills `{fontstack}` in as written; the browser may have escaped its spaces.
  const path = decodeURIComponent(request.url.slice(`${TILE_PROTOCOL}://`.length));
  const zxy = path.match(/^(basemap|routes|terrain)\/(\d+)\/(\d+)\/(\d+)$/);
  if (zxy) {
    const [, layer, z, x, y] = zxy;
    const data = await tile(layer as TileLayer, +z, +x, +y, controller.signal);
    if (data) return { data };
    // An empty vector tile is a valid answer; an empty raster is not an image.
    if (layer === "terrain") throw new TileUnavailable(path);
    return { data: new ArrayBuffer(0) };
  }
  const data = await asset(path, controller.signal);
  if (path.startsWith("glyphs/"))
    // A missing glyph range draws those characters as nothing; failing it would drop
    // every label in the tile that asked.
    return { data: data ?? new ArrayBuffer(0) };
  if (!data) throw new TileUnavailable(path);
  if (path.endsWith(".json")) return { data: JSON.parse(new TextDecoder().decode(data)) as object };
  return { data };
}

/** maplibre-contour's tile fetch, for the same relief through the same packs. */
export async function demTile(url: string, controller: AbortController) {
  const zxy = url.match(/(\d+)\/(\d+)\/(\d+)$/);
  if (!zxy) throw new Error(`Not a relief tile: ${url}`);
  const data = await tile("terrain", +zxy[1], +zxy[2], +zxy[3], controller.signal);
  if (!data) throw new TileUnavailable(url);
  return { data: new Blob([data], { type: "image/webp" }) };
}
