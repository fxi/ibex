import { describe, expect, it } from "vitest";
import {
  catalogueSchema,
  cellById,
  coverageBBox,
  resolveCellManifest,
  selectedBytes,
  type Catalogue,
} from "../src/offline/catalogue";
import { cellBBox, cellId } from "../src/geo/grid";
import { COST_MODEL_VERSION } from "../src/routing/types";
import fixture from "../public/packs/grid-fixture/catalogue.json";

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
  schemaVersion: 1,
  release: "g4-2026w36-p5-1a2b3c4d",
  grid: { scheme: "xyz", zoom: 9, blockZoom: 13, fieldZoom: 15 },
  costModelVersion: COST_MODEL_VERSION,
  formatVersion: 1,
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
  it("rejects an unknown schema version", () => {
    expect(() =>
      catalogueSchema.parse({ ...base(), schemaVersion: 99 }),
    ).toThrow();
  });
  it("rejects a stale cost model", () => {
    expect(() =>
      catalogueSchema.parse({ ...base(), costModelVersion: 1 }),
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
        "http://localhost:5173/cyclatractor/packs/geneva-grid/catalogue.json",
        catalogue.cells[0],
      ),
    ).toBe(
      "http://localhost:5173/cyclatractor/packs/geneva-grid/9-264-181/manifest.json",
    );
  });
  it("resolves against an S3 prefix without changing the layout", () => {
    expect(
      resolveCellManifest(
        "https://bucket.example.com/cyclatractor/packs/g4-2026w36/catalogue.json",
        catalogue.cells[1],
      ),
    ).toBe(
      "https://bucket.example.com/cyclatractor/packs/g4-2026w36/9-265-181/manifest.json",
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
