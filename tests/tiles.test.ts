import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { PMTiles } from "pmtiles";
import type { MapInstalled } from "../src/offline/store";
import { parseMapIndex, type MapPackEntry } from "../src/map/resources";

/**
 * Where each map request is answered from: the map pack of the cell under the tile, the
 * world pack far out, the bucket for the rest. Run on the fixture's real archives, read by
 * range from the files `scripts/create_cell_fixture.ts` publishes.
 */
const DATA = "tests/fixtures/data";
const index = JSON.parse(readFileSync(`${DATA}/map.json`, "utf8")) as {
  world: MapPackEntry;
  cells: Record<string, MapPackEntry>;
};
const CELL = Object.keys(index.cells)[0];
const fileOf = new Map<string, Uint8Array>();
const installed = (id: string, entry: MapPackEntry): MapInstalled => {
  for (const f of entry.files)
    fileOf.set(`map-${id}/${f.path}`, new Uint8Array(readFileSync(`${DATA}/${f.url}`)));
  return {
    manifest: {
      kind: "map",
      id,
      hash: entry.hash,
      files: entry.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    },
    installedAt: "",
    directory: `map-${id}`,
    backend: "opfs",
  };
};

vi.mock("../src/offline/store", () => ({
  MAP_FILES: ["basemap.pmtiles", "routes.pmtiles", "terrain.pmtiles", "assets.json"],
  preference: async () => undefined,
  savePreference: async () => {},
  readFile: async (pack: MapInstalled, path: string) =>
    fileOf.get(`${pack.directory}/${path}`)!.slice().buffer,
  readRange: async (pack: MapInstalled, path: string, offset: number, length: number) =>
    fileOf.get(`${pack.directory}/${path}`)!.slice(offset, offset + length).buffer,
}));

const tiles = await import("../src/map/tiles");
const cellPack = installed(CELL, index.cells[CELL]);
const worldPack = installed("world", index.world);
const [, cx, cy] = CELL.split("-").map(Number);
const text = (data: ArrayBuffer | undefined) => new TextDecoder().decode(data);

/** The fixture road's own tile at z14, from the pack's header. */
const header = await new PMTiles({
  getKey: () => "cell",
  getBytes: async (offset: number, length: number) => ({
    data: fileOf.get(`map-${CELL}/basemap.pmtiles`)!.slice(offset, offset + length).buffer,
  }),
}).getHeader();
const n = 2 ** 14;
const z14 = {
  x: Math.floor(((header.centerLon + 180) / 360) * n),
  y: Math.floor(
    ((1 - Math.asinh(Math.tan((header.centerLat * Math.PI) / 180)) / Math.PI) / 2) * n,
  ),
};

beforeEach(() => {
  tiles.setRemote(undefined);
  tiles.setPacks([cellPack, worldPack]);
});

it("answers from the cell's pack at z9 and deeper, and from any pack under it at z7–8", async () => {
  expect(z14.x >> 5).toBe(cx);
  expect(text(await tiles.tile("basemap", 14, z14.x, z14.y))).toContain("pack");
  expect(text(await tiles.tile("routes", 14, z14.x, z14.y))).toContain("pack");
  expect(text(await tiles.tile("basemap", 8, cx >> 1, cy >> 1))).toContain("pack");
  expect(tiles.localArchive("basemap", 8, cx >> 1, cy >> 1)).toBeDefined();
  expect(tiles.localArchive("basemap", 9, cx + 1, cy)).toBeUndefined();
});

it("answers far out from the world pack, which has no cycle routes", async () => {
  expect(text(await tiles.tile("basemap", 4, cx >> 5, cy >> 5))).toContain("pack");
  expect(tiles.localArchive("routes", 4, cx >> 5, cy >> 5)).toBeUndefined();
});

it("treats a covered tile the pack lacks as empty, and an uncovered one offline as unavailable", async () => {
  // Same cell, but a corner the fixture road never reaches.
  expect(await tiles.tile("basemap", 14, cx << 5, cy << 5)).toBeUndefined();
  await expect(tiles.tile("basemap", 12, (cx + 1) << 3, cy << 3)).rejects.toThrow(
    tiles.TileUnavailable,
  );
  const answer = await tiles.protocol(
    { url: `ibex://routes/12/${(cx + 1) << 3}/${cy << 3}` },
    new AbortController(),
  ).catch((e: Error) => e);
  expect(answer).toBeInstanceOf(tiles.TileUnavailable);
});

it("falls back to the bucket's archive where no pack is installed", async () => {
  tiles.setPacks([]);
  const online = readFileSync(`${DATA}/map/basemap.pmtiles`);
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    fetched.push(url);
    const range = new Headers(init?.headers).get("range")!.match(/bytes=(\d+)-(\d+)/)!;
    const body = online.subarray(+range[1], +range[2] + 1);
    return new Response(body, {
      status: 206,
      headers: { "content-length": String(body.length) },
    });
  });
  try {
    tiles.setRemote(parseMapIndex(index, "https://bucket.example/ibex/"));
    const data = await tiles.tile("basemap", 14, z14.x, z14.y);
    expect(text(data)).toContain("minor_road");
    expect(text(data)).not.toContain("pack");
    expect(fetched[0]).toBe("https://bucket.example/ibex/map/basemap.pmtiles");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("serves fonts and sprite from the world pack, and an empty glyph range for any it lacks", async () => {
  const controller = new AbortController();
  const sprite = await tiles.protocol({ url: "ibex://sprite/light@2x.json" }, controller);
  expect(sprite.data).toEqual({});
  const png = (await tiles.protocol({ url: "ibex://sprite/light.png" }, controller))
    .data as ArrayBuffer;
  expect(new Uint8Array(png).slice(1, 4)).toEqual(new TextEncoder().encode("PNG"));
  const missing = await tiles.protocol(
    { url: "ibex://glyphs/Noto%20Sans%20Italic/1024-1279.pbf" },
    controller,
  );
  expect((missing.data as ArrayBuffer).byteLength).toBe(0);
  await expect(
    tiles.protocol({ url: "ibex://glyphs/Noto%20Sans%20Regular/0-255.pbf" }, controller),
  ).resolves.toBeDefined();
});
