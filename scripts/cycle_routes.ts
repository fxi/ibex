/**
 * Signed cycle and MTB routes as a PMTiles archive for the map, from OSM route relations.
 *
 * No general basemap carries route relations — Protomaps and OpenMapTiles both drop them —
 * so the network the router already favours (src/build/relations.ts) has no other way onto
 * the map. Each way becomes one line per route type, tagged with the most important network
 * it belongs to and the refs of the routes at that level:
 *
 *   route    bicycle | mtb
 *   network  icn | ncn | rcn | lcn | whatever the relation says
 *   ref      "EV17 1", the refs at that network level, most important first
 *   name     the name of one such route
 *
 * Covers the extracts under the published cells (or `--regions`). Each download is filtered
 * by osmium as soon as it lands and deleted, so a region never holds more than one extract
 * on disk; the filtered files are small and kept under `.cache/cycle-routes/`.
 *
 *   node --import tsx scripts/cycle_routes.ts --dry-run
 *   node --import tsx scripts/cycle_routes.ts --publish
 *   node --import tsx scripts/cycle_routes.ts --regions switzerland,rhone-alpes
 *
 * Needs `osmium` and `tippecanoe` on the PATH.
 */
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cellBBox, parseCellId } from "../src/geo/grid";
import { extractsFor, readExtractIndex, type Extract } from "../src/build/osm/extracts";
import { geometry, readSource, type CellSource } from "../src/build/osm/source";
import { inflate } from "../src/build/platform/node";
import { client, IMMUTABLE, putLargeFile, updateMapIndex } from "./s3";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const GEOFABRIK_INDEX = "https://download.geofabrik.de/index-v1.json";
const USER_AGENT = "ibex-builder/0.1 (+https://fxi.io/ibex)";
const out = option("out") ?? ".cache/cycle-routes";
const extractsDir = option("extracts") ?? ".cache/extracts";
const dryRun = flag("dry-run");

/** Most important first; anything else ranks below a local network. */
const NETWORK_RANK: Record<string, number> = { icn: 4, ncn: 3, rcn: 2, lcn: 1 };
const rank = (network: string | undefined) => NETWORK_RANK[network ?? ""] ?? 0;
/** The zoom a line first appears at, so tiles far out hold only long-distance routes. */
const MINZOOM: Record<number, number> = { 4: 5, 3: 5, 2: 7, 1: 10, 0: 10 };
/** A route that is not built yet, or not signed, is not a network to follow. */
const UNBUILT = new Set(["proposed", "planned", "construction"]);

