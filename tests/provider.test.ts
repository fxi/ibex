import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import {
  CellGraphProvider,
  searchArea,
  type PackReader,
} from "../src/routing/provider";
import { encodeBlock, stringTable } from "../src/offline/ibex/block";
import { encodeIndex } from "../src/offline/ibex/index";
import { crc32 } from "../src/offline/ibex/varint";
import { releaseTag, type BlockRef } from "../src/offline/ibex/spec";
import { cellBBox, parseCellId, tileOf } from "../src/geo/grid";
import { route, buildField } from "../src/routing/engine";
import { resolveProfile } from "../src/routing/profiles";
import type { Installed } from "../src/offline/store";
import type { Edge, Node, Point, Restriction } from "../src/routing/types";

const RELEASE = "g4-20260909-p5-abcdef12";
/** The meridian these two zoom-9 cells share, which the test road crosses. */
const BOUNDARY = cellBBox({ zoom: 9, x: 264, y: 181 })[2];

/**
 * A straight road along one latitude, split at each node, crossing the cell boundary.
 * Ownership follows the pipeline's rule: the cell containing an edge's first point.
 */
const LAT = 46.2;
const LONS = [
  BOUNDARY - 0.03,
  BOUNDARY - 0.01,
  BOUNDARY + 0.01,
  BOUNDARY + 0.03,
];
const nodes: Node[] = LONS.map((lon, i) => ({
  id: 1000 + i,
  p: [lon, LAT],
  elevation: 400 + i * 10,
}));

function edge(index: number, reverse = false): Edge {
  const from = nodes[reverse ? index + 1 : index];
  const to = nodes[reverse ? index : index + 1];
  return {
    id: (500 * 4096 + index) * 2 + (reverse ? 1 : 0),
    from: from.id,
    to: to.id,
    way: "500",
    length: 1550,
    geometry: [from.p, to.p],
    grades: [[1550, reverse ? -0.01 : 0.01]],
    surface: "asphalt",
    highway: "cycleway",
    tags: {},
    stress: 0.1,
    uncertainty: 0.1,
    utility: 0.7,
    urban: 0.2,
    cyclingNetwork: 1,
    quality: 0.8,
    forest: 0,
    reward: 0,
    junction: 0,
    bridge: false,
    tunnel: false,
    name: "Test Road",
    tile: "",
  };
}

const restriction: Restriction = {
  ways: ["500"],
  via: nodes[2].id,
  only: false,
  uTurn: true,
};

type Built = { pack: Installed; index: Uint8Array; graph: Uint8Array };

function buildCell(
  id: string,
  edges: Edge[],
  options: { release?: string; corruptBlock?: boolean } = {},
): Built {
  const cell = parseCellId(id);
  const release = options.release ?? RELEASE;
  const tag = releaseTag(release);
  const strings = stringTable();
  const grouped = new Map<string, Edge[]>();
  for (const e of edges) {
    const tile = tileOf(e.geometry[0], 13);
    const key = `${tile.x}/${tile.y}`;
    (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(e);
  }
  const blocks: BlockRef[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const [key, list] of grouped) {
    const [x, y] = key.split("/").map(Number);
    const used = new Set(list.flatMap((e) => [e.from, e.to]));
    const table = nodes.filter((n) => used.has(n.id));
    const raw = encodeBlock({ x, y }, table, list, strings, tag);
    const stored = deflateRawSync(raw, { level: 9 });
    const bbox: [number, number, number, number] = [
      Math.min(...list.flatMap((e) => e.geometry.map((p) => p[0]))),
      Math.min(...list.flatMap((e) => e.geometry.map((p) => p[1]))),
      Math.max(...list.flatMap((e) => e.geometry.map((p) => p[0]))),
      Math.max(...list.flatMap((e) => e.geometry.map((p) => p[1]))),
    ];
    blocks.push({
      x,
      y,
      offset,
      length: stored.length,
      rawLength: raw.length,
      crc: options.corruptBlock ? 1 : crc32(raw),
      nodes: table.length,
      edges: list.length,
      bbox,
    });
    chunks.push(stored);
    offset += stored.length;
  }
  const graph = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    graph.set(c, at);
    at += c.length;
  }
  const index = encodeIndex({
    formatVersion: 1,
    release,
    costModelVersion: 4,
    cell,
    blockZoom: 13,
    fieldZoom: 15,
    bbox: cellBBox(cell),
    strings: strings.values(),
    blocks,
    restrictions: [restriction],
    fields: {},
    meta: {},
  });
  const pack: Installed = {
    manifest: {
      schemaVersion: 2,
      format: "ibex-1",
      id,
      name: id,
      version: "v1",
      release,
      cell,
      blockZoom: 13,
      blocks: blocks.length,
      bbox: cellBBox(cell),
      osmTimestamp: "synthetic",
      costModelVersion: 4,
      terrainCoverage: 1,
      attribution: "synthetic",
      files: [
        { path: "index.ibx", bytes: index.length, sha256: "0".repeat(64) },
        { path: "graph.ibx", bytes: graph.length, sha256: "0".repeat(64) },
      ],
    },
    installedAt: "1970-01-01T00:00:00.000Z",
    directory: id,
    backend: "idb",
  } as Installed;
  return { pack, index, graph };
}

