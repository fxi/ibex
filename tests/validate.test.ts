import { describe, expect, it } from "vitest";
import {
  LIMITS,
  validateAnchors,
  validateChunk,
  validateEdge,
  validateField,
  validateIndexSize,
  validateNode,
} from "../src/offline/validate";
import type { Edge, Field, Node, Point } from "../src/routing/types";

const node = (): Node => ({ id: 1, p: [6.15, 46.2], elevation: 400 });
const edge = (): Edge =>
  ({
    id: 1,
    from: 1,
    to: 2,
    way: "10",
    length: 100,
    geometry: [
      [6.15, 46.2],
      [6.16, 46.2],
    ],
    grades: [[100, 0.05]],
    surface: "paved",
    highway: "cycleway",
    stress: 0.1,
    uncertainty: 0.1,
    utility: 0.7,
    urban: 0.2,
    cyclingNetwork: 1,
    bridge: false,
    tunnel: false,
    name: "",
    tile: "13-4235-2907",
  }) as Edge;
const field = (): Field =>
  ({
    width: 2,
    height: 2,
    cellM: 700,
    bbox: [6, 46, 6.1, 46.1],
    costs: [1, 2, 3, 4],
    paths: [],
  }) as unknown as Field;

describe("node validation", () => {
  it("accepts a well-formed node", () => {
    expect(validateNode(node())).toEqual(node());
  });
  it("rejects non-integer, unsafe, or malformed coordinates", () => {
    for (const bad of [
      { id: 1.5 },
      { id: Number.MAX_SAFE_INTEGER + 2 },
      { p: [6.15] },
      { p: [6.15, 46.2, 1] },
      { p: [NaN, 46.2] },
      { p: [6.15, Infinity] },
    ])
      expect(() => validateNode({ ...node(), ...bad } as Node)).toThrow(
        "Invalid graph node",
      );
  });
});

describe("edge validation", () => {
  it("accepts a well-formed edge", () => {
    expect(validateEdge(edge())).toEqual(edge());
  });
  it("requires a finite positive length and a string highway", () => {
    for (const bad of [
      { length: 0 },
      { length: -1 },
      { length: NaN },
      { highway: 5 },
    ])
      expect(() => validateEdge({ ...edge(), ...bad } as Edge)).toThrow(
        "Invalid graph edge",
      );
  });
  it("requires every scored attribute to be a number in [0,1]", () => {
    for (const key of [
      "stress",
      "uncertainty",
      "utility",
      "urban",
      "cyclingNetwork",
    ] as const)
      for (const value of [-0.1, 1.1, NaN, undefined, "0.5"])
        expect(() =>
          validateEdge({ ...edge(), [key]: value } as unknown as Edge),
        ).toThrow("Invalid graph edge");
  });
  it("requires a ferry to name its service and keep ferrySeconds sane", () => {
    expect(() => validateEdge({ ...edge(), highway: "ferry" } as Edge)).toThrow(
      "Invalid graph edge",
    );
    expect(() =>
      validateEdge({ ...edge(), highway: "ferry", ferryService: "" } as Edge),
    ).toThrow("Invalid graph edge");
    expect(
      validateEdge({
        ...edge(),
        highway: "ferry",
        ferryService: "yes",
      } as Edge).highway,
    ).toBe("ferry");
    expect(() => validateEdge({ ...edge(), ferrySeconds: -1 } as Edge)).toThrow(
      "Invalid graph edge",
    );
  });
  it("requires at least two valid geometry points", () => {
    for (const geometry of [
      [[6.15, 46.2]],
      [[6.15, 46.2], [6.16]],
      [
        [6.15, 46.2],
        [NaN, 46.2],
      ],
    ])
      expect(() =>
        validateEdge({ ...edge(), geometry } as unknown as Edge),
      ).toThrow("Invalid graph edge");
  });
  it("rejects malformed grade samples but allows none at all", () => {
    for (const grades of [[[0, 0.05]], [[-1, 0.05]], [[100, NaN]]])
      expect(() =>
        validateEdge({ ...edge(), grades } as unknown as Edge),
      ).toThrow("Invalid graph edge");
    expect(validateEdge({ ...edge(), grades: null } as Edge).grades).toBeNull();
  });
});

describe("chunk and index limits", () => {
  it("rejects a chunk that is not two arrays", () => {
    expect(() => validateChunk({ nodes: [], edges: {} } as never)).toThrow(
      "Invalid graph chunk",
    );
    expect(() => validateChunk({ nodes: {}, edges: [] } as never)).toThrow(
      "Invalid graph chunk",
    );
  });
  it("caps edge and node counts with distinct messages", () => {
    expect(() =>
      validateChunk({
        nodes: [],
        edges: { length: LIMITS.chunkEdges + 1 } as never,
      } as never),
    ).toThrow("Invalid graph chunk");
    expect(() =>
      validateChunk({
        nodes: Array.from({ length: LIMITS.chunkNodes + 1 }),
        edges: [],
      } as never),
    ).toThrow("Invalid graph node count");
  });
  it("caps chunk and restriction counts in the index", () => {
    expect(() =>
      validateIndexSize({
        chunks: Array.from({ length: LIMITS.indexChunks + 1 }),
        restrictions: [],
      }),
    ).toThrow("Invalid graph index size");
    expect(() =>
      validateIndexSize({
        chunks: [],
        restrictions: Array.from({ length: LIMITS.restrictions + 1 }),
      }),
    ).toThrow("Invalid graph index size");
    expect(() =>
      validateIndexSize({ chunks: [], restrictions: [] }),
    ).not.toThrow();
  });
});

describe("field validation", () => {
  it("accepts a consistent field", () => {
    expect(validateField(field()).costs).toHaveLength(4);
  });
  it("requires integral positive dimensions matching the cost array", () => {
    for (const bad of [
      { width: 0 },
      { height: 0 },
      { width: 1.5 },
      { costs: [1, 2, 3] },
      { costs: [1, 2, 3, 0] },
      { costs: [1, 2, 3, NaN] },
    ])
      expect(() =>
        validateField({ ...field(), ...bad } as unknown as Field),
      ).toThrow("Invalid semantic field");
  });
  it("caps total cells, which is what makes zoom 16 fields infeasible", () => {
    expect(LIMITS.fieldCells).toBe(100_000);
    expect(() =>
      validateField({
        ...field(),
        width: 512,
        height: 512,
        costs: [1, 2, 3, 4],
      } as unknown as Field),
    ).toThrow("Invalid semantic field");
    // A 16-cell mosaic of 64x64 zoom-15 rasters is 65,536 cells and fits.
    expect(256 * 256).toBeLessThan(LIMITS.fieldCells);
    expect(512 * 512).toBeGreaterThan(LIMITS.fieldCells);
  });
});

describe("anchor validation", () => {
  it("accepts two to twelve finite points", () => {
    const two: Point[] = [
      [6.15, 46.2],
      [6.2, 46.25],
    ];
    expect(validateAnchors(two)).toBe(two);
    expect(
      validateAnchors(Array.from({ length: 12 }, () => [6, 46] as Point)),
    ).toHaveLength(12);
  });
  it("rejects too few, too many, and malformed anchors", () => {
    expect(() => validateAnchors([[6, 46]])).toThrow("Invalid route anchors");
    expect(() =>
      validateAnchors(Array.from({ length: 13 }, () => [6, 46] as Point)),
    ).toThrow("Invalid route anchors");
    expect(() =>
      validateAnchors([
        [6, 46],
        [NaN, 46],
      ]),
    ).toThrow("Invalid route anchors");
  });
});
