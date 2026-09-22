/**
 * Which downloads a cell is built from.
 *
 * The cases here are the ones that have gone wrong: a special cross-border extract chosen
 * instead of a country, a country rejected because its ISO code is published as an array,
 * and a cell on a border served by only one of its two sides — which is how a Geneva cell
 * was once published with no Geneva in it.
 */
import { describe, expect, test } from "vitest";
import { extractAt, extractsFor, extractKey, readExtractIndex } from "../src/build/osm/extracts";

const box = (west: number, south: number, east: number, north: number) => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];

const feature = (
  id: string,
  ring: number[][],
  properties: Record<string, unknown> = {},
) => ({
  type: "Feature",
  properties: { id, name: id, urls: { pbf: `https://example.test/${id}.osm.pbf` }, ...properties },
  geometry: { type: "Polygon", coordinates: [ring] },
});

/** A continent, two countries that touch, a sub-region of one, and a special that spans. */
const index = readExtractIndex({
  features: [
    feature("europe", box(0, 0, 40, 40)),
    // Buffered past the border, as Geofabrik publishes them.
    feature("westland", box(0, 0, 21, 20), { parent: "europe", "iso3166-1:alpha2": ["WL"] }),
    feature("eastland", box(19, 0, 40, 20), { parent: "europe", "iso3166-1:alpha2": ["EL"] }),
    feature("west-north", box(0, 10, 21, 20), { parent: "westland" }),
    feature("west-south", box(0, 0, 21, 10), { parent: "westland" }),
    feature("the-range", box(15, 5, 25, 15), { parent: "europe" }),
  ],
});

describe("extract index", () => {
  test("reads every extract with a download and a polygon", () => {
    expect(index.map((e) => e.id).sort()).toEqual([
      "eastland",
      "europe",
      "the-range",
      "west-north",
      "west-south",
      "westland",
    ]);
  });

  test("a continent and a country with children are never chosen", () => {
    expect(index.find((e) => e.id === "europe")!.usable).toBe(false);
    expect(index.find((e) => e.id === "westland")!.usable).toBe(false);
    expect(index.find((e) => e.id === "west-north")!.usable).toBe(true);
  });

  test("a country keeps its ISO code when it is published as an array", () => {
    // Switzerland reads `["CH"]`. Treating that as absent made it look like a special
    // extract, and the Geneva cell was then built from France alone.
    expect(index.find((e) => e.id === "eastland")!.iso).toBe(true);
    expect(index.find((e) => e.id === "eastland")!.usable).toBe(true);
  });

  test("a cross-border special is not a download", () => {
    expect(index.find((e) => e.id === "the-range")!.usable).toBe(false);
    expect(extractAt(index, 20, 10)?.id).not.toBe("the-range");
  });

  test("a cell on a border reads both sides", () => {
    const got = extractsFor(index, [18, 12, 22, 16], 4);
    expect(extractKey(got)).toBe("eastland+west-north");
  });

  test("a cell well inside one country reads only it", () => {
    expect(extractKey(extractsFor(index, [4, 12, 6, 14], 4))).toBe("west-north");
  });

  test("a cell with no coverage reads nothing", () => {
    expect(extractsFor(index, [60, 60, 61, 61], 4)).toEqual([]);
  });

  test("an extract whose outline merely crosses the cell is still read", () => {
    // Nothing samples inside `eastland` here, but the border runs through the box.
    const got = extractsFor(index, [20.5, 12, 21.5, 13], 2);
    expect(got.map((e) => e.id)).toContain("eastland");
  });

  test("rejects a document that is not an index", () => {
    expect(() => readExtractIndex({ nope: true })).toThrow(/no features/);
    expect(() => readExtractIndex({ features: [] })).toThrow(/no usable extracts/);
  });
});
