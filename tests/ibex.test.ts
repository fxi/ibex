import { describe, expect, it } from "vitest";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { ByteReader, ByteWriter, crc32 } from "../src/offline/ibex/varint";
import {
  decodeBlock,
  encodeBlock,
  stringTable,
} from "../src/offline/ibex/block";
import {
  decodeIndex,
  encodeIndex,
  probeHeader,
} from "../src/offline/ibex/index";
import { IbexError, releaseTag } from "../src/offline/ibex/spec";
import { validateEdge, validateNode } from "../src/offline/validate";
import type { Edge, Node } from "../src/routing/types";

const RELEASE = "g4-20260909-p5-abcdef12";
const TAG = releaseTag(RELEASE);

const node = (
  id: number,
  lon: number,
  lat: number,
  elevation: number | null,
): Node => ({
  id,
  p: [lon, lat],
  elevation,
});

/** A segment plus its reverse, which is what the mirror path in the encoder targets. */
function pair(
  way: number,
  segment: number,
  from: Node,
  to: Node,
  extra: Partial<Edge> = {},
) {
  const id = (way * 4096 + segment) * 2;
  const geometry = [from.p, [6.2, 46.21] as [number, number], to.p];
  const base: Edge = {
    id,
    from: from.id,
    to: to.id,
    way: String(way),
    length: 123.45,
    geometry,
    grades: [
      [20, 0.0123],
      [103.45, -0.0456],
    ],
    surface: "asphalt",
    highway: "residential",
    tags: { bicycle: "yes", surface: "asphalt" },
    stress: 0.125,
    uncertainty: 0.25,
    utility: 0.703,
    urban: 0.4,
    cyclingNetwork: 1,
    quality: 0.87,
    forest: 0.125,
    reward: 0.5,
    junction: 0.25,
    bridge: false,
    tunnel: false,
    name: "Rue du Test",
    tile: "13-4235-2907",
    ...extra,
  };
  const reverse: Edge = {
    ...base,
    id: id + 1,
    from: to.id,
    to: from.id,
    geometry: [...geometry].reverse(),
    grades: base.grades
      ? [...base.grades].reverse().map(([m, g]) => [m, -g] as [number, number])
      : null,
    // Measured on real data: only these four differ between directions.
    utility: 0.201,
    cyclingNetwork: 0,
    reward: 0.125,
    junction: 0.75,
  };
  return [base, reverse];
}

const nodes = [
  node(1, 6.1, 46.2, 400.25),
  node(2, 6.3, 46.22, 512.5),
  node(14167400043, 6.35, 46.25, -12.75),
];
const edges = [
  ...pair(1000, 0, nodes[0], nodes[1]),
  ...pair(1000, 7, nodes[1], nodes[2], {
    surface: "gravel",
    highway: "track",
    grades: null,
    tags: undefined,
    name: "",
    bridge: true,
    tunnel: true,
    quality: undefined,
    forest: undefined,
  }),
  // A one-way-reverse segment has no forward partner, so it cannot be mirrored.
  {
    ...pair(2000, 3, nodes[0], nodes[2])[1],
    ferryService: "yes",
    ferrySeconds: 1234.567,
    highway: "ferry",
  } as Edge,
];

function roundTrip(list: Edge[] = edges) {
  const strings = stringTable();
  const bytes = encodeBlock({ x: 4235, y: 2907 }, nodes, list, strings, TAG);
  const out = decodeBlock(bytes, strings.values(), {
    releaseTag: TAG,
    block: { x: 4235, y: 2907 },
    crc: crc32(bytes),
  });
  return { bytes, out, strings };
}

