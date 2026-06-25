// Entropy-coded-segment bit reader. Port of JpegBitReader.cs.
//
// The reference keeps a right-justified 64-bit (`ulong`) buffer. JavaScript
// numbers are IEEE doubles with a 53-bit mantissa, so we keep the buffer as a
// Number but strip stale high bits (left over from previously consumed bits) on
// every refill. The valid bits are always the low `_bitsInBuffer` bits, which
// never exceed 39, comfortably within exact-integer range. Reads mask off any
// bits above the valid window exactly as the C# `& ((1 << length) - 1)` does.

import { isRestartMarker } from './JpegMarker.js';

// Powers of two as exact doubles. Index 0..40 is sufficient (max 39 valid bits).
const POW2 = (() => {
  const a = new Float64Array(41);
  let v = 1;
  for (let i = 0; i <= 40; i++) {
    a[i] = v;
    v *= 2;
  }
  return a;
})();

export class JpegBitReader {
  /** @param {Uint8Array} data the remaining entropy-coded bytes */
  constructor(data) {
    this._data = data;
    this._pos = 0;
    this._buffer = 0; // right-justified bit buffer (low _bitsInBuffer bits valid)
    this._bitsInBuffer = 0;
    this._nextMarker = 0; // 0 = no marker seen yet beyond the buffered bits

    // "out" parameters, set by the read methods (avoids per-call allocation).
    this.bits = 0;
    this.bitsPeeked = 0;
    this.markerEncountered = false;
  }

  get remainingBits() {
    return 8 * (this._data.length - this._pos) + this._bitsInBuffer;
  }

  advanceAlignByte() {
    this._bitsInBuffer -= this._bitsInBuffer % 8;
    this._fillBuffer();
  }

  _tryReadNextByte() {
    if (this._pos >= this._data.length) return -1;
    return this._data[this._pos++];
  }

  _tryPeekNextByte() {
    if (this._pos >= this._data.length) return -1;
    return this._data[this._pos];
  }

  /** Fill the buffer to >= 32 bits, or until the stream ends / a marker appears. */
  _fillBuffer() {
    // Drop stale high bits left behind by previously consumed bits.
    this._buffer = this._buffer % POW2[this._bitsInBuffer];

    while (this._bitsInBuffer < 32) {
      if (this._nextMarker !== 0) {
        return this._bitsInBuffer;
      }
      let byteRead = this._tryReadNextByte();
      if (byteRead < 0) break;

      if (byteRead === 0xff) {
        const peeked = this._tryPeekNextByte();
        if (peeked < 0) break; // stream ended right after 0xFF
        if (peeked === 0xff) {
          // A run of padding 0xFF bytes; consume one and keep going.
          continue;
        }
        // Consume the peeked byte.
        this._tryReadNextByte();
        if (peeked !== 0) {
          // A real marker.
          this._nextMarker = peeked;
          break;
        }
        // 0xFF00 is a stuffed 0xFF byte.
        byteRead = 0xff;
      }

      this._buffer = this._buffer * 256 + byteRead;
      this._bitsInBuffer += 8;
    }
    return this._bitsInBuffer;
  }

  /** Returns the buffered marker and clears it, only when no bits remain buffered. */
  tryReadMarker() {
    if (this._bitsInBuffer === 0) {
      const marker = this._nextMarker;
      this._nextMarker = 0;
      return marker;
    }
    return 0;
  }

  tryPeekMarker() {
    return this._bitsInBuffer === 0 ? this._nextMarker : 0;
  }

  /** Peek `length` bits (1..16). Sets `this.bitsPeeked`. */
  peekBits(length) {
    let bitsInBuffer = this._bitsInBuffer;
    if (bitsInBuffer < length) {
      bitsInBuffer = this._fillBuffer();
      if (bitsInBuffer < length) {
        this.bitsPeeked = bitsInBuffer;
        // Not enough bits: left-align what we have and pad the rest with 1s.
        return (((this._buffer << (length - bitsInBuffer)) & ((1 << length) - 1)) | ((1 << (length - bitsInBuffer)) - 1));
      }
    }
    const remainingBits = bitsInBuffer - length;
    this.bitsPeeked = length;
    return (Math.floor(this._buffer / POW2[remainingBits])) & ((1 << length) - 1);
  }

  /** Discard `length` bits. Sets `this.markerEncountered`. */
  tryAdvanceBits(length) {
    if (this._bitsInBuffer < length) {
      if (!this._tryLoadBits(length)) return false;
    }
    this._bitsInBuffer -= length;
    this.markerEncountered = false;
    return true;
  }

  /** Read `length` bits into `this.bits`. Sets `this.markerEncountered`. */
  tryReadBits(length) {
    if (this._bitsInBuffer < length) {
      if (!this._tryLoadBits(length)) {
        this.bits = 0;
        return false;
      }
    }
    this._bitsInBuffer -= length;
    this.bits = (Math.floor(this._buffer / POW2[this._bitsInBuffer])) & ((1 << length) - 1);
    this.markerEncountered = false;
    return true;
  }

  _tryLoadBits(length) {
    const bitsInBuffer = this._fillBuffer();
    if (bitsInBuffer < length) {
      this.markerEncountered = bitsInBuffer === 0 && this._nextMarker !== 0;
      return false;
    }
    this.markerEncountered = false;
    return true;
  }
}

export { isRestartMarker };
