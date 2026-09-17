/**
 * Cell index: a fixed 64-byte binary header so a pack identifies itself from a
 * `bytes=0-63` range request, followed by the block directory and restrictions.
 *
 * The header is the gate — magic, data version, release tag and cell coordinates are all
 * checked before any body is parsed, so a foreign or corrupt pack is rejected
 * without decoding it. The bulk of a pack is its blocks, which are fully binary; the
 * directory itself is a small JSON body (~1% of a cell) kept readable on purpose.
 */
import { z } from "zod";
import { ByteReader, ByteWriter, crc32 } from "./varint";
import { LIMITS } from "../validate";
import {
  DATA_VERSION,
  INDEX_HEADER_BYTES,
  INDEX_MAGIC,
  IbexError,
  MAX_RAW_BLOCK_BYTES,
  releaseTag as computeReleaseTag,
  type BlockRef,
  type IbexIndex,
} from "./spec";
import type { BBox } from "../../geo/grid";
import type { Restriction } from "../../routing/types";

type Body = {
  release: string;
  bbox: BBox;
  strings: string[];
  blocks: BlockRef[];
  restrictions: Restriction[];
  meta: Record<string, unknown>;
};

const count = z.number().int().nonnegative();
/**
 * The header is binary and checksummed; this body is JSON, and its CRC covers only the
 * header, so nothing else stands between a malformed pack and the router. Block offsets
 * become byte ranges and restrictions are indexed by position, so their shape is a
 * precondition of the search, not a detail.
 *
 * Deliberately tolerant where the encoder is: `restrictions` and `meta` may be absent, and
 * unknown keys are ignored so an additive field does not need a DATA_VERSION bump.
 */
const bodySchema = z.object({
  release: z.string().max(64),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  strings: z.array(z.string()).max(LIMITS.chunkEdges),
  blocks: z
    .array(
      z.object({
        x: count,
        y: count,
        offset: count,
        length: count,
        rawLength: count.max(MAX_RAW_BLOCK_BYTES),
        crc: z.number().int(),
        nodes: count.max(LIMITS.chunkNodes),
        edges: count.max(LIMITS.chunkEdges),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      }),
    )
    .max(LIMITS.indexChunks),
  restrictions: z
    .array(
      z.object({
        // The search reads `ways[ways.length - 2]`: a shorter rule is not a rule.
        ways: z.array(z.string()).min(2).max(64),
        via: count.optional(),
        only: z.boolean(),
        uTurn: z.boolean().optional(),
      }),
    )
    .max(LIMITS.restrictions)
    .optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export function encodeIndex(
  index: Omit<IbexIndex, "releaseTag" | "dataVersion">,
): Uint8Array {
  const body: Body = {
    release: index.release,
    bbox: index.bbox,
    strings: index.strings,
    blocks: index.blocks,
    restrictions: index.restrictions,
    meta: index.meta,
  };
  const json = new TextEncoder().encode(JSON.stringify(body));
  const header = new ByteWriter(INDEX_HEADER_BYTES);
  header.u32(INDEX_MAGIC);
  header.u16(DATA_VERSION);
  header.u16(0);
  header.u32(computeReleaseTag(index.release));
  header.byte(index.cell.zoom);
  header.u32(index.cell.x);
  header.u32(index.cell.y);
  header.byte(index.blockZoom);
  header.byte(index.fieldZoom);
  header.u16(0);
  header.u32(INDEX_HEADER_BYTES);
  header.u32(json.length);
  // Reserved for baked preset cost rasters; the worker currently builds fields at runtime
  // from the merged graph, so none are emitted yet.
  header.u32(0);
  header.u32(0);
  const withoutCrc = header.finish();
  const crc = crc32(withoutCrc);
  const out = new Uint8Array(INDEX_HEADER_BYTES + json.length);
  out.set(withoutCrc, 0);
  const tail = new ByteWriter(4);
  tail.u32(crc);
  out.set(tail.finish(), withoutCrc.length);
  out.set(json, INDEX_HEADER_BYTES);
  return out;
}

export type IndexExpectation = {
  release?: string;
  cell?: { zoom: number; x: number; y: number };
};

export function decodeIndex(
  data: Uint8Array,
  expect: IndexExpectation = {},
): IbexIndex {
  if (data.length < INDEX_HEADER_BYTES)
    throw new IbexError("bounds", "Cell index is shorter than its header");
  const r = new ByteReader(data);
  if (r.u32() !== INDEX_MAGIC)
    throw new IbexError("magic", "Not an Ibex cell index");
  const dataVersion = r.u16();
  if (dataVersion !== DATA_VERSION)
    throw new IbexError("version", `Unsupported data version ${dataVersion}`);
  r.u16();
  const tag = r.u32();
  const zoom = r.byte();
  const x = r.u32();
  const y = r.u32();
  const blockZoom = r.byte();
  const fieldZoom = r.byte();
  r.u16();
  const jsonOffset = r.u32();
  const jsonLength = r.u32();
  r.u32();
  r.u32();
  const crc = r.u32();
  if (crc32(data.subarray(0, r.position - 4)) !== crc)
    throw new IbexError("digest", "Cell index header failed its checksum");

  if (expect.release !== undefined && tag !== computeReleaseTag(expect.release))
    throw new IbexError("release", "Pack belongs to another data release");
  if (
    expect.cell &&
    (expect.cell.zoom !== zoom || expect.cell.x !== x || expect.cell.y !== y)
  )
    throw new IbexError("cell", `Pack contains cell ${zoom}-${x}-${y}`);
  if (jsonOffset + jsonLength > data.length)
    throw new IbexError("bounds", "Cell index body is truncated");

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder().decode(data.subarray(jsonOffset, jsonOffset + jsonLength)),
    );
  } catch {
    throw new IbexError("bounds", "Cell index body is not valid JSON");
  }
  const checked = bodySchema.safeParse(parsed);
  if (!checked.success)
    throw new IbexError(
      "bounds",
      `Cell index body is malformed: ${checked.error.issues[0]?.message ?? "unknown"}`,
    );
  const body = checked.data as Body;
  if (expect.release !== undefined && body.release !== expect.release)
    throw new IbexError("release", "Pack belongs to another data release");

  return {
    dataVersion,
    release: body.release,
    releaseTag: tag,
    cell: { zoom, x, y },
    blockZoom,
    fieldZoom,
    bbox: body.bbox,
    strings: body.strings,
    blocks: body.blocks,
    restrictions: body.restrictions ?? [],
    fields: {},
    meta: body.meta ?? {},
  };
}

/** Identify a pack from the first 64 bytes alone, for publication checks. */
export function probeHeader(data: Uint8Array): {
  magic: boolean;
  dataVersion: number;
  releaseTag: number;
  cell: { zoom: number; x: number; y: number };
} {
  const r = new ByteReader(data);
  const magic = r.u32() === INDEX_MAGIC;
  const dataVersion = r.u16();
  r.u16();
  const releaseTag = r.u32();
  const zoom = r.byte();
  const x = r.u32();
  const y = r.u32();
  return { magic, dataVersion, releaseTag, cell: { zoom, x, y } };
}
