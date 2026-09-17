import { afterEach, describe, expect, it, vi } from "vitest";
import {
  catalogueSchema,
  pointerSchema,
  pointerURL,
  readCatalogue,
  cellById,
  coverageBBox,
  resolveCellManifest,
  selectedBytes,
  type Catalogue,
} from "../src/offline/catalogue";
import { cellBBox, cellId } from "../src/geo/grid";
import fixture from "./fixtures/grid-fixture/catalogue.json";

const cell = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id: cellId({ zoom: 9, x, y }),
  x,
  y,
  bbox: cellBBox({ zoom: 9, x, y }).map((v) => Number(v.toFixed(7))),
  manifest: `${cellId({ zoom: 9, x, y })}/manifest.json`,
  version: "abc123",
  bytes: 4096,
  available: true,
  ...extra,
});
const base = () => ({
  dataVersion: 1,
  release: "20260910-1a2b3c4d",
  grid: { scheme: "xyz", zoom: 9, blockZoom: 13, fieldZoom: 15 },
  osmTimestamp: "2026-07-15T15:22:01Z",
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
  it("rejects a manifest path that escapes the catalogue", () => {
    for (const manifest of [
      "../secrets/manifest.json",
      "a/../../manifest.json",
      "/absolute/manifest.json",
      "https://other.example/manifest.json",
    ]) {
      const value = base();
      value.cells[0].manifest = manifest;
      expect(() => catalogueSchema.parse(value)).toThrow();
    }
  });
  it("rejects an implausible cell size", () => {
    const value = base();
    value.cells[0].bytes = 1e12;
    expect(() => catalogueSchema.parse(value)).toThrow();
  });
  it("requires at least one cell", () => {
    expect(() => catalogueSchema.parse({ ...base(), cells: [] })).toThrow();
  });
});

describe("manifest URL resolution", () => {
  const catalogue = catalogueSchema.parse(base());
  it("resolves against a local development path", () => {
    expect(
      resolveCellManifest(
        "http://localhost:5173/ibex/data/v1/releases/20260910-1a2b3c4d/catalogue.json",
        catalogue.cells[0],
      ),
    ).toBe(
      "http://localhost:5173/ibex/data/v1/releases/20260910-1a2b3c4d/9-264-181/manifest.json",
    );
  });
  it("resolves against an S3 prefix without changing the layout", () => {
    expect(
      resolveCellManifest(
        "https://bucket.example.com/ibex/data/v1/releases/20260910-1a2b3c4d/catalogue.json",
        catalogue.cells[1],
      ),
    ).toBe(
      "https://bucket.example.com/ibex/data/v1/releases/20260910-1a2b3c4d/9-265-181/manifest.json",
    );
  });
  it("refuses a path that resolves outside the catalogue directory", () => {
    for (const manifest of ["../other/manifest.json", "//evil.example/x.json"])
      expect(() =>
        resolveCellManifest(
          "https://bucket.example.com/packs/release/catalogue.json",
          { manifest },
        ),
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

describe("release pointer", () => {
  const pointer = {
    dataVersion: 1,
    release: "20260910-1a2b3c4d",
    catalogue: "releases/20260910-1a2b3c4d/catalogue.json",
    published: "2026-09-10T00:00:00.000Z",
  };
  const serve = (routes: Record<string, unknown>) =>
    vi.stubGlobal("fetch", async (url: string) =>
      url in routes
        ? new Response(JSON.stringify(routes[url]))
        : new Response("", { status: 404 }),
    );
  afterEach(() => vi.unstubAllGlobals());

  it("is looked up under this build's data version", () => {
    expect(pointerURL("https://host.example/ibex/data/")).toBe(
      "https://host.example/ibex/data/v1/latest.json",
    );
  });
  it("refuses a catalogue path that escapes the data tree", () => {
    expect(
      pointerSchema.safeParse({ ...pointer, catalogue: "../v2/catalogue.json" })
        .success,
    ).toBe(false);
  });
  it("resolves the catalogue relative to the pointer", async () => {
    const at = "https://host.example/ibex/data/v1/latest.json";
    serve({
      [at]: pointer,
      "https://host.example/ibex/data/v1/releases/20260910-1a2b3c4d/catalogue.json":
        base(),
    });
    const { url, catalogue } = await readCatalogue(at);
    expect(url).toBe(
      "https://host.example/ibex/data/v1/releases/20260910-1a2b3c4d/catalogue.json",
    );
    expect(catalogue.release).toBe(pointer.release);
  });
  it("rejects a pointer from another data version or a mismatched catalogue", async () => {
    const at = "https://host.example/ibex/data/v1/latest.json";
    serve({ [at]: { ...pointer, dataVersion: 2 } });
    await expect(readCatalogue(at)).rejects.toThrow(/another version/);
    serve({
      [at]: { ...pointer, release: "20260911-ffffffff" },
      "https://host.example/ibex/data/v1/releases/20260910-1a2b3c4d/catalogue.json":
        base(),
    });
    await expect(readCatalogue(at)).rejects.toThrow(/disagree/);
  });
});
