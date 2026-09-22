/**
 * Long multi-waypoint route against the local release, whole-route versus leg-by-leg.
 *
 *   node --import tsx scripts/audit_long_route.ts legs  [profile] [packs dir]
 *   node --max-old-space-size=4096 --import tsx scripts/audit_long_route.ts whole [profile] [packs dir]
 *
 * `whole` reproduces the former worker: one graph under the bbox of every waypoint and one
 * search across all legs. Run it with a browser-sized heap to see the crash.
 */
import { GENERATION } from "../src/offline/version";
import { readFileSync } from "node:fs";
import { catalogueSchema } from "../src/offline/catalogue";
import type { Installed } from "../src/offline/store";
import { compareOn, routeLegs } from "../src/routing/legs";
import {
  CellGraphProvider,
  searchArea,
  type PackReader,
} from "../src/routing/provider";
import { selectedRoute } from "../src/routing/selection";
import type { Point } from "../src/routing/types";
import { DEFAULT_CELLS } from "./local_release";
import { loadProfile } from "./profile";

const DIR = process.argv[4] ?? DEFAULT_CELLS;
const mode = process.argv[2] ?? "legs";
const profile = await loadProfile(process.argv[3] ?? "gravel_50");
const catalogue = catalogueSchema.parse(
  JSON.parse(readFileSync(`${DIR}/catalogue.json`, "utf8")),
);

// Geneva → Annecy → Chambéry → Grenoble → Gap → Sisteron: ~5 legs, ~400–500 km ridden.
// Chambéry is the station: the old-town point snaps onto a six-node pedestrian island.
const anchors: Point[] = [
  [6.1432, 46.2044],
  [6.1296, 45.8992],
  [5.9194, 45.5712],
  [5.7245, 45.1885],
  [6.0794, 44.5594],
  [5.9436, 44.195],
];

const read = (path: string) => new Uint8Array(readFileSync(path));
const packs = catalogue.cells.map(
  (c) =>
    ({
      manifest: JSON.parse(
        readFileSync(`${DIR}/${c.id}/manifest.json`, "utf8"),
      ),
      installedAt: "1970-01-01T00:00:00.000Z",
      directory: c.id,
      backend: "idb",
    }) as Installed,
);
const reader: PackReader = {
  async readFile(pack, path) {
    return read(`${DIR}/${pack.manifest.id}/${path}`).buffer as ArrayBuffer;
  },
  async readRange(pack, path, offset, length) {
    const bytes = read(`${DIR}/${pack.manifest.id}/${path}`);
    return bytes.slice(offset, offset + length).buffer as ArrayBuffer;
  },
};

let peak = 0;
const sampler = setInterval(
  () => (peak = Math.max(peak, process.memoryUsage().heapUsed)),
  50,
);
const provider = new CellGraphProvider(
  packs,
  GENERATION,
  catalogue.cells.map((c) => ({ id: c.id, bbox: c.bbox })),
  reader,
);
await provider.open();
const coverage = provider.envelope()!;
for (const a of anchors)
  if (!provider.contains(a)) throw new Error(`Anchor ${a} is not covered`);

const started = performance.now();
const progress = (label: string) =>
  console.error(
    `${((performance.now() - started) / 1000).toFixed(1)}s ${label} · heap ${(
      process.memoryUsage().heapUsed /
      2 ** 20
    ).toFixed(0)} MB`,
  );
const comparison =
  mode === "whole"
    ? compareOn(
        await provider.load(searchArea(anchors)),
        { anchors, profile },
        coverage,
        progress,
      )
    : await routeLegs(provider, { anchors, profile }, coverage, progress);
clearInterval(sampler);
peak = Math.max(peak, process.memoryUsage().heapUsed);
const selected = selectedRoute(comparison)!;
console.log(
  JSON.stringify(
    {
      mode,
      profile: profile.id,
      status: selected.status,
      failedLeg: selected.failedLeg,
      distanceKm: +(selected.distanceM / 1000).toFixed(1),
      ascentM: selected.ascentM && Math.round(selected.ascentM),
      explored: selected.metrics.explored,
      seconds: +((performance.now() - started) / 1000).toFixed(1),
      peakHeapMB: Math.round(peak / 2 ** 20),
      blocksDecoded: provider.stats.blocks,
    },
    null,
    2,
  ),
);
