/**
 * OSM PBF reader: the one place the builder meets OpenStreetMap's wire format.
 *
 * Hand-rolled rather than taken from a library because the format's useful subset is
 * small, the repo already decodes its own binary formats this way, and `src/build/` has
 * to stay free of Node-only dependencies so the same code can run in a worker later.
 * Decompression is injected for exactly that reason: `node:zlib` here, a
 * `DecompressionStream` there.
 *
 * Only what the builder consumes is decoded — ids, coordinates, tags, way node refs and
 * relation members. Version, changeset, user and timestamp are skipped rather than parsed.
 *
 * Format: <https://wiki.openstreetmap.org/wiki/PBF_Format>
 */

export type OsmTags = Record<string, string>;
export type OsmNode = { id: number; lon: number; lat: number; tags: OsmTags };
export type OsmWay = { id: number; refs: number[]; tags: OsmTags };
export type OsmMemberType = "node" | "way" | "relation";
export type OsmMember = { type: OsmMemberType; ref: number; role: string };
export type OsmRelation = { id: number; members: OsmMember[]; tags: OsmTags };

export type OsmVisitor = {
  node?: (node: OsmNode) => void;
  way?: (way: OsmWay) => void;
  relation?: (relation: OsmRelation) => void;
};

/** Raw deflate is never used by OSM writers; `zlib_data` is zlib-wrapped. */
export type Inflate = (data: Uint8Array) => Promise<Uint8Array>;

const MEMBER_TYPES: OsmMemberType[] = ["node", "way", "relation"];

/**
 * Protobuf wire decoding, kept to the four things the OSM schema actually uses. Varints
 * accumulate by multiplication because JavaScript's bitwise operators are 32-bit and OSM
 * ids passed 2^32 long ago; doubles are exact to 2^53, well past any id or scaled
 * coordinate.
 */
class Reader {
  offset = 0;
  constructor(readonly data: Uint8Array) {}

  get done() {
    return this.offset >= this.data.length;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (this.offset >= this.data.length) throw new Error("PBF varint ran past the end");
      const byte = this.data[this.offset++];
      value += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) return value;
      scale *= 0x80;
      if (scale > 2 ** 56) throw new Error("PBF varint exceeds the supported range");
    }
  }

  /** Protobuf zigzag: positive and negative interleaved so both stay short. */
  zigzag(): number {
    const value = this.varint();
    return value % 2 ? -(value + 1) / 2 : value / 2;
  }

  bytes(): Uint8Array {
    const length = this.varint();
    if (this.offset + length > this.data.length) throw new Error("PBF field ran past the end");
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  /** A length-delimited field read as its own reader, for nested messages and packed arrays. */
  nested(): Reader {
    return new Reader(this.bytes());
  }

  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.offset += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.offset += 4;
    else throw new Error(`PBF wire type ${wire} is not supported`);
  }
}

/** `field, wire` pairs until the message ends. */
function* fields(reader: Reader): Generator<[number, number]> {
  while (!reader.done) {
    const tag = reader.varint();
    yield [tag >> 3, tag & 7];
  }
}

function packed(reader: Reader, read: (r: Reader) => number): number[] {
  const inner = reader.nested();
  const values: number[] = [];
  while (!inner.done) values.push(read(inner));
  return values;
}

function tagsFrom(table: string[], keys: number[], vals: number[]): OsmTags {
  const tags: OsmTags = {};
  for (let i = 0; i < keys.length && i < vals.length; i++) tags[table[keys[i]]] = table[vals[i]];
  return tags;
}

type Block = {
  table: string[];
  granularity: number;
  latOffset: number;
  lonOffset: number;
  groups: Reader[];
};

function readPrimitiveBlock(data: Uint8Array): Block {
  const reader = new Reader(data);
  const block: Block = { table: [], granularity: 100, latOffset: 0, lonOffset: 0, groups: [] };
  const decoder = new TextDecoder();
  for (const [field, wire] of fields(reader)) {
    if (field === 1 && wire === 2) {
      const strings = reader.nested();
      for (const [f, w] of fields(strings)) {
        if (f === 1 && w === 2) block.table.push(decoder.decode(strings.bytes()));
        else strings.skip(w);
      }
    } else if (field === 2 && wire === 2) block.groups.push(reader.nested());
    else if (field === 17 && wire === 0) block.granularity = reader.varint();
    else if (field === 19 && wire === 0) block.latOffset = reader.zigzag();
    else if (field === 20 && wire === 0) block.lonOffset = reader.zigzag();
    else reader.skip(wire);
  }
  return block;
}

/** Scaled integers to degrees, per the block's own granularity and offsets. */
const degrees = (value: number, offset: number, granularity: number) =>
  1e-9 * (offset + granularity * value);

function readDenseNodes(group: Reader, block: Block, visit: OsmVisitor["node"]) {
  let ids: number[] = [];
  let lats: number[] = [];
  let lons: number[] = [];
  let keysVals: number[] = [];
  for (const [field, wire] of fields(group)) {
    if (field === 1 && wire === 2) ids = packed(group, (r) => r.zigzag());
    else if (field === 8 && wire === 2) lats = packed(group, (r) => r.zigzag());
    else if (field === 9 && wire === 2) lons = packed(group, (r) => r.zigzag());
    else if (field === 10 && wire === 2) keysVals = packed(group, (r) => r.varint());
    else group.skip(wire);
  }
  if (!visit) return;
  // Dense nodes delta-encode id, lat and lon against the previous node, and pack every
  // node's tags into one flat array terminated by a zero per node.
  let id = 0, lat = 0, lon = 0, cursor = 0;
  for (let i = 0; i < ids.length; i++) {
    id += ids[i];
    lat += lats[i];
    lon += lons[i];
    const tags: OsmTags = {};
    while (cursor < keysVals.length && keysVals[cursor] !== 0) {
      tags[block.table[keysVals[cursor]]] = block.table[keysVals[cursor + 1]];
      cursor += 2;
    }
    cursor++;
    visit({
      id,
      lon: degrees(lon, block.lonOffset, block.granularity),
      lat: degrees(lat, block.latOffset, block.granularity),
      tags,
    });
  }
}

