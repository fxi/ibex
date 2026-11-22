/**
 * Put a Protomaps basemap, its fonts and its sprite in the bucket, and name them in
 * `map.json` for the app.
 *
 * The planet build is 130 GB; the app needs the ground its cells cover and the rest of the
 * world only far enough out to find it. So this cuts the covered box at full detail from
 * zoom 7 to 14, the whole world up to zoom 6, and joins them into one archive. `pmtiles extract`
 * reads the daily build by range request, so nothing but the result touches the disk.
 *
 *   node --import tsx scripts/basemap.ts --dry-run
 *   node --import tsx scripts/basemap.ts --publish
 *   node --import tsx scripts/basemap.ts --bbox 5.8,45.7,7.2,46.6 --build 20260923
 *
 * Needs `pmtiles` (go-pmtiles) and `tile-join` (tippecanoe) on the PATH.
 */
import fs from "node:fs/promises";
import { cellBBox, parseCellId, type BBox } from "../src/geo/grid";
import { client, IMMUTABLE, putLargeFile, putObject, updateMapIndex, type Bucket } from "./s3";
import { ASSETS, download, FONTS, latestBuild, protomapsBuild, run, sha256, SPRITES } from "./map_lib";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

/** Fonts and sprites keep their names across releases, so they are cached for a week. */
const WEEK = "public, max-age=604800";

const out = option("out") ?? ".cache/basemap";
const worldMaxzoom = Number(option("world-maxzoom") ?? 6);
const dryRun = flag("dry-run");
const publish = flag("publish");

/** The published cells' extent, padded so the edge of the covered ground is not the map's. */
async function coveredBox(): Promise<BBox> {
  const root = process.env.S3_PUBLIC_URL ?? process.env.VITE_DATA_URL;
  if (!root) throw new Error("Give --bbox, or set S3_PUBLIC_URL to read the catalogue");
  const catalogue = (await (await fetch(`${root.replace(/\/+$/, "")}/catalog.json`)).json()) as {
    cells: { id: string }[];
  };
  const pad = 0.5;
  return catalogue.cells
    .map((c) => cellBBox(parseCellId(c.id)))
    .reduce(
      (b, c) => [
        Math.min(b[0], c[0] - pad),
        Math.min(b[1], c[1] - pad),
        Math.max(b[2], c[2] + pad),
        Math.max(b[3], c[3] + pad),
      ],
      [180, 90, -180, -90],
    )
    .map((v) => Math.round(v * 1000) / 1000) as BBox;
}

async function buildArchive(build: string, bbox: BBox): Promise<string> {
  const source = protomapsBuild(build);
  await fs.mkdir(out, { recursive: true });
  const world = `${out}/world-${build}.pmtiles`;
  const region = `${out}/region-${build}.pmtiles`;
  const merged = `${out}/basemap-${build}.pmtiles`;
  // A build that stopped at the upload resumes there instead of fetching 6 GB again.
  if (!dryRun && (await fs.stat(merged).catch(() => undefined))) return merged;
  const extract = (to: string, extra: string[]) =>
    run("pmtiles", ["extract", source, to, ...extra, ...(dryRun ? ["--dry-run"] : [])]);
  extract(world, [`--maxzoom=${worldMaxzoom}`]);
  // The app stops at z14 and overzooms (src/map/tiles.ts), so z15 would be bytes nobody reads.
  extract(region, [`--bbox=${bbox.join(",")}`, `--minzoom=${worldMaxzoom + 1}`, "--maxzoom=14"]);
  if (dryRun) return merged;
  // The zoom ranges do not overlap, so joining never merges two versions of one tile.
  run("tile-join", ["-o", merged, "--no-tile-size-limit", "--force", world, region]);
  await fs.rm(world);
  await fs.rm(region);
  return merged;
}

async function publishAssets(at: Bucket) {
  const jobs: { path: string; url: string; type: string }[] = [];
  for (const font of FONTS)
    for (let start = 0; start < 65536; start += 256) {
      const range = `${start}-${start + 255}`;
      jobs.push({
        path: `assets/fonts/${font}/${range}.pbf`,
        url: `${ASSETS}/fonts/${encodeURIComponent(font)}/${range}.pbf`,
        type: "application/x-protobuf",
      });
    }
  for (const sprite of SPRITES)
    jobs.push({
      path: `assets/sprites/v4/${sprite}`,
      url: `${ASSETS}/sprites/v4/${sprite}`,
      type: sprite.endsWith(".png") ? "image/png" : "application/json",
    });
  let sent = 0;
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const body = await download(job.url);
        if (!body) continue;
        await putObject(at, job.path, body, { type: job.type, cache: WEEK });
        sent++;
      }
    }),
  );
  console.log(`  ${sent} font and sprite files sent`);
}

async function main() {
  const build = option("build") ?? (await latestBuild());
  const bbox = option("bbox")
    ? (option("bbox")!.split(",").map(Number) as BBox)
    : await coveredBox();
  if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n)))
    throw new Error(`--bbox wants W,S,E,N`);
  console.log(`Protomaps build ${build}, detail over ${bbox.join(",")}, world to z${worldMaxzoom}`);

  const archive = await buildArchive(build, bbox);
  if (dryRun) return;
  const hash = (await sha256(archive)).slice(0, 16);
  const path = `basemap/${hash}.pmtiles`;
  const { size } = await fs.stat(archive);
  console.log(`  ${archive}: ${(size / 1e9).toFixed(2)} GB → ${path}`);
  if (!publish) {
    console.log("Built locally; --publish sends it to the bucket.");
    return;
  }

  const at = client();
  console.log(`  ${await putLargeFile(at, path, archive, { type: "application/vnd.pmtiles", cache: IMMUTABLE })} ${path}`);
  if (!flag("skip-assets")) await publishAssets(at);
  await updateMapIndex(at, {
    basemap: path,
    glyphs: "assets/fonts/{fontstack}/{range}.pbf",
    sprite: "assets/sprites/v4/light",
  });
  if (!flag("keep-local")) await fs.rm(archive);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
