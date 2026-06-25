// JPEG stream writer. Port of JpegWriter.cs.
//
// The reference uses a left-justified 64-bit register; here we accumulate bits
// right-justified in a small integer and flush whole bytes MSB-first. The two
// schemes emit byte-for-byte identical output: big-endian bit packing with
// 0xFF -> 0xFF 0x00 stuffing and 1-bit padding to the final byte boundary.
import { JpegMarker } from './JpegMarker.js';

export class JpegWriter {
  constructor(initialCapacity = 65536) {
    this._buf = new Uint8Array(initialCapacity);
    this._len = 0;
    this._acc = 0; // right-justified accumulator (low _nbits bits valid)
    this._nbits = 0;
    this._bitMode = false;
  }

  _ensure(extra) {
    if (this._len + extra <= this._buf.length) return;
    let cap = this._buf.length * 2;
    while (cap < this._len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this._buf.subarray(0, this._len));
    this._buf = next;
  }

  _emit(b) {
    if (this._len >= this._buf.length) this._ensure(1);
    this._buf[this._len++] = b;
  }

  writeByte(b) {
    if (this._bitMode) throw new Error('Cannot write bytes in bit mode.');
    this._emit(b & 0xff);
  }

  writeBytes(bytes) {
    if (this._bitMode) throw new Error('Cannot write bytes in bit mode.');
    this._ensure(bytes.length);
    this._buf.set(bytes, this._len);
    this._len += bytes.length;
  }

  writeMarker(marker) {
    if (this._bitMode) throw new Error('Cannot write marker in bit mode.');
    this._ensure(2);
    this._buf[this._len++] = 0xff;
    this._buf[this._len++] = marker & 0xff;
  }

  writeLength(length) {
    if (this._bitMode) throw new Error('Cannot write length in bit mode.');
    const v = (length + 2) & 0xffff;
    this._ensure(2);
    this._buf[this._len++] = (v >> 8) & 0xff;
    this._buf[this._len++] = v & 0xff;
  }

  enterBitMode() {
    this._bitMode = true;
    this._acc = 0;
    this._nbits = 0;
  }

  /** Write `bitLength` right-justified bits (MSB-first into the stream). */
  writeBits(bits, bitLength) {
    if (!this._bitMode) throw new Error('Bit mode is not enabled.');
    if (bitLength === 0) return;
    this._acc = ((this._acc << bitLength) | (bits & ((1 << bitLength) - 1))) >>> 0;
    this._nbits += bitLength;
    while (this._nbits >= 8) {
      this._nbits -= 8;
      const byte = (this._acc >>> this._nbits) & 0xff;
      this._emit(byte);
      if (byte === 0xff) this._emit(0x00); // byte stuffing
    }
    this._acc &= (1 << this._nbits) - 1;
  }

  exitBitMode() {
    if (!this._bitMode) return;
    if (this._nbits > 0) {
      const pad = 8 - this._nbits;
      this.writeBits((1 << pad) - 1, pad); // pad with 1-bits to byte boundary
    }
    this._bitMode = false;
  }

  /** The encoded bytes written so far (a view, not a copy). */
  toUint8Array() {
    return this._buf.subarray(0, this._len);
  }
}

export { JpegMarker };
