/**
 * Golden master for routing output, for behaviour-preserving refactors of the engine.
 *
 * The suite asserts relationships — this profile costs more than that one, this distance
 * falls in a band — which is right for tuning but says nothing about whether a refactor
 * moved a route. This records what the router actually returns on real packs: status,
 * cost, distance, the edges chosen and a digest of the geometry, per scenario per shipped
 * profile. Capture before touching the engine, `--check` after; any difference is a
 * behaviour change, and the refactor was supposed not to be one.
 *
 *   node --import tsx scripts/route_golden.ts [packs dir]            # write
 *   node --import tsx scripts/route_golden.ts [packs dir] --check    # compare, exit 1
 *
 * Output: data/derived/route-golden.json (gitignored with the rest of data/).
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { route, total } from "../src/routing/engine";
import { DEFAULT_CELLS, loadReleaseGraph } from "./local_release";
import { loadProfile, SHIPPED_IDS } from "./profile";
import type { Point, RouteResult } from "../src/routing/types";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const check = process.argv.includes("--check");
const packs = positional[0] ?? DEFAULT_CELLS;
const OUT = "data/derived/route-golden.json";

/** Real ground, chosen to exercise different parts of the search. */
const scenarios: { name: string; anchors: Point[] }[] = [
  // Flat city to a climb: the ordinary case.
  { name: "geneva-voirons", anchors: [[6.151, 46.201], [6.37, 46.22]] },
  // Across the Salève: sustained gradient, where capability and grades decide the line.
  { name: "geneva-saleve", anchors: [[6.151, 46.201], [6.171, 46.119]] },
  // Three anchors: leg splitting, snapping and the restriction prefixes between legs.
  {
    name: "geneva-coudry-menoge",
    anchors: [[6.3533, 46.1632], [6.2603, 46.155], [6.2316, 46.1833]],
  },
  // Long enough to cross a cell seam, which is where merged packs have to agree.
  { name: "geneva-annecy", anchors: [[6.151, 46.201], [6.129, 45.899]] },
];

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/**
 * Everything a refactor must not move. Floats are rounded where the last bits are noise
 * from summation order, but not so far that a real change hides: a millimetre of distance
 * and a thousandth of a cost unit are both far below anything a rider could notice and far
 * above float jitter.
 */
const snapshot = (r: RouteResult) => ({
  status: r.status,
  distanceM: +r.distanceM.toFixed(3),
  cost: +r.cost.toFixed(3),
  componentsTotal: +total(r.components).toFixed(3),
  hikeABikeM: +r.hikeABikeM.toFixed(3),
  ferryM: +r.ferryM.toFixed(3),
  ascentM: r.ascentM === null ? null : Math.round(r.ascentM),
  descentM: r.descentM === null ? null : Math.round(r.descentM),
  uncertainM: +r.uncertainM.toFixed(3),
  edges: r.edgeIds.length,
  edgeIds: digest(r.edgeIds),
  // Rounded to ~1 cm before hashing, so the digest is stable against float noise.
  geometry: digest(r.geometry.map(([x, y]) => [+x.toFixed(7), +y.toFixed(7)])),
  segments: r.segments.length,
  surfaces: Object.fromEntries(
    Object.entries(r.surfaceM).map(([k, v]) => [k, +v.toFixed(3)]),
  ),
});

const rows: Record<string, ReturnType<typeof snapshot>> = {};
for (const scenario of scenarios) {
  const graph = await loadReleaseGraph(packs, scenario.anchors);
  for (const id of SHIPPED_IDS) {
    const profile = await loadProfile(id);
    const result = route(graph, { anchors: scenario.anchors, profile }, "reference");
    if (result.status !== "ok")
      console.warn(`${scenario.name}/${id}: ${result.status}`);
    rows[`${scenario.name}/${id}`] = snapshot(result);
  }
  console.log(`${scenario.name}: ${SHIPPED_IDS.length} profiles`);
}

if (!check) {
  await fs.mkdir("data/derived", { recursive: true });
  await fs.writeFile(OUT, JSON.stringify({ packs, rows }, null, 2) + "\n");
  console.log(`\nWrote ${Object.keys(rows).length} routes to ${OUT}`);
} else {
  const before = JSON.parse(await fs.readFile(OUT, "utf8")).rows as typeof rows;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(rows)])].sort();
  const differences: string[] = [];
  for (const key of keys) {
    const a = JSON.stringify(before[key]);
    const b = JSON.stringify(rows[key]);
    if (a !== b) differences.push(`${key}\n  before ${a}\n  after  ${b}`);
  }
  if (differences.length) {
    console.error(`\n${differences.length} of ${keys.length} routes changed:\n`);
    for (const d of differences) console.error(d);
    process.exitCode = 1;
  } else {
    console.log(`\nIdentical: ${keys.length} routes unchanged.`);
  }
}
