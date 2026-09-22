/**
 * Terrarium DEM sampling on Node, against the shared tile cache.
 *
 * Kept out of `src/build/` proper because it is the one part of a build that touches the
 * network and the disk. A browser does the same job with `createImageBitmap` and its own
 * storage; the graph code only ever sees the resulting node-to-metres map.
 *
 * Points are grouped by tile so exactly one decoded image is resident at a time. Holding
 * every tile at once was fine for the ~30 a single region needed and is several GB for the
 * thousands a full release needs.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { bilinearHeight, terrariumHeight, type HeightTile } from "../terrain";
import { mercatorX, mercatorY } from "../../geo/grid";

/** 6.6 m/px at Alpine latitudes, matching `region_config.TERRAIN_ZOOM`. */
export const TERRAIN_ZOOM = 13;
const TILE_URL = (z: number, x: number, y: number) => `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`;

type TileKey = `${number}/${number}`;

/** Tile x/y plus the pixel offset inside a 512 px tile, sharing the grid's projection. */
function tileCoord(p: readonly [number, number], zoom: number) {
  const n = 2 ** zoom;
  const x = mercatorX(p[0]) * n;
  const y = mercatorY(p[1]) * n;
  return { x: Math.trunc(x), y: Math.trunc(y), px: (x % 1) * 512, py: (y % 1) * 512 };
}

async function decodeWebP(bytes: Uint8Array): Promise<HeightTile> {
  // sharp is the only decoder available to Node without shipping a WASM codec; it is a
  // build-time dependency, never part of the app bundle.
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const heights = new Float32Array(info.width * info.height);
  for (let i = 0; i < heights.length; i++) {
    const at = i * info.channels;
    heights[i] = terrariumHeight(data[at], data[at + 1], data[at + 2]);
  }
  return { width: info.width, height: info.height, data: heights };
}

/**
 * Heights for the given node positions, in metres.
 *
 * A tile that cannot be fetched leaves its nodes absent rather than guessing zero — the
 * caller decides whether the resulting coverage is good enough to publish.
 */
export async function sampleTerrain(
  positions: ReadonlyMap<number, [number, number]>,
  cacheDir: string,
  zoom = TERRAIN_ZOOM,
): Promise<Map<number, number>> {
  const byTile = new Map<TileKey, { id: number; px: number; py: number }[]>();
  for (const [id, p] of positions) {
    const { x, y, px, py } = tileCoord(p, zoom);
    const key: TileKey = `${x}/${y}`;
    const bucket = byTile.get(key);
    if (bucket) bucket.push({ id, px, py });
    else byTile.set(key, [{ id, px, py }]);
  }

  await fs.mkdir(cacheDir, { recursive: true });
  const elevations = new Map<number, number>();
  let missing = 0;

  for (const [key, points] of byTile) {
    const [x, y] = key.split("/").map(Number);
    const file = path.join(cacheDir, `${zoom}-${x}-${y}.webp`);
    let bytes: Uint8Array | undefined;
    try {
      bytes = new Uint8Array(await fs.readFile(file));
    } catch {
      try {
        const response = await fetch(TILE_URL(zoom, x, y));
        if (response.ok) {
          bytes = new Uint8Array(await response.arrayBuffer());
          // Adjacent cell builds share this cache, so each writer needs its own temporary.
          const temporary = `${file}.${process.pid}.partial`;
          await fs.writeFile(temporary, bytes);
          await fs.rename(temporary, file);
        }
      } catch {
        bytes = undefined;
      }
    }
    if (!bytes) {
      missing++;
      continue;
    }
    const tile = await decodeWebP(bytes);
    for (const { id, px, py } of points) elevations.set(id, bilinearHeight(tile, px, py));
  }

  if (missing) console.warn(`${missing} of ${byTile.size} terrain tiles were unavailable`);
  return elevations;
}
