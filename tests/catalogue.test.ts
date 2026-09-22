import { afterEach, describe, expect, it, vi } from "vitest";
import {
  catalogueSchema,
  catalogueURL,
  cellFileURL,
  readCatalogue,
  cellById,
  coverageBBox,
  selectedBytes,
  type Catalogue,
} from "../src/offline/catalogue";
import { cellBBox, cellId } from "../src/geo/grid";
import fixture from "./fixtures/grid-fixture/catalog.json";

const cell = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id: cellId({ zoom: 9, x, y }),
  x,
  y,
  bbox: cellBBox({ zoom: 9, x, y }).map((v) => Number(v.toFixed(7))),
  hash: "abc1230000000000",
  builtAt: "2026-09-10T00:00:00.000Z",
  osm: "2026-09-09T21:00:00Z",
  bytes: 4096,
  blocks: 7,
  terrainCoverage: 1,
  files: [
    { path: "index.ibx", bytes: 96, sha256: "a".repeat(64) },
    { path: "graph.ibx", bytes: 4000, sha256: "b".repeat(64) },
  ],
  ...extra,
});
const base = () => ({
  dataVersion: 1,
  grid: { scheme: "xyz", zoom: 9, blockZoom: 13, fieldZoom: 15 },
  generated: "2026-09-10T00:00:00.000Z",
  attribution: "© OpenStreetMap contributors",
  cells: [cell(264, 181), cell(265, 181)],
});

describe("catalogue schema", () => {
  it("accepts the checked-in development fixture", () => {
    const parsed = catalogueSchema.parse(fixture);
    expect(parsed.cells.map((c) => c.id)).toEqual(["9-264-181", "9-265-181"]);
    expect(parsed.grid).toEqual({
      scheme: "xyz",
      zoom: 9,
      blockZoom: 13,
      fieldZoom: 15,
    });
  });
  it("accepts a well-formed catalogue", () => {
    expect(catalogueSchema.parse(base()).cells).toHaveLength(2);
  });
  it("rejects another data version", () => {
    expect(() =>
      catalogueSchema.parse({ ...base(), dataVersion: 99 }),
    ).toThrow();
  });
  it("rejects a cell id that does not match its grid coordinates", () => {
    const value = base();
    value.cells[0].id = "9-999-181";
    expect(() => catalogueSchema.parse(value)).toThrow(
      /does not match grid coordinates/,
    );
  });
  it("rejects a cell whose bbox does not match its grid position", () => {
    const value = base();
    value.cells[0].bbox = [0, 0, 1, 1];
    expect(() => catalogueSchema.parse(value)).toThrow(
      /bbox does not match its grid position/,
    );
  });
  it("rejects duplicate cells", () => {
    const value = base();
    value.cells = [cell(264, 181), cell(264, 181)];
    expect(() => catalogueSchema.parse(value)).toThrow(/Duplicate cell/);
  });
  it("rejects blocks or fields coarser than the download cell", () => {
    expect(() =>
      catalogueSchema.parse({
        ...base(),
        grid: { scheme: "xyz", zoom: 9, blockZoom: 8, fieldZoom: 15 },
      }),
    ).toThrow(/Graph blocks must be finer/);
    expect(() =>
      catalogueSchema.parse({
        ...base(),
        grid: { scheme: "xyz", zoom: 9, blockZoom: 13, fieldZoom: 8 },
      }),
    ).toThrow(/Cost field must be finer/);
  });
  it("rejects a hash that is not a hash", () => {
    for (const hash of ["", "../secrets", "ZZZZ", "g".repeat(16)]) {
      const value = base();
      value.cells[0].hash = hash;
      expect(() => catalogueSchema.parse(value)).toThrow();
    }
  });
  it("rejects an implausible cell size", () => {
    const value = base();
    value.cells[0].bytes = 1e12;
    expect(() => catalogueSchema.parse(value)).toThrow();
  });
  it("accepts a catalogue with nothing built yet", () => {
    // The grid covers the world from the first run; the catalogue starts empty.
    expect(catalogueSchema.parse({ ...base(), cells: [] }).cells).toEqual([]);
  });
});

describe("cell file URLs", () => {
  const catalogue = catalogueSchema.parse(base());
  it("is looked up beside the data root", () => {
    expect(catalogueURL("https://host.example/ibex/data/")).toBe(
      "https://host.example/ibex/data/catalog.json",
    );
  });
  it("names a file after the cell's hash, so it never changes", () => {
    expect(
      cellFileURL(
        "http://localhost:5173/ibex/data/catalog.json",
        catalogue.cells[0],
        "graph.ibx",
      ),
    ).toBe(
      "http://localhost:5173/ibex/data/cells/9-264-181/abc1230000000000.graph.ibx",
    );
  });
  it("resolves against a bucket prefix without changing the layout", () => {
    expect(
      cellFileURL(
        "https://bucket.example.com/ibex/catalog.json",
        catalogue.cells[1],
        "index.ibx",
      ),
    ).toBe(
      "https://bucket.example.com/ibex/cells/9-265-181/abc1230000000000.index.ibx",
    );
  });
  it("refuses a cell id that would climb out of the tree", () => {
    for (const id of ["../other", "//evil.example/x"])
      expect(() =>
        cellFileURL("https://bucket.example.com/data/catalog.json", { id, hash: "a1b2" }, "graph.ibx"),
      ).toThrow(/outside the catalogue directory/);
  });
});

describe("catalogue helpers", () => {
  const catalogue: Catalogue = catalogueSchema.parse(base());
  it("indexes cells by id", () => {
    expect([...cellById(catalogue).keys()]).toEqual(["9-264-181", "9-265-181"]);
  });
  it("unions coverage across cells", () => {
    const bbox = coverageBBox(catalogue);
    expect(bbox[0]).toBeCloseTo(5.625, 6);
    expect(bbox[2]).toBeCloseTo(7.03125, 6);
    expect(bbox[1]).toBeLessThan(bbox[3]);
  });
  it("totals only the selected cells and ignores unknown ids", () => {
    expect(selectedBytes(catalogue, [])).toBe(0);
    expect(selectedBytes(catalogue, ["9-264-181"])).toBe(4096);
    expect(selectedBytes(catalogue, ["9-264-181", "9-265-181"])).toBe(8192);
    expect(selectedBytes(catalogue, ["9-999-999"])).toBe(0);
  });
});

describe("reading the catalogue", () => {
  const serve = (routes: Record<string, unknown>) =>
    vi.stubGlobal("fetch", async (url: string) =>
      url in routes
        ? new Response(JSON.stringify(routes[url]))
        : new Response("", { status: 404 }),
    );
  afterEach(() => vi.unstubAllGlobals());

  it("fetches it from the data root", async () => {
    const at = "https://host.example/ibex/data/catalog.json";
    serve({ [at]: base() });
    const { url, catalogue } = await readCatalogue(at);
    expect(url).toBe(at);
    expect(catalogue.cells.map((c) => c.id)).toEqual(["9-264-181", "9-265-181"]);
  });
  it("rejects a catalogue from another data version", async () => {
    const at = "https://host.example/ibex/data/catalog.json";
    serve({ [at]: { ...base(), dataVersion: 2 } });
    await expect(readCatalogue(at)).rejects.toThrow(/another version/);
  });
  it("reports a catalogue that is not there", async () => {
    serve({});
    await expect(
      readCatalogue("https://host.example/ibex/data/catalog.json"),
    ).rejects.toThrow(/unavailable/);
  });
});
