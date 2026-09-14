/** LEB128 varints and zigzag, the primitives the block format is built from. */

export class ByteWriter {
  private buffer: Uint8Array;
  private length = 0;

  constructor(capacity = 1024) {
    this.buffer = new Uint8Array(capacity);
  }

  private reserve(extra: number) {
    if (this.length + extra <= this.buffer.length) return;
    let capacity = this.buffer.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  byte(value: number) {
    this.reserve(1);
    this.buffer[this.length++] = value & 0xff;
  }

  u16(value: number) {
    this.reserve(2);
    this.buffer[this.length++] = value & 0xff;
    this.buffer[this.length++] = (value >>> 8) & 0xff;
  }

  u32(value: number) {
    this.reserve(4);
    for (let i = 0; i < 4; i++)
      this.buffer[this.length++] = (value >>> (i * 8)) & 0xff;
  }

  /** Non-negative integers up to 2^53. */
  varint(value: number) {
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`varint requires a non-negative integer, got ${value}`);
    let rest = value;
    while (rest >= 0x80) {
      this.byte((rest % 0x80) + 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.byte(rest);
  }

  /** Signed integers, small magnitudes staying short. */
  zigzag(value: number) {
    this.varint(value < 0 ? -2 * value - 1 : 2 * value);
  }

  bytes(value: Uint8Array) {
    this.reserve(value.length);
    this.buffer.set(value, this.length);
    this.length += value.length;
  }

  text(value: string) {
    const encoded = new TextEncoder().encode(value);
    this.varint(encoded.length);
    this.bytes(encoded);
  }

  get size() {
    return this.length;
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

export class ByteReader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  private need(count: number) {
    if (this.offset + count > this.data.length)
      throw new Error("Ibex read past end of block");
  }

  byte(): number {
    this.need(1);
    return this.data[this.offset++];
  }

  u16(): number {
    this.need(2);
    const value = this.data[this.offset] | (this.data[this.offset + 1] << 8);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    let value = 0;
    for (let i = 0; i < 4; i++) value += this.data[this.offset + i] * 2 ** (i * 8);
    this.offset += 4;
    return value;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.byte();
      value += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) return value;
      scale *= 0x80;
    }
    throw new Error("Ibex varint exceeds the supported range");
  }

  zigzag(): number {
    const value = this.varint();
    return value % 2 ? -(value + 1) / 2 : value / 2;
  }

  raw(count: number): Uint8Array {
    this.need(count);
    const slice = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  text(): string {
    return new TextDecoder().decode(this.raw(this.varint()));
  }

  get position() {
    return this.offset;
  }

  get remaining() {
    return this.data.length - this.offset;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

/** Guards a single byte-range read, which the whole-file manifest hash cannot cover. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++)
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