/** In-memory reader: no IndexedDB, no OPFS, no browser. */
function readerFor(built: Built[]): PackReader {
  const files = new Map<string, Uint8Array>();
  for (const b of built) {
    files.set(`${b.pack.manifest.id}/index.ibx`, b.index);
    files.set(`${b.pack.manifest.id}/graph.ibx`, b.graph);
  }
  const get = (pack: Installed, path: string) => {
    const bytes = files.get(`${pack.manifest.id}/${path}`);
    if (!bytes) throw new Error(`missing ${path}`);
    return bytes;
  };
  return {
    async readFile(pack, path) {
      return get(pack, path).buffer.slice(0) as ArrayBuffer;
    },
    async readRange(pack, path, offset, length) {
      const bytes = get(pack, path);
      return bytes.slice(offset, offset + length).buffer as ArrayBuffer;
    },
  };
}

// West cell owns the first two segments; the second one crosses the boundary.
const west = buildCell("9-264-181", [
  edge(0),
  edge(0, true),
  edge(1),
  edge(1, true),
]);
const east = buildCell("9-265-181", [edge(2), edge(2, true)]);
const published = [
  { id: "9-264-181", bbox: cellBBox({ zoom: 9, x: 264, y: 181 }) },
  { id: "9-265-181", bbox: cellBBox({ zoom: 9, x: 265, y: 181 }) },
];
const anchors: Point[] = [
  [LONS[0] + 0.001, LAT],
  [LONS[3] - 0.001, LAT],
];

const open = async (built: Built[], pub = published) => {
  const provider = new CellGraphProvider(
    built.map((b) => b.pack),
    RELEASE,
    pub,
    readerFor(built),
  );
  await provider.open();
  return provider;
};