describe("varints", () => {
  it("round-trips unsigned values across byte boundaries", () => {
    const values = [
      0,
      1,
      127,
      128,
      300,
      16383,
      16384,
      2 ** 31,
      2 ** 45,
      Number.MAX_SAFE_INTEGER,
    ];
    const w = new ByteWriter();
    for (const v of values) w.varint(v);
    const r = new ByteReader(w.finish());
    for (const v of values) expect(r.varint()).toBe(v);
  });
  it("round-trips signed values with small magnitudes staying short", () => {
    const values = [0, -1, 1, -63, 64, -8192, 8191, -(2 ** 40), 2 ** 40];
    const w = new ByteWriter();
    for (const v of values) w.zigzag(v);
    const r = new ByteReader(w.finish());
    for (const v of values) expect(r.zigzag()).toBe(v);
    const one = new ByteWriter();
    one.zigzag(-1);
    expect(one.size).toBe(1);
  });
  it("refuses non-integers and negatives, and reads past the end loudly", () => {
    expect(() => new ByteWriter().varint(1.5)).toThrow();
    expect(() => new ByteWriter().varint(-1)).toThrow();
    expect(() => new ByteReader(new Uint8Array([])).varint()).toThrow(
      /past end/,
    );
  });
  it("computes a stable CRC32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("block round trip", () => {
  it("is exactly lossless for nodes, including negative elevation", () => {
    const { out } = roundTrip();
    expect(out.nodes).toHaveLength(3);
    for (const [i, original] of nodes.entries()) {
      expect(out.nodes[i].id).toBe(original.id);
      expect(out.nodes[i].p).toEqual(original.p);
      expect(out.nodes[i].elevation).toBe(original.elevation);
    }
  });
  it("is exactly lossless for every edge attribute", () => {
    const { out } = roundTrip();
    const byId = new Map(out.edges.map((e) => [e.id, e]));
    expect(out.edges).toHaveLength(edges.length);
    for (const original of edges) {
      const decoded = byId.get(original.id)!;
      expect(decoded).toBeDefined();
      for (const field of Object.keys(original) as (keyof Edge)[]) {
        // tile is re-derived from the block, which is the point of storing the block id.
        if (field === "tile") continue;
        expect({ field, value: decoded[field] }).toEqual({
          field,
          value: original[field],
        });
      }
    }
  });
  it("re-derives the way id and the block tile rather than storing them", () => {
    const { out } = roundTrip();
    expect(out.edges[0].way).toBe("1000");
    expect(new Set(out.edges.map((e) => e.tile))).toEqual(
      new Set(["13-4235-2907"]),
    );
  });
  it("satisfies the same validators the legacy reader uses", () => {
    const { out } = roundTrip();
    for (const n of out.nodes) expect(() => validateNode(n)).not.toThrow();
    for (const e of out.edges) expect(() => validateEdge(e)).not.toThrow();
  });
  it("mirrors a reverse segment instead of storing it again", () => {
    const forwardOnly = edges.filter((e) => e.id % 2 === 0);
    const withReverse = edges.filter((e) => e.id < (2000 * 4096 + 3) * 2);
    const a = roundTrip(forwardOnly).bytes.length;
    const b = roundTrip(withReverse).bytes.length;
    const extraEdges = withReverse.length - forwardOnly.length;
    // Each mirrored edge should cost a handful of bytes, not a whole record.
    expect((b - a) / extraEdges).toBeLessThan(20);
    expect(b).toBeGreaterThan(a);
  });
  it("survives deflate, which is how packs are stored", () => {
    const { bytes } = roundTrip();
    const stored = deflateRawSync(bytes, { level: 9 });
    expect(new Uint8Array(inflateRawSync(stored))).toEqual(bytes);
  });
});

describe("block rejection", () => {
  const cases: [string, (b: Uint8Array) => Uint8Array, string][] = [
    [
      "bad magic",
      (b) => {
        const c = b.slice();
        c[0] ^= 0xff;
        return c;
      },
      "magic",
    ],
    [
      "unsupported version",
      (b) => {
        const c = b.slice();
        c[4] = 9;
        return c;
      },
      "version",
    ],
    [
      "another release",
      (b) => {
        const c = b.slice();
        c[8] ^= 0xff;
        return c;
      },
      "release",
    ],
  ];
  for (const [name, mutate, kind] of cases)
    it(`refuses a block with ${name}`, () => {
      const { bytes } = roundTrip();
      const broken = mutate(bytes);
      try {
        decodeBlock(broken, [], { releaseTag: TAG });
        throw new Error("expected a rejection");
      } catch (e) {
        expect((e as IbexError).kind).toBe(kind);
      }
    });
  it("refuses a block that fails its checksum", () => {
    const { bytes, strings } = roundTrip();
    const flipped = bytes.slice();
    flipped[flipped.length - 2] ^= 0x01;
    expect(() =>
      decodeBlock(flipped, strings.values(), {
        releaseTag: TAG,
        crc: crc32(bytes),
      }),
    ).toThrow(/checksum/);
  });
  it("refuses a block for a different tile", () => {
    const { bytes, strings } = roundTrip();
    expect(() =>
      decodeBlock(bytes, strings.values(), {
        releaseTag: TAG,
        block: { x: 1, y: 2 },
      }),
    ).toThrow(/not the block requested/);
  });
  it("refuses a truncated block rather than returning partial data", () => {
    const { bytes, strings } = roundTrip();
    expect(() =>
      decodeBlock(bytes.slice(0, bytes.length - 12), strings.values(), {
        releaseTag: TAG,
      }),
    ).toThrow();
  });
  it("refuses a string index outside the dictionary", () => {
    const { bytes } = roundTrip();
    expect(() => decodeBlock(bytes, ["only-one"], { releaseTag: TAG })).toThrow(
      /outside the dictionary/,
    );
  });
});

describe("cell index", () => {
  const base = {
    release: RELEASE,
    cell: { zoom: 9, x: 264, y: 181 },
    blockZoom: 13,
    fieldZoom: 15,
    bbox: [5.625, 46.07, 6.328, 46.559] as [number, number, number, number],
    strings: ["asphalt", "residential"],
    blocks: [
      {
        x: 4235,
        y: 2907,
        offset: 0,
        length: 128,
        rawLength: 256,
        crc: 12345,
        nodes: 3,
        edges: 5,
        bbox: [6, 46, 6.1, 46.1] as [number, number, number, number],
      },
    ],
    restrictions: [{ ways: ["1", "2"], via: 7, only: false, uTurn: false }],
    fields: {},
    meta: { nodes: 3, edges: 5 },
  };

  it("round-trips the directory and restrictions", () => {
    const decoded = decodeIndex(encodeIndex(base), {
      release: RELEASE,
      cell: base.cell,
    });
    expect(decoded.release).toBe(RELEASE);
    expect(decoded.releaseTag).toBe(TAG);
    expect(decoded.cell).toEqual(base.cell);
    expect(decoded.blockZoom).toBe(13);
    expect(decoded.blocks).toEqual(base.blocks);
    expect(decoded.restrictions).toEqual(base.restrictions);
    expect(decoded.strings).toEqual(base.strings);
  });
  it("identifies a pack from its first 64 bytes alone", () => {
    const probe = probeHeader(encodeIndex(base).slice(0, 64));
    expect(probe.magic).toBe(true);
    expect(probe.dataVersion).toBe(1);
    expect(probe.releaseTag).toBe(TAG);
    expect(probe.cell).toEqual(base.cell);
  });
  it("refuses another release and another cell", () => {
    const bytes = encodeIndex(base);
    expect(() => decodeIndex(bytes, { release: "g4-other" })).toThrow(
      /another data release/,
    );
    expect(() => decodeIndex(bytes, { cell: { zoom: 9, x: 1, y: 1 } })).toThrow(
      /contains cell/,
    );
    const future = bytes.slice();
    future[4] = 99; // the data version, little-endian u16 after the magic
    expect(() => decodeIndex(future)).toThrow(/Unsupported data version 99/);
  });
  /**
   * The header CRC covers the header only, so the body is the one part of a pack that
   * arrives unchecked. Its shape is a precondition of the search: block offsets become
   * byte ranges, and a restriction shorter than two ways is indexed as `undefined`.
   */
  it("refuses a body whose directory or restrictions are malformed", () => {
    // A well-formed header around a body the encoder would never produce, so the header
    // checks all pass and the body is what is under test.
    const encoded = (body: Record<string, unknown>) =>
      encodeIndex(body as unknown as Parameters<typeof encodeIndex>[0]);
    const cases: [string, Record<string, unknown>][] = [
      ["a block offset that is not a number", { ...base, blocks: [{ ...base.blocks[0], offset: "0" }] }],
      ["a negative block length", { ...base, blocks: [{ ...base.blocks[0], length: -1 }] }],
      ["a string table holding a number", { ...base, strings: [1] }],
      ["a one-way restriction", { ...base, restrictions: [{ ways: ["1"], only: false }] }],
      ["a bbox that is not four numbers", { ...base, bbox: [1, 2, 3] }],
    ];
    for (const [what, body] of cases) {
      let thrown: unknown;
      try {
        decodeIndex(encoded(body));
      } catch (e) {
        thrown = e;
      }
      expect(thrown, what).toBeInstanceOf(IbexError);
      expect((thrown as IbexError).message, what).toMatch(/malformed/);
    }
    // Absent optional members stay acceptable: the encoder may omit them.
    const { restrictions: _r, meta: _m, ...without } = base;
    const decoded = decodeIndex(encoded(without));
    expect(decoded.restrictions).toEqual([]);
    expect(decoded.meta).toEqual({});
    // An unknown additive field must not need a DATA_VERSION bump to be readable.
    expect(() => decodeIndex(encoded({ ...base, futureField: 1 }))).not.toThrow();
  });
  it("refuses a corrupt header and a truncated body", () => {
    const bytes = encodeIndex(base);
    const broken = bytes.slice();
    broken[24] ^= 0xff;
    expect(() => decodeIndex(broken)).toThrow(/checksum/);
    expect(() => decodeIndex(bytes.slice(0, 40))).toThrow(
      /shorter than its header/,
    );
    expect(() => decodeIndex(bytes.slice(0, 70))).toThrow();
  });
});
