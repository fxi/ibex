import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  loadGold,
  loadGoldGraph,
  goldPath,
  onGraph,
  overlap,
  pickWaypoints,
  routeAsApp,
} from "../scripts/gold_route";
import { loadProfile } from "./helpers";

/**
 * Real lines judged the best through their area, each routed as the app routes it from
 * only the waypoints that say where the rider wanted to go, exploring every leg. The
 * router must already ride `min_shared` of the line; raise it as the model improves.
 * `scripts/gold_route.ts audit <name>` explains every place it still parts from the line.
 */
const cases = readdirSync(new URL("./fixtures/gold/", import.meta.url))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length));

describe.each(cases)("gold standard %s", (name) => {
  const gold = loadGold(goldPath(name));
  const graph = loadGoldGraph(name);
  const profile = loadProfile(gold.profile);
  const ride = (pick: string) => {
    const result = routeAsApp(
      graph,
      profile,
      pickWaypoints(gold, pick).map((i) => gold.waypoints[i]),
    );
    expect(result.status).toBe("ok");
    const o = overlap(result.geometry, gold.line);
    return o.sharedM / o.goldM;
  };

  it("still lies on the graph it was drawn on", () => {
    // Otherwise the fixture no longer matches the data the line was drawn on, and the
    // ratchet below would measure the data rather than the model. Waypoint splits are the
    // only spans a drawn line may add.
    expect(onGraph(graph, gold.line)).toBeGreaterThan(0.99);
  });

  it("is ridden from its intent alone", () => {
    expect(ride("intent")).toBeGreaterThanOrEqual(gold.min_shared);
  });
});
