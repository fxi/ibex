/** Ibex binary routing format, version 1. */
import type { BBox } from "../../geo/grid";
import type { Edge, Node, Restriction } from "../../routing/types";

export const BLOCK_MAGIC = 0x42584249; // "IBXB" little-endian
export const INDEX_MAGIC = 0x49584249; // "IBXI"
export const FORMAT_VERSION = 1;
export const INDEX_HEADER_BYTES = 64;

/** Coordinates are stored as OSM's own 1e-7 degrees, so encoding is lossless. */
export const COORD_SCALE = 1e7;
/** length is round(m, 2) upstream, so centimetres are lossless. */
export const LENGTH_SCALE = 100;
/** The unit-range attributes are round(x, 3) upstream, so thousandths are lossless. */
export const UNIT_SCALE = 1000;
/** grades are round(m, 3) / round(grade, 5) upstream. */
export const GRADE_LENGTH_SCALE = 1000;
export const GRADE_SCALE = 100000;
/** elevation is rounded to centimetres upstream. */
export const ELEVATION_SCALE = 100;
export const FERRY_SECONDS_SCALE = 1000;

export const MAX_BLOCK_NODES = 100_000;
export const MAX_BLOCK_EDGES = 100_000;
export const MAX_RAW_BLOCK_BYTES = 8 << 20;

export const FLAG = {
  bridge: 1 << 0,
  tunnel: 1 << 1,
  hasGrades: 1 << 2,
  hasTags: 1 << 3,
  hasFerrySeconds: 1 << 4,
  /** Inherit everything direction-independent from the preceding edge. */
  mirrorPrevious: 1 << 5,
  hasName: 1 << 6,
  hasFerryService: 1 << 7,
  hasUrban: 1 << 8,
  hasQuality: 1 << 9,
  hasForest: 1 << 10,
} as const;

/** Only these four differ between a segment's two directions (measured, not assumed). */
export const DIRECTIONAL = ["utility", "cyclingNetwork", "junction", "reward"] as const;

export type IbexErrorKind =
  | "magic"
  | "version"
  | "release"
  | "cell"
  | "costModel"
  | "digest"
  | "bounds"
  | "limits"
  | "field";

export class IbexError extends Error {
  constructor(
    readonly kind: IbexErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "IbexError";
  }
}

export type BlockRef = {
  x: number;
  y: number;
  offset: number;
  length: number;
  rawLength: number;
  crc: number;
  nodes: number;
  edges: number;
  bbox: BBox;
};

export type IbexField = {
  presetHash: string;
  zoom: number;
  x0: number;
  y0: number;
  width: number;
  height: number;
  costs: Uint8Array;
};

export type IbexIndex = {
  formatVersion: number;
  release: string;
  releaseTag: number;
  costModelVersion: number;
  cell: { zoom: number; x: number; y: number };
  blockZoom: number;
  fieldZoom: number;
  bbox: BBox;
  strings: string[];
  blocks: BlockRef[];
  restrictions: Restriction[];
  fields: Record<string, IbexField>;
  meta: Record<string, unknown>;
};

export type DecodedBlock = { nodes: Node[]; edges: Edge[] };

/** First 4 bytes of the release id, so a foreign block is rejected from its own header. */
export function releaseTag(release: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < release.length; i++) {
    hash ^= release.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
