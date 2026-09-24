/**
 * Traffic stress from speed, lanes and lorries, not road class alone.
 *
 * Each case is a road a rider would recognise, with the level `trafficLevel` should show
 * for it: 0 quiet, 1 some traffic, 2 busy, 3 very busy.
 */
import { describe, expect, it } from "vitest";
import { riddenStress, roadSpeed, roadStress } from "../src/build/stress";
import { trafficLevel } from "../src/map/routeStats";
import { ENGINE } from "../src/routing/vocabulary";
import type { OsmTags } from "../src/build/osm/pbf";

const RURAL = { urban: 0, country: "FR" };
const TOWN = { urban: 1, country: "FR" };

function level(
  highway: string,
  tags: OsmTags,
  ctx: { urban: number; country?: string } = RURAL,
  signed = false,
) {
  const s = roadStress(highway, tags, ctx);
  return trafficLevel(riddenStress(s, signed ? ENGINE.network_calming : undefined));
}

describe("roadSpeed", () => {
  it("reads a tagged limit, in km/h or mph", () => {
    expect(roadSpeed("secondary", { maxspeed: "70" }, RURAL)).toEqual({ kmh: 70, source: "tagged" });
    expect(roadSpeed("secondary", { maxspeed: "40 mph" }, RURAL)?.kmh).toBe(64);
  });

  it("reads an implicit limit from the country's table or the zone's digits", () => {
    expect(roadSpeed("tertiary", { maxspeed: "FR:urban" }, RURAL)).toEqual({ kmh: 50, source: "zone" });
    expect(roadSpeed("residential", { "zone:maxspeed": "DE:30" }, TOWN)?.kmh).toBe(30);
    expect(roadSpeed("residential", { "maxspeed:type": "DE:zone30" }, TOWN)?.kmh).toBe(30);
    expect(roadSpeed("tertiary", { "source:maxspeed": "CH:rural" }, TOWN)?.kmh).toBe(80);
  });

  it("falls back to the legal default for the country and setting", () => {
    expect(roadSpeed("tertiary", {}, RURAL)).toEqual({ kmh: 80, source: "legal" });
    expect(roadSpeed("tertiary", {}, TOWN)).toEqual({ kmh: 50, source: "legal" });
    expect(roadSpeed("secondary", {}, { urban: 0, country: "DE" })?.kmh).toBe(100);
    expect(roadSpeed("primary", { dual_carriageway: "yes" }, RURAL)?.kmh).toBe(110);
    // Nowhere known: the commonest European rural default.
    expect(roadSpeed("secondary", {}, { urban: 0 })?.kmh).toBe(80);
  });

  it("has no speed for a way cars do not use", () => {
    expect(roadSpeed("cycleway", {}, RURAL)).toBeUndefined();
    expect(roadSpeed("track", { maxspeed: "30" }, RURAL)).toBeUndefined();
  });
});

describe("roadStress", () => {
  it("never reads a trunk open to bikes as quiet", () => {
    expect(level("trunk", { bicycle: "yes" })).toBe(3);
    expect(level("trunk", { bicycle: "yes" }, RURAL, true)).toBe(3);
  });

  it("does not let a signed route calm a fast main road", () => {
    // A signed secondary at 90: the case the class-only model read as quiet.
    expect(level("secondary", { maxspeed: "90" }, RURAL, true)).toBe(3);
    expect(level("secondary", {}, RURAL, true)).toBe(2);
    expect(level("primary", {}, RURAL, true)).toBe(2);
  });

  it("still calms a main road through town on a signed route", () => {
    expect(level("secondary", {}, TOWN)).toBe(2);
    expect(level("secondary", {}, TOWN, true)).toBe(0);
  });

  it("reads a rural tertiary as some traffic on a guess, busy only when signed fast", () => {
    // The quiet departmental road riders choose: not charged as a hazard on a legal default.
    const guessed = riddenStress(roadStress("tertiary", {}, RURAL), undefined);
    expect(trafficLevel(guessed)).toBe(1);
    expect(guessed - ENGINE.traffic_from).toBeLessThan(0.1);
    expect(level("tertiary", {}, RURAL, true)).toBe(1);
    expect(level("tertiary", { maxspeed: "90" })).toBe(2);
    expect(level("tertiary", {}, TOWN)).toBe(0);
  });

  it("leaves minor roads to their class whatever the sign says", () => {
    expect(level("unclassified", { maxspeed: "80" })).toBe(0);
    expect(level("residential", {}, RURAL)).toBe(0);
  });

  it("reads two lanes each way as very busy", () => {
    expect(level("secondary", { lanes: "4" }, TOWN, true)).toBe(3);
    expect(level("primary", { lanes: "2", oneway: "yes" }, TOWN, true)).toBe(3);
  });

  it("reads a designated lorry route as at least busy", () => {
    expect(level("tertiary", { hgv: "designated" }, TOWN, true)).toBe(2);
  });

  it("calms town speeds and credits paint only there", () => {
    const at = (tags: OsmTags) => riddenStress(roadStress("secondary", tags, TOWN), undefined);
    expect(at({ maxspeed: "30" })).toBeLessThan(at({}));
    expect(at({ cycleway: "lane" })).toBeLessThan(at({}));
    const rural = (tags: OsmTags) => riddenStress(roadStress("secondary", tags, RURAL), undefined);
    expect(rural({ cycleway: "lane" })).toBe(rural({}));
  });

  it("takes a separated track out of the traffic, floor and all", () => {
    expect(level("primary", { cycleway: "track", maxspeed: "90" })).toBe(0);
  });
});
