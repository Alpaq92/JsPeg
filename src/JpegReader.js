// Reads markers and segments from a JPEG byte stream. Port of JpegReader.cs.
//
// The C# version works over a ReadOnlySequence<byte> (possibly multi-segment).
// In JavaScript we always have a single contiguous Uint8Array, so this is
// modelled as a buffer + read offset, which preserves every observable behaviour.
import { JpegMarker } from './JpegMarker.js';

export class JpegReader {
  /** @param {Uint8Array} data */
  constructor(data) {
    this._data = data;
    this._offset = 0;
    this._initialLength = data.length;
  }

  get isEmpty() {
    return this._offset >= this._data.length;
  }

  get remainingByteCount() {
    return this._data.length - this._offset;
  }

  get consumedByteCount() {
    return this._initialLength - this.remainingByteCount;
  }

  /** Remaining bytes as a view (no copy). */
  get remainingBytes() {
    return this._data.subarray(this._offset);
  }

  /** Read the StartOfImage marker (0xFFD8) if present. */
  tryReadStartOfImageMarker() {
    if (this.remainingByteCount < 2) return false;
    const data = this._data;
    const o = this._offset;
    if (data[o] === JpegMarker.Padding && data[o + 1] === JpegMarker.StartOfImage) {
      this._offset += 2;
      return true;
    }
    return false;
  }

  /**
   * Read the next marker. Returns the marker byte, or 0 when no marker is found.
   */
  tryReadMarker() {
    const data = this._data;
    while (this._data.length - this._offset >= 2) {
      const b1 = data[this._offset];
      const b2 = data[this._offset + 1];

      if (b1 === JpegMarker.Padding) {
        if (b2 === JpegMarker.Padding) {
          this._offset += 1;
          continue;
        } else if (b2 === 0) {
          this._offset += 2;
          continue;
        }
        this._offset += 2;
        return b2;
      }

      // b1 is not 0xFF: skip forward to the next 0xFF byte.
      let pos = -1;
      for (let i = this._offset; i < data.length; i++) {
        if (data[i] === JpegMarker.Padding) {
          pos = i;
          break;
        }
      }
      if (pos < 0) {
        this._offset = data.length;
        return 0;
      }
      this._offset = pos;
    }
    return 0;
  }

  /**
   * Read a 2-byte big-endian length field and return (length - 2), i.e. the
   * payload length. Returns -1 if fewer than 2 bytes remain.
   *
   * Note: this faithfully reproduces the reference's subtraction, which (because
   * of C# operator precedence) computes `(b0 << 8) | (b1 - 2)` truncated to 16
   * bits. For all real segment lengths this equals `((b0 << 8) | b1) - 2`.
   */
  tryReadLength() {
    if (this.remainingByteCount < 2) return -1;
    const o = this._offset;
    const length = ((this._data[o] << 8) | (this._data[o + 1] - 2)) & 0xffff;
    this._offset += 2;
    return length;
  }

  /** Like tryReadLength but does not advance. Returns -1 on failure. */
  tryPeekLength() {
    if (this.remainingByteCount < 2) return -1;
    const o = this._offset;
    return ((this._data[o] << 8) | (this._data[o + 1] - 2)) & 0xffff;
  }

  /** Read `length` bytes as a view and advance. Returns null on failure. */
  tryReadBytes(length) {
    if (this.remainingByteCount < length) return null;
    const bytes = this._data.subarray(this._offset, this._offset + length);
    this._offset += length;
    return bytes;
  }

  /** Peek `length` bytes as a view without advancing. Returns null on failure. */
  tryPeekBytes(length) {
    if (this.remainingByteCount < length) return null;
    return this._data.subarray(this._offset, this._offset + length);
  }

  /** Advance the stream by `length` bytes. Returns false if not enough remain. */
  tryAdvance(length) {
    if (this.remainingByteCount < length) return false;
    this._offset += length;
    return true;
  }
}
