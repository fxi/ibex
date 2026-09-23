/**
 * Memory of one routed leg on a local build, as the route worker spends it.
 *
 * Phones kill a tab that grows too large rather than throwing, so a leg that routes on a
 * desktop can take the whole page down on an iPhone. This reports what a leg costs: the
 * leg graph (heap and array buffers after load, collected) and the peak of the process while routing.
 * Each leg runs in its own process so one leg's peak cannot hide in another's.
 *
 * node --import tsx scripts/memory_leg.ts [cells dir] [leg name]
 */
import { spawnSync } from "node:child_process";
import { compareOn } from "../src/routing/legs";
import { searchArea } from "../src/routing/provider";
import { distance } from "../src/geo/distance";
import { DEFAULT_CELLS, openLocalProvider } from "./local_cells";
import { loadProfile } from "./profile";
import type { Point } from "../src/routing/types";

// Geneva outward along the lake towards Fribourg, so one build covers every length.
const geneva: Point = [6.151, 46.201];
const legs: Record<string, [Point, Point]> = {
  rolle: [geneva, [6.338, 46.458]],
  lausanne: [geneva, [6.633, 46.52]],
  moudon: [geneva, [6.797, 46.668]],
  fribourg: [geneva, [7.161, 46.803]],
};

const dir = process.argv[2] ?? DEFAULT_CELLS;
const name = process.argv[3];
const mb = (bytes: number) => Math.round(bytes / 1e6);

if (!name) {
  for (const leg of Object.keys(legs)) {
    const run = spawnSync(
      process.execPath,
      ["--expose-gc", "--import", "tsx", "scripts/memory_leg.ts", dir, leg],
      { encoding: "utf8" },
    );
    process.stdout.write(run.stdout || run.stderr);
  }
} else {
  // Typed arrays live outside the JS heap, so both count.
  const collect = () => {
    globalThis.gc?.();
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  };
  const [from, to] = legs[name];
  const provider = await openLocalProvider(dir);
  const profile = await loadProfile("gravel_50");
  const base = collect();
  let graph = await provider.loadLeg(searchArea([from, to]));
  const edges = graph.from.length,
    nodes = graph.nodeId.length;
  const loaded = collect();
  const started = performance.now();
  const value = compareOn(
    graph,
    { anchors: [from, to], profile },
    provider.envelope()!,
  );
  const ms = performance.now() - started;
  graph = undefined!;
  const r = value.reference;
  console.log(
    JSON.stringify({
      leg: name,
      km: Math.round(distance(from, to) / 1000),
      edges,
      nodes,
      graphMB: mb(loaded - base),
      peakRssMB: Math.round(process.resourceUsage().maxRSS / 1000),
      status: r.status,
      routeKm: Math.round(r.distanceM / 1000),
      explored: r.metrics.explored,
      prepared: r.metrics.preparedStates,
      ms: Math.round(ms),
    }),
  );
}