function run(command: string, argv: string[]) {
  const result = spawnSync(command, argv, { stdio: "inherit" });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

async function extractIndex(): Promise<Extract[]> {
  const cached = `${extractsDir}/index-v1.json`;
  const text = await fs.readFile(cached, "utf8").catch(async () => {
    const response = await fetch(GEOFABRIK_INDEX, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) throw new Error(`Extract index: HTTP ${response.status}`);
    const body = await response.text();
    await fs.mkdir(extractsDir, { recursive: true });
    await fs.writeFile(cached, body);
    return body;
  });
  return readExtractIndex(JSON.parse(text));
}

/** The downloads under the published cells: each cell's own, never a parent. */
async function wantedExtracts(index: Extract[]): Promise<Extract[]> {
  const regions = option("regions");
  if (regions) {
    const names = regions.split(",").map((n) => n.trim());
    const chosen = index.filter((e) => names.includes(e.id));
    const missing = names.filter((n) => !chosen.some((e) => e.id === n));
    if (missing.length) throw new Error(`No such extract: ${missing.join(", ")}`);
    return chosen;
  }
  const root = process.env.S3_PUBLIC_URL ?? process.env.VITE_DATA_URL;
  if (!root) throw new Error("Give --regions, or set S3_PUBLIC_URL to read the catalogue");
  const catalogue = (await (await fetch(`${root.replace(/\/+$/, "")}/catalog.json`)).json()) as {
    cells: { id: string }[];
  };
  const found = new Map<string, Extract>();
  for (const cell of catalogue.cells)
    for (const extract of extractsFor(index, cellBBox(parseCellId(cell.id))))
      found.set(extract.id, extract);
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Download straight to disk: a country is too large to hold in memory for no reason. */
async function download(extract: Extract): Promise<string> {
  const path = `${extractsDir}/${extract.id}.osm.pbf`;
  if (await fs.stat(path).catch(() => undefined)) return path;
  await fs.mkdir(extractsDir, { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  console.log(`  downloading ${extract.id} …`);
  const response = await fetch(extract.url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok || !response.body)
    throw new Error(`${extract.id}: HTTP ${response.status} from ${extract.url}`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));
  await fs.rename(partial, path);
  return path;
}

/** Only the route relations and legacy-tagged ways, with the ways and nodes they use. */
async function filtered(extract: Extract): Promise<string> {
  const path = `${out}/${extract.id}.osm.pbf`;
  if (await fs.stat(path).catch(() => undefined)) return path;
  const raw = await download(extract);
  await fs.mkdir(out, { recursive: true });
  run("osmium", [
    "tags-filter",
    raw,
    "r/route=bicycle,mtb",
    "w/lcn,rcn,ncn,icn",
    "-o",
    path,
    "--overwrite",
    "--no-progress",
  ]);
  if (!flag("keep-extracts")) await fs.rm(raw);
  return path;
}

type Entry = { route: string; network?: string; ref?: string; name?: string };

/**
 * Every route each way belongs to. A national route is often a relation of relations, so
 * membership is followed down through sub-relations, each contributing its own tags.
 */
function memberships(source: CellSource): Map<number, Entry[]> {
  const relations = new Map(source.relations.map((r) => [r.id, r]));
  const byWay = new Map<number, Entry[]>();
  for (const relation of source.relations) {
    const t = relation.tags;
    if (t.route !== "bicycle" && t.route !== "mtb") continue;
    if (UNBUILT.has(t.state ?? "") || t.signposted === "no") continue;
    const entry: Entry = { route: t.route, network: t.network, ref: t.ref, name: t.name };
    const seen = new Set<number>();
    const visit = (id: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const member of relations.get(id)?.members ?? [])
        if (member.type === "way") {
          const list = byWay.get(member.ref) ?? [];
          list.push(entry);
          byWay.set(member.ref, list);
        } else if (member.type === "relation") visit(member.ref);
    };
    visit(relation.id);
  }
  // Ways tagged `rcn=yes` and the like, from before route relations were the norm.
  for (const way of source.ways)
    for (const network of Object.keys(NETWORK_RANK))
      if (way.tags[network] === "yes" || way.tags[`${network}_ref`]) {
        const list = byWay.get(way.id) ?? [];
        list.push({ route: "bicycle", network, ref: way.tags[`${network}_ref`] });
        byWay.set(way.id, list);
      }
  return byWay;
}

/** One feature per way and route type, at its most important network. */
function* features(source: CellSource) {
  for (const [wayId, entries] of memberships(source)) {
    const way = source.wayById.get(wayId);
    const coordinates = way && geometry(way, source.positions);
    if (!coordinates || coordinates.length < 2) continue;
    for (const route of new Set(entries.map((e) => e.route))) {
      const own = entries.filter((e) => e.route === route);
      const best = Math.max(...own.map((e) => rank(e.network)));
      const top = own.filter((e) => rank(e.network) === best);
      const refs = [...new Set(top.map((e) => e.ref).filter(Boolean))];
      const properties: Record<string, string> = { route };
      const network = top.find((e) => e.network)?.network;
      if (network) properties.network = network;
      if (refs.length) properties.ref = refs.join(" ");
      const name = top.find((e) => e.name)?.name;
      if (name) properties.name = name;
      yield {
        key: `${route}:${wayId}`,
        feature: {
          type: "Feature",
          tippecanoe: { minzoom: route === "mtb" ? 10 : MINZOOM[best] },
          properties,
          geometry: { type: "LineString", coordinates },
        },
      };
    }
  }
}

async function main() {
  const extracts = await wantedExtracts(await extractIndex());
  console.log(`${extracts.length} extracts: ${extracts.map((e) => e.id).join(", ")}`);
  if (dryRun) return;

  await fs.mkdir(out, { recursive: true });
  const lines = `${out}/cycle-routes.geojsonl`;
  const sink = createWriteStream(lines);
  // Extracts overlap at their borders; a way read twice is written once.
  const written = new Set<string>();
  for (const extract of extracts) {
    const path = await filtered(extract);
    const source = await readSource(new Uint8Array(await fs.readFile(path)), inflate);
    let count = 0;
    for (const { key, feature } of features(source)) {
      if (written.has(key)) continue;
      written.add(key);
      sink.write(`${JSON.stringify(feature)}\n`);
      count++;
    }
    console.log(`  ${extract.id}: ${source.relations.length} relations, ${count} lines`);
  }
  await new Promise<void>((resolve, reject) => sink.end((e?: Error | null) => (e ? reject(e) : resolve())));

  const archive = `${out}/cycle-routes.pmtiles`;
  run("tippecanoe", [
    "-o",
    archive,
    "--force",
    "-l",
    "cycle_routes",
    "-Z5",
    "-z14",
    "--no-tile-size-limit",
    "--no-feature-limit",
    "--quiet",
    "--attribution",
    '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>',
    lines,
  ]);
  const bytes = new Uint8Array(await fs.readFile(archive));
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const path = `cycle-routes/${hash}.pmtiles`;
  console.log(`  ${archive}: ${(bytes.length / 1e6).toFixed(1)} MB → ${path}`);
  if (!flag("publish")) {
    console.log("Built locally; --publish sends it to the bucket.");
    return;
  }
  const at = client();
  console.log(`  ${await putLargeFile(at, path, archive, { type: "application/vnd.pmtiles", cache: IMMUTABLE })} ${path}`);
  await updateMapIndex(at, { cycleRoutes: path });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