function readNode(message: Reader, block: Block, visit: OsmVisitor["node"]) {
  let id = 0, lat = 0, lon = 0;
  let keys: number[] = [], vals: number[] = [];
  for (const [field, wire] of fields(message)) {
    if (field === 1 && wire === 0) id = message.zigzag();
    else if (field === 2 && wire === 2) keys = packed(message, (r) => r.varint());
    else if (field === 3 && wire === 2) vals = packed(message, (r) => r.varint());
    else if (field === 8 && wire === 0) lat = message.zigzag();
    else if (field === 9 && wire === 0) lon = message.zigzag();
    else message.skip(wire);
  }
  visit?.({
    id,
    lon: degrees(lon, block.lonOffset, block.granularity),
    lat: degrees(lat, block.latOffset, block.granularity),
    tags: tagsFrom(block.table, keys, vals),
  });
}

function readWay(message: Reader, block: Block, visit: OsmVisitor["way"]) {
  let id = 0;
  let keys: number[] = [], vals: number[] = [], deltas: number[] = [];
  for (const [field, wire] of fields(message)) {
    if (field === 1 && wire === 0) id = message.varint();
    else if (field === 2 && wire === 2) keys = packed(message, (r) => r.varint());
    else if (field === 3 && wire === 2) vals = packed(message, (r) => r.varint());
    else if (field === 8 && wire === 2) deltas = packed(message, (r) => r.zigzag());
    else message.skip(wire);
  }
  if (!visit) return;
  const refs: number[] = [];
  let ref = 0;
  for (const delta of deltas) refs.push((ref += delta));
  visit({ id, refs, tags: tagsFrom(block.table, keys, vals) });
}

function readRelation(message: Reader, block: Block, visit: OsmVisitor["relation"]) {
  let id = 0;
  let keys: number[] = [], vals: number[] = [];
  let roles: number[] = [], deltas: number[] = [], types: number[] = [];
  for (const [field, wire] of fields(message)) {
    if (field === 1 && wire === 0) id = message.varint();
    else if (field === 2 && wire === 2) keys = packed(message, (r) => r.varint());
    else if (field === 3 && wire === 2) vals = packed(message, (r) => r.varint());
    else if (field === 8 && wire === 2) roles = packed(message, (r) => r.varint());
    else if (field === 9 && wire === 2) deltas = packed(message, (r) => r.zigzag());
    else if (field === 10 && wire === 2) types = packed(message, (r) => r.varint());
    else message.skip(wire);
  }
  if (!visit) return;
  const members: OsmMember[] = [];
  let ref = 0;
  for (let i = 0; i < deltas.length; i++) {
    ref += deltas[i];
    members.push({ type: MEMBER_TYPES[types[i]], ref, role: block.table[roles[i]] ?? "" });
  }
  visit({ id, members, tags: tagsFrom(block.table, keys, vals) });
}

function readGroup(group: Reader, block: Block, visit: OsmVisitor) {
  for (const [field, wire] of fields(group)) {
    if (field === 1 && wire === 2) readNode(group.nested(), block, visit.node);
    else if (field === 2 && wire === 2) readDenseNodes(group.nested(), block, visit.node);
    else if (field === 3 && wire === 2) readWay(group.nested(), block, visit.way);
    else if (field === 4 && wire === 2) readRelation(group.nested(), block, visit.relation);
    else group.skip(wire);
  }
}

/** A blob's payload, whichever compression the writer chose. */
async function payload(blob: Uint8Array, inflate: Inflate): Promise<Uint8Array> {
  const reader = new Reader(blob);
  let raw: Uint8Array | undefined;
  let compressed: Uint8Array | undefined;
  for (const [field, wire] of fields(reader)) {
    if (field === 1 && wire === 2) raw = reader.bytes();
    else if (field === 3 && wire === 2) compressed = reader.bytes();
    else if (field === 2 && wire === 0) reader.varint();
    else if (wire === 2) {
      // lzma (4), lz4 (6) and zstd (7) are legal but no OSM tool in this pipeline emits them.
      throw new Error(`PBF blob uses an unsupported compression (field ${field})`);
    } else reader.skip(wire);
  }
  if (raw) return raw;
  if (compressed) return inflate(compressed);
  throw new Error("PBF blob has no payload");
}

/**
 * Walk a `.osm.pbf`, calling back per element. Blobs are decoded one at a time, so peak
 * memory is one decompressed block (a few MB) plus whatever the visitor keeps.
 */
export async function readPbf(
  data: Uint8Array,
  visit: OsmVisitor,
  inflate: Inflate,
): Promise<void> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset < data.length) {
    if (offset + 4 > data.length) throw new Error("PBF ended mid header length");
    const headerLength = view.getInt32(offset, false);
    offset += 4;
    const header = new Reader(data.subarray(offset, offset + headerLength));
    offset += headerLength;
    let type = "";
    let size = 0;
    const decoder = new TextDecoder();
    for (const [field, wire] of fields(header)) {
      if (field === 1 && wire === 2) type = decoder.decode(header.bytes());
      else if (field === 3 && wire === 0) size = header.varint();
      else header.skip(wire);
    }
    const blob = data.subarray(offset, offset + size);
    offset += size;
    if (type !== "OSMData") continue;
    const block = readPrimitiveBlock(await payload(blob, inflate));
    for (const group of block.groups) readGroup(group, block, visit);
  }
}
