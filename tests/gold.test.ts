import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { route } from "../src/routing/engine";
import {
  loadGold,
  loadGoldGraph,
  goldPath,
  overlap,
  pickWaypoints,
} from "../scripts/gold_route";
import { loadProfile } from "./helpers";

/**
 * Real lines judged the best through their area, each routed from only the waypoints
 * that say where the rider wanted to go. The router must already ride `min_shared` of
 * the line; raise it as the model improves. `scripts/gold_route.ts audit <name>` explains
 * every place where it still parts from the line.
 */
const cases = readdirSync(new URL("./fixtures/gold/", import.meta.url))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length));

describe.each(cases)("gold standard %s", (name) => {
  const gold = loadGold(goldPath(name));
  const graph = loadGoldGraph(name);
  const profile = loadProfile(gold.profile);
  const ride = (pick: string) => {
    const result = route(
      graph,
      {
        profile,
        anchors: pickWaypoints(gold, pick).map((i) => gold.waypoints[i]),
      },
      "reference",
    );
    expect(result.status).toBe("ok");
    const o = overlap(result.geometry, gold.line);
    return o.sharedM / o.goldM;
  };

  it("is reproduced through all of its waypoints", () => {
    // Otherwise the fixture no longer matches the release the line was drawn on, and the
    // ratchet below would measure the data rather than the model.
    expect(ride("all")).toBeGreaterThan(0.99);
  });

  it("is ridden from its intent alone", () => {
    expect(ride("intent")).toBeGreaterThanOrEqual(gold.min_shared);
  });
});