describe("multi-pack graph provider", () => {
  it("routes across a cell boundary using both packs", async () => {
    const provider = await open([west, east]);
    const graph = await provider.load(searchArea(anchors));
    const request = { anchors, profile: resolveProfile("gravel") };
    const result = route(graph, request, "reference");
    expect(result.status).toBe("ok");
    // Three 1550 m segments, minus the two 0.001 deg anchor offsets.
    expect(result.distanceM).toBeGreaterThan(4000);
    expect(result.geometry[0][0]).toBeLessThan(BOUNDARY);
    expect(result.geometry.at(-1)![0]).toBeGreaterThan(BOUNDARY);
    expect(provider.stats.cells).toEqual(["9-264-181", "9-265-181"]);
  });

  it("cannot complete the route with only one pack installed", async () => {
    const provider = await open([west]);
    const graph = await provider.load(searchArea(anchors));
    const result = route(
      graph,
      { anchors, profile: resolveProfile("gravel") },
      "reference",
    );
    expect(result.status).not.toBe("ok");
  });

  it("merges the shared boundary node by identity, not proximity", async () => {
    const provider = await open([west, east]);
    const graph = await provider.load(searchArea(anchors));
    const ids = graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The node joining the west and east segments is present exactly once.
    expect(ids.filter((id) => id === nodes[2].id)).toHaveLength(1);
  });

  it("deduplicates an edge carried by both packs", async () => {
    // A pipeline change could put a boundary edge in both cells; the merge must survive it.
    const bothWays = buildCell("9-265-181", [
      edge(1),
      edge(1, true),
      edge(2),
      edge(2, true),
    ]);
    const provider = await open([west, bothWays]);
    const graph = await provider.load(searchArea(anchors));
    const ids = graph.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(provider.stats.duplicateEdges).toBeGreaterThan(0);
    expect(provider.stats.seamConflicts).toBe(0);
  });

  it("deduplicates identical restrictions from both packs", async () => {
    const provider = await open([west, east]);
    const graph = await provider.load(searchArea(anchors));
    expect(graph.restrictions).toHaveLength(1);
  });

  it("loads only the blocks intersecting the request", async () => {
    const provider = await open([west, east]);
    const wide = await provider.load(searchArea(anchors));
    const blocksForWide = provider.stats.blocks;
    const narrow = await open([west, east]);
    await narrow.load([
      LONS[0] - 0.001,
      LAT - 0.001,
      LONS[0] + 0.001,
      LAT + 0.001,
    ]);
    expect(narrow.stats.blocks).toBeLessThan(blocksForWide);
    expect(narrow.stats.rangeReads).toBe(narrow.stats.blocks);
    expect(wide.edges.length).toBeGreaterThan(0);
  });

  it("caches a block instead of re-reading it", async () => {
    const provider = await open([west, east]);
    const area = searchArea(anchors);
    await provider.load(area);
    const reads = provider.stats.rangeReads;
    await provider.load(area);
    expect(provider.stats.rangeReads).toBe(reads);
  });

  it("ignores a pack from another release", async () => {
    const foreign = buildCell("9-265-181", [edge(2), edge(2, true)], {
      release: "g4-19700101-p5-00000000",
    });
    const provider = await open([west, foreign]);
    expect(provider.installedCells).toEqual(["9-264-181"]);
  });

  it("refuses a block whose checksum does not match", async () => {
    const corrupt = buildCell("9-265-181", [edge(2), edge(2, true)], {
      corruptBlock: true,
    });
    const provider = await open([west, corrupt]);
    await expect(provider.load(searchArea(anchors))).rejects.toThrow(
      /checksum/,
    );
  });

  it("names published cells that are not installed", async () => {
    const provider = await open([west]);
    expect(provider.missing(searchArea(anchors))).toEqual(["9-265-181"]);
    expect(provider.missing(cellBBox({ zoom: 9, x: 264, y: 181 }))).toEqual([
      "9-265-181",
    ]);
  });

  it("reports nothing missing once every published cell is installed", async () => {
    const provider = await open([west, east]);
    expect(provider.missing(searchArea(anchors))).toEqual([]);
  });

  it("knows which points it covers", async () => {
    const provider = await open([west]);
    expect(provider.contains(anchors[0])).toBe(true);
    expect(provider.contains([LONS[3], LAT])).toBe(false);
    expect(provider.envelope()).toEqual(cellBBox({ zoom: 9, x: 264, y: 181 }));
  });

  it("spans both cells in its envelope when both are installed", async () => {
    const provider = await open([west, east]);
    const envelope = provider.envelope()!;
    expect(envelope[0]).toBeCloseTo(
      cellBBox({ zoom: 9, x: 264, y: 181 })[0],
      9,
    );
    expect(envelope[2]).toBeCloseTo(
      cellBBox({ zoom: 9, x: 265, y: 181 })[2],
      9,
    );
  });

  it("builds a corridor field over the merged graph", async () => {
    const provider = await open([west, east]);
    const graph = await provider.load(searchArea(anchors));
    const field = buildField(graph, {
      anchors,
      profile: resolveProfile("gravel"),
    });
    expect(field.width * field.height).toBeGreaterThan(0);
    expect(field.paths).toHaveLength(1);
    expect(field.costs.some((c) => c < 15)).toBe(true);
  });
});

describe("search area", () => {
  it("covers both anchors with a floor for short requests", () => {
    const area = searchArea([
      [6.15, 46.2],
      [6.16, 46.21],
    ]);
    expect(area[0]).toBeLessThan(6.15);
    expect(area[2]).toBeGreaterThan(6.16);
    expect((area[3] - area[1]) * 111.32).toBeGreaterThan(20);
  });
  it("scales with a long request instead of staying at the floor", () => {
    const wide = searchArea([
      [5.0, 45.5],
      [7.0, 47.0],
    ]);
    expect(wide[2] - wide[0]).toBeGreaterThan(2);
  });
});
