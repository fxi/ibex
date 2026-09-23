/**
 * Put a Protomaps basemap, its fonts and its sprite in the bucket, and name them in
 * `map.json` for the app.
 *
 * The planet build is 130 GB; the app needs the ground its cells cover and the rest of the
 * world only far enough out to find it. So this cuts the covered box at full detail from
 * zoom 7, the whole world up to zoom 6, and joins them into one archive. `pmtiles extract`
 * reads the daily build by range request, so nothing but the result touches the disk.
 *
 *   node --import tsx scripts/basemap.ts --dry-run
 *   node --import tsx scripts/basemap.ts --publish
 *   node --import tsx scripts/basemap.ts --bbox 5.8,45.7,7.2,46.6 --build 20260923
 *
 * Needs `pmtiles` (go-pmtiles) and `tile-join` (tippecanoe) on the PATH.
 */
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cellBBox, parseCellId, type BBox } from "../src/geo/grid";
import { client, IMMUTABLE, putLargeFile, putObject, updateMapIndex, type Bucket } from "./s3";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const BUILDS = "https://build-metadata.protomaps.dev/builds.json";
const ASSETS = "https://protomaps.github.io/basemaps-assets";
/** The fonts the Protomaps layers and the app's own labels ask for. */
const FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"];
const SPRITES = ["light.json", "light.png", "light@2x.json", "light@2x.png"];
/** Fonts and sprites keep their names across releases, so they are cached for a week. */
const WEEK = "public, max-age=604800";

const out = option("out") ?? ".cache/basemap";
const worldMaxzoom = Number(option("world-maxzoom") ?? 6);
const dryRun = flag("dry-run");
const publish = flag("publish");

function run(command: string, argv: string[]) {
  console.log(`  $ ${command} ${argv.join(" ")}`);
  const result = spawnSync(command, argv, { stdio: "inherit" });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

async function latestBuild(): Promise<string> {
  const builds = (await (await fetch(BUILDS)).json()) as { key: string }[];
  const key = builds.map((b) => b.key).sort().at(-1);
  if (!key) throw new Error("No Protomaps build listed");
  return key.replace(/\.pmtiles$/, "");
}

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

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function buildArchive(build: string, bbox: BBox): Promise<string> {
  const source = `https://build.protomaps.com/${build}.pmtiles`;
  await fs.mkdir(out, { recursive: true });
  const world = `${out}/world-${build}.pmtiles`;
  const region = `${out}/region-${build}.pmtiles`;
  const merged = `${out}/basemap-${build}.pmtiles`;
  // A build that stopped at the upload resumes there instead of fetching 6 GB again.
  if (!dryRun && (await fs.stat(merged).catch(() => undefined))) return merged;
  const extract = (to: string, extra: string[]) =>
    run("pmtiles", ["extract", source, to, ...extra, ...(dryRun ? ["--dry-run"] : [])]);
  extract(world, [`--maxzoom=${worldMaxzoom}`]);
  extract(region, [`--bbox=${bbox.join(",")}`, `--minzoom=${worldMaxzoom + 1}`]);
  if (dryRun) return merged;
  // The zoom ranges do not overlap, so joining never merges two versions of one tile.
  run("tile-join", ["-o", merged, "--no-tile-size-limit", "--force", world, region]);
  await fs.rm(world);
  await fs.rm(region);
  return merged;
}

/** Fetch a URL, or nothing for a 404: not every font covers every glyph range. */
async function download(url: string): Promise<Uint8Array | undefined> {
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
