/**
 * Map packs: the map cut per routing cell, so a downloaded area keeps its map offline.
 *
 * For each z9 cell, three PMTiles archives from zoom 7 up, each read by range request from
 * its source so only the cell's tiles touch the disk:
 *
 *   basemap.pmtiles   the Protomaps daily build, z7–14
 *   routes.pmtiles    the published cycle-routes archive (map.json `cycleRoutes`), z7–14
 *   terrain.pmtiles   Mapterhorn relief, z7–12 (skipped when map.json turns relief off)
 *
 * And one world pack (`--world`): the basemap to z6, and the fonts and sprite as
 * `assets.json`. The app installs it with the first cell (src/map/tiles.ts).
 *
 * Measured 2026-11-21, z7–14: basemap 12–23 MB a cell (rural France, Lausanne), relief
 * 7–13 MB (the Alps are the largest), world 45 MB.
 *
 *   node --import tsx scripts/map_cells.ts --cells 9-265-181 --dry-run
 *   node --import tsx scripts/map_cells.ts --world --publish
 *   node --import tsx scripts/map_cells.ts --publish --skip-built     # every published cell
 *
 * Files go to `map-cells/<id>/<hash>.<name>` and `map-world/<hash>.<name>`, named after
 * their bytes; `map.json` lists them under `cells` and `world`. Needs `pmtiles` on the PATH.
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { cellBBox, parseCellId } from "../src/geo/grid";
import { client, IMMUTABLE, putLargeFile, readMapIndex, updateMapIndex, type Bucket } from "./s3";
import {
  ASSETS,
  download,
  FONTS,
  latestBuild,
  MAPTERHORN,
  protomapsBuild,
  run,
  sha256,
  SPRITES,
} from "./map_lib";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const out = option("out") ?? ".cache/map-cells";
const dryRun = flag("dry-run");
const publish = flag("publish");
/** The deepest zoom of a pack; the app overzooms past it. Must match BASEMAP_MAXZOOM. */
const MAXZOOM = 14;
const PACK_MINZOOM = 7;
const TERRAIN_MAXZOOM = 12;
const WORLD_MAXZOOM = 6;
/**
 * Glyph ranges in the world pack: Latin, Greek, Cyrillic, Armenian, Hebrew, Arabic and the
 * Indic scripts, up to U+2FFF with punctuation and symbols. CJK is drawn by the browser's
 * own fonts (MapLibre's `localIdeographFontFamily`), so it needs none.
 */
const GLYPH_LIMIT = 0x3000;
/** Pulled in from the cell edge, so a pack holds its own deep tiles and not its neighbours'. */
const INSET = 1e-4;

type FileEntry = { path: string; url: string; bytes: number; sha256: string };
type PackEntry = { hash: string; build?: string; files: FileEntry[] };
type Index = Record<string, unknown> & {
  cycleRoutes?: string;
  terrain?: string | null;
  cells?: Record<string, PackEntry>;
  world?: PackEntry;
};

const dataRoot = () => {
  const root = process.env.S3_PUBLIC_URL ?? process.env.VITE_DATA_URL;
  if (!root) throw new Error("Set S3_PUBLIC_URL to read the catalogue and map.json");
  return root.replace(/\/+$/, "");
};

async function publicIndex(): Promise<Index> {
  const response = await fetch(`${dataRoot()}/map.json`, { cache: "no-store" });
  return response.ok ? ((await response.json()) as Index) : {};
}

