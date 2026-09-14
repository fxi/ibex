/**
 * Cell index: a fixed 64-byte binary header so a pack identifies itself from a
 * `bytes=0-63` range request, followed by the block directory and restrictions.
 *
 * The header is the gate — magic, format version, release tag, cell coordinates and cost
 * model are all checked before any body is parsed, so a foreign or corrupt pack is rejected
 * without decoding it. The bulk of a pack is its blocks, which are fully binary; the
 * directory itself is a small JSON body (~1% of a cell) kept readable on purpose.
 */
import { ByteReader, ByteWriter, crc32 } from "./varint";
import {
  FORMAT_VERSION,
  INDEX_HEADER_BYTES,
  INDEX_MAGIC,
  IbexError,
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

export function encodeIndex(index: Omit<IbexIndex, "releaseTag">): Uint8Array {
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
  header.u16(FORMAT_VERSION);
  header.u16(0);
  header.u32(computeReleaseTag(index.release));
  header.byte(index.cell.zoom);
  header.u32(index.cell.x);
  header.u32(index.cell.y);
  header.byte(index.blockZoom);
  header.byte(index.fieldZoom);
  header.u16(index.costModelVersion);
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
  costModelVersion?: number;
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
  const formatVersion = r.u16();
  if (formatVersion !== FORMAT_VERSION)
    throw new IbexError("version", `Unsupported pack version ${formatVersion}`);
  r.u16();
  const tag = r.u32();
  const zoom = r.byte();
  const x = r.u32();
  const y = r.u32();
  const blockZoom = r.byte();
  const fieldZoom = r.byte();
  const costModelVersion = r.u16();
  const jsonOffset = r.u32();
  const jsonLength = r.u32();
  r.u32();
  r.u32();
  const crc = r.u32();
  if (crc32(data.subarray(0, r.position - 4)) !== crc)
    throw new IbexError("digest", "Cell index header failed its checksum");

  if (expect.costModelVersion !== undefined && costModelVersion !== expect.costModelVersion)
    throw new IbexError(
      "costModel",
      "This pack uses outdated routing data. Install the updated area.",
    );
  if (expect.release !== undefined && tag !== computeReleaseTag(expect.release))
    throw new IbexError("release", "Pack belongs to another data release");
  if (
    expect.cell &&
    (expect.cell.zoom !== zoom || expect.cell.x !== x || expect.cell.y !== y)
  )
    throw new IbexError("cell", `Pack contains cell ${zoom}-${x}-${y}`);
  if (jsonOffset + jsonLength > data.length)
    throw new IbexError("bounds", "Cell index body is truncated");

  let body: Body;
  try {
    body = JSON.parse(
      new TextDecoder().decode(data.subarray(jsonOffset, jsonOffset + jsonLength)),
    );
  } catch {
    throw new IbexError("bounds", "Cell index body is not valid JSON");
  }
  if (!Array.isArray(body.blocks) || !Array.isArray(body.strings))
    throw new IbexError("bounds", "Cell index body is missing its directory");
  if (expect.release !== undefined && body.release !== expect.release)
    throw new IbexError("release", "Pack belongs to another data release");

  return {
    formatVersion,
    release: body.release,
    releaseTag: tag,
    costModelVersion,
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
  formatVersion: number;
  releaseTag: number;
  cell: { zoom: number; x: number; y: number };
} {
  const r = new ByteReader(data);
  const magic = r.u32() === INDEX_MAGIC;
  const formatVersion = r.u16();
  r.u16();
  const releaseTag = r.u32();
  const zoom = r.byte();
  const x = r.u32();
  const y = r.u32();
  return { magic, formatVersion, releaseTag, cell: { zoom, x, y } };
}
