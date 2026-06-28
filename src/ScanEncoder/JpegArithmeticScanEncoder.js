// Binary arithmetic (QM-coder) ENCODER — the dual of
// JpegArithmeticScanDecoder.decodeBinaryDecision. Clean-room from the
// rate-distortion / interval-coding semantics of our (verified) decoder; the
// decision logic mirrors libjpeg's jcarith/jdarith register convention.
//
// Output is whole bytes with carry propagated backward over the buffered array,
// then 0xFF -> 0xFF00 marker stuffing (the decoder's JpegBitReader destuffs it).
import { QE_TABLE } from '../ScanDecoder/JpegArithmeticScanDecoder.js';

export class JpegArithmeticScanEncoder {
  constructor() {
    /** @type {number[]} raw (pre-stuffing) output bytes */
    this._raw = [];
    this.reset();
  }

  reset() {
    this._c = 0;
    this._a = 0x10000;
    this._ct = 11;
  }

  /** Encode one binary decision `val` against the context byte `stats[offset]`. */
  encodeBinaryDecision(stats, offset, val) {
    let sv = stats[offset];
    const packed = QE_TABLE[sv & 0x7f];
    const nl = packed & 0xff;
    const nm = (packed >> 8) & 0xff;
    const qe = packed >>> 16;

    this._a -= qe;

    if (val !== (sv >> 7)) {
      // LPS path. When a' >= qe the LPS is the smaller upper sub-interval; when
      // a' < qe a conditional exchange puts the LPS in the larger lower
      // sub-interval, so `a` stays a' (no move).
      if (this._a >= qe) {
        this._c += this._a;
        this._a = qe;
      }
      stats[offset] = (sv & 0x80) ^ nl;
      this._renorm();
    } else {
      // MPS path
      if ((this._a & 0x8000) !== 0) return; // interval still large enough: no renorm
      if (this._a < qe) {
        this._c += this._a;
        this._a = qe;
      }
      stats[offset] = (sv & 0x80) ^ nm;
      this._renorm();
    }
  }

  _renorm() {
    do {
      this._a <<= 1;
      this._c *= 2;
      if (--this._ct === 0) this._byteOut();
    } while (this._a < 0x8000);
  }

  _byteOut() {
    const v = Math.floor(this._c / 0x80000); // top bits above the 19-bit window
    if (v > 0xff) {
      // Carry: propagate +1 backward over the raw bytes (0xFF -> 0x00, ripple).
      let i = this._raw.length - 1;
      while (i >= 0 && this._raw[i] === 0xff) {
        this._raw[i] = 0;
        i--;
      }
      if (i >= 0) this._raw[i] += 1;
    }
    this._raw.push(v & 0xff);
    this._c %= 0x80000;
    this._ct = 8;
  }

  /** Flush the final bits and return the marker-stuffed byte stream. */
  flush() {
    // Drain the C window with a generous tail. The decoder's bit-reader looks
    // ahead up to 4 bytes; emitting 6 trailing bytes guarantees it meets the
    // following marker before exhausting the stream (so its tail accounting never
    // overshoots past the marker — an undershoot self-corrects via marker scan).
    this._c *= 1 << this._ct;
    for (let k = 0; k < 6; k++) {
      this._byteOut();
      this._c *= 256;
    }

    // 0xFF -> 0xFF00 marker stuffing.
    const out = [];
    for (const b of this._raw) {
      out.push(b);
      if (b === 0xff) out.push(0x00);
    }
    return Uint8Array.from(out);
  }
}