async function publishedCells(): Promise<string[]> {
  const response = await fetch(`${dataRoot()}/catalog.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`catalog.json: HTTP ${response.status}`);
  return ((await response.json()) as { cells: { id: string }[] }).cells.map((c) => c.id);
}

/** `pmtiles extract`; with `--dry-run` it prints the archive size it would write. */
function extract(source: string, to: string, options: string[]) {
  const argv = ["extract", source, to, ...options, ...(dryRun ? ["--dry-run"] : [])];
  const result = run("pmtiles", argv, { quiet: true });
  const size = `${result.stdout}${result.stderr}`.match(/archive size of ([\d.]+ \w+)/)?.[1];
  if (dryRun) console.log(`    ${to.split("/").at(-1)}: ${size ?? "?"}`);
}

/** Hash, name after the bytes, and send each file; the pack's hash covers them all. */
async function pack(
  at: Bucket | undefined,
  prefix: string,
  files: { path: string; file: string }[],
): Promise<PackEntry> {
  const entries: FileEntry[] = [];
  for (const { path, file } of files) {
    const digest = await sha256(file);
    const { size } = await fs.stat(file);
    const url = `${prefix}/${digest.slice(0, 16)}.${path}`;
    const type = path.endsWith(".json") ? "application/json" : "application/vnd.pmtiles";
    if (at) await putLargeFile(at, url, file, { type, cache: IMMUTABLE });
    entries.push({ path, url, bytes: size, sha256: digest });
  }
  const hash = createHash("sha256")
    .update(entries.map((e) => `${e.path}:${e.sha256}`).join("\n"))
    .digest("hex")
    .slice(0, 16);
  return { hash, files: entries };
}

async function buildCell(id: string, build: string, index: Index, at?: Bucket) {
  const [w, s, e, n] = cellBBox(parseCellId(id));
  const bbox = `--bbox=${w + INSET},${s + INSET},${e - INSET},${n - INSET}`;
  const dir = `${out}/${id}`;
  await fs.mkdir(dir, { recursive: true });
  const zooms = (max: number) => [`--minzoom=${PACK_MINZOOM}`, `--maxzoom=${max}`];
  const files: { path: string; file: string }[] = [];

  extract(protomapsBuild(build), `${dir}/basemap.pmtiles`, [bbox, ...zooms(MAXZOOM)]);
  files.push({ path: "basemap.pmtiles", file: `${dir}/basemap.pmtiles` });
  if (index.cycleRoutes) {
    extract(`${dataRoot()}/${index.cycleRoutes}`, `${dir}/routes.pmtiles`, [bbox, ...zooms(MAXZOOM)]);
    files.push({ path: "routes.pmtiles", file: `${dir}/routes.pmtiles` });
  }
  // Absent means Mapterhorn, which is what the app draws; a relief of our own would have to
  // be cut from its own archive, and `null` turns relief off altogether.
  if (index.terrain === undefined) {
    extract(MAPTERHORN, `${dir}/terrain.pmtiles`, [bbox, ...zooms(TERRAIN_MAXZOOM)]);
    files.push({ path: "terrain.pmtiles", file: `${dir}/terrain.pmtiles` });
  } else if (index.terrain) console.warn(`    relief: ${index.terrain} cannot be cut; skipped`);
  if (dryRun) return undefined;

  const entry = { ...(await pack(at, `map-cells/${id}`, files)), build };
  const bytes = entry.files.reduce((sum, f) => sum + f.bytes, 0);
  console.log(`    pack ${entry.hash}: ${(bytes / 1e6).toFixed(1)} MB`);
  if (at) await fs.rm(dir, { recursive: true });
  return entry;
}

async function buildWorld(build: string, at?: Bucket) {
  const dir = `${out}/world`;
  await fs.mkdir(dir, { recursive: true });
  extract(protomapsBuild(build), `${dir}/basemap.pmtiles`, [`--maxzoom=${WORLD_MAXZOOM}`]);
  if (dryRun) return undefined;

  // Fonts and sprite as one JSON of base64, keyed by the path the app's protocol asks for.
  const assets: Record<string, string> = {};
  const jobs: { key: string; url: string }[] = [];
  for (const font of FONTS)
    for (let start = 0; start < GLYPH_LIMIT; start += 256) {
      const range = `${start}-${start + 255}`;
      jobs.push({
        key: `glyphs/${font}/${range}.pbf`,
        url: `${ASSETS}/fonts/${encodeURIComponent(font)}/${range}.pbf`,
      });
    }
  for (const sprite of SPRITES)
    jobs.push({ key: `sprite/${sprite}`, url: `${ASSETS}/sprites/v4/${sprite}` });
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const body = await download(job.url);
        if (body) assets[job.key] = Buffer.from(body).toString("base64");
      }
    }),
  );
  // Sorted keys, so the same assets always hash the same.
  const sorted = Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(`${dir}/assets.json`, JSON.stringify(sorted));
  console.log(`    assets.json: ${Object.keys(sorted).length} files`);

  const entry = {
    ...(await pack(at, "map-world", [
      { path: "basemap.pmtiles", file: `${dir}/basemap.pmtiles` },
      { path: "assets.json", file: `${dir}/assets.json` },
    ])),
    build,
  };
  const bytes = entry.files.reduce((sum, f) => sum + f.bytes, 0);
  console.log(`    world pack ${entry.hash}: ${(bytes / 1e6).toFixed(1)} MB`);
  if (at) await fs.rm(dir, { recursive: true });
  return entry;
}

async function main() {
  const build = option("build") ?? (await latestBuild());
  const at = publish && !dryRun ? client() : undefined;
  const index: Index = at ? ((await readMapIndex(at)) as Index) : await publicIndex();
  console.log(`Protomaps build ${build}, packs z${PACK_MINZOOM}–${MAXZOOM}`);

  if (flag("world") && flag("skip-built") && index.world) console.log("world: already built");
  else if (flag("world")) {
    console.log("world");
    const world = await buildWorld(build, at);
    if (world && at) await updateMapIndex(at, { world });
  }

  const ids = option("cells")?.split(",") ?? (flag("world") ? [] : await publishedCells());
  const limit = Number(option("limit") ?? Infinity);
  let built = 0;
  for (const id of ids) {
    if (built >= limit) break;
    parseCellId(id);
    if (flag("skip-built") && index.cells?.[id]) continue;
    console.log(`${id} (${built + 1}/${Math.min(ids.length, limit)})`);
    const entry = await buildCell(id, build, index, at);
    built++;
    if (!entry || !at) continue;
    // Re-read before each write: the index is small, and a run takes hours.
    const latest = (await readMapIndex(at)) as Index;
    await updateMapIndex(at, { cells: { ...latest.cells, [id]: entry } });
  }
  if (!at && !dryRun) console.log(`Built under ${out}; --publish sends the packs and updates map.json.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
