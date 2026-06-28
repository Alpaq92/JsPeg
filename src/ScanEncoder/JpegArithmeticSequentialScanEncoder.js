// Arithmetic-coded extended-sequential (SOF9) scan ENCODER — the exact dual of
// JpegArithmeticSequentialScanDecoder._readBlock (T.81 §F.1.4). Reuses the
// verified QM-coder (JpegArithmeticScanEncoder) and mirrors the decoder's
// per-bit context layout so its output decodes identically.
import { JpegArithmeticScanEncoder } from './JpegArithmeticScanEncoder.js';

// Default arithmetic conditioning (T.81). The DAC marker the optimizer writes
// MUST match these, so they are the single source of truth (exported).
export const DEFAULT_DC_L = 0;
export const DEFAULT_DC_U = 1;
export const DEFAULT_AC_KX = 5;

/** Leading-bit position of a positive integer (floor(log2(w))). */
function topBit(w) {
  return 31 - Math.clz32(w);
}

export class JpegArithmeticSequentialScanEncoder {
  /** @param {import('../JpegFrameHeader.js').JpegFrameHeader} frameHeader */
  constructor(frameHeader) {
    this._frameHeader = frameHeader;
    let maxH = 1;
    let maxV = 1;
    for (const c of frameHeader.components) {
      maxH = Math.max(maxH, c.horizontalSamplingFactor);
      maxV = Math.max(maxV, c.verticalSamplingFactor);
    }
    this._maxH = maxH;
    this._maxV = maxV;
    this._mcusPerLine = Math.trunc((frameHeader.samplesPerLine + 8 * maxH - 1) / (8 * maxH));
    this._mcusPerColumn = Math.trunc((frameHeader.numberOfLines + 8 * maxV - 1) / (8 * maxV));

    // Per-component entropy state. Components of the same class (luma vs chroma)
    // share statistics bins, matching how the decoder resolves them.
    this._fixedBin = Uint8Array.of(113, 0, 0, 0);
    const dcStats = [new Uint8Array(64), new Uint8Array(64)];
    const acStats = [new Uint8Array(256), new Uint8Array(256)];
    this._components = frameHeader.components.map((c, i) => {
      const cls = i === 0 ? 0 : 1; // component 0 = luma, rest = chroma
      return {
        index: i,
        h: c.horizontalSamplingFactor,
        v: c.verticalSamplingFactor,
        dcL: DEFAULT_DC_L,
        dcU: DEFAULT_DC_U,
        acKx: DEFAULT_AC_KX,
        dcData: dcStats[cls],
        acData: acStats[cls],
        dcContext: 0,
        dcPredictor: 0,
      };
    });
  }

  /** Encode all blocks (from a JpegBlockAllocator) → entropy byte stream. */
  encode(allocator) {
    const qm = new JpegArithmeticScanEncoder();
    for (const c of this._components) {
      c.dcContext = 0;
      c.dcPredictor = 0;
      c.dcData.fill(0);
      c.acData.fill(0);
    }
    this._fixedBin.fill(0);
    this._fixedBin[0] = 113;

    const buffer = allocator.buffer;
    for (let rowMcu = 0; rowMcu < this._mcusPerColumn; rowMcu++) {
      for (let colMcu = 0; colMcu < this._mcusPerLine; colMcu++) {
        for (const c of this._components) {
          // Block positions are on the component's own grid (matching extraction).
          for (let y = 0; y < c.v; y++) {
            for (let x = 0; x < c.h; x++) {
              const off = allocator.getBlockOffset(c.index, colMcu * c.h + x, rowMcu * c.v + y);
              this._encodeBlock(qm, c, buffer, off);
            }
          }
        }
      }
    }
    return qm.flush();
  }

  _encodeBlock(qm, c, buffer, off) {
    this._encodeDC(qm, c, buffer[off]);
    this._encodeAC(qm, c, buffer, off);
  }

  // DC differential (T.81 §F.1.4.4.1), dual of the decoder's DC path.
  _encodeDC(qm, c, dcValue) {
    const data = c.dcData;
    const st = c.dcContext;
    let v = ((dcValue - c.dcPredictor) << 16) >> 16; // 16-bit signed diff
    c.dcPredictor = ((c.dcPredictor + v) << 16) >> 16;

    if (v === 0) {
      qm.encodeBinaryDecision(data, st, 0);
      c.dcContext = 0;
      return;
    }
    qm.encodeBinaryDecision(data, st, 1);
    const sign = v < 0 ? 1 : 0;
    qm.encodeBinaryDecision(data, st + 1, sign);
    const base = st + 2 + sign;
    const absV = sign ? -v : v;
    const w = absV - 1;

    let m, mantSt;
    if (w === 0) {
      qm.encodeBinaryDecision(data, base, 0); // |v| == 1
      m = 0;
      mantSt = base + 14;
    } else {
      qm.encodeBinaryDecision(data, base, 1);
      const k = topBit(w);
      let sst = 20;
      m = 1;
      for (let i = 0; i < k; i++) {
        qm.encodeBinaryDecision(data, sst, 1);
        m <<= 1;
        sst++;
      }
      qm.encodeBinaryDecision(data, sst, 0); // terminate size loop
      mantSt = sst + 14;
    }

    // DC-context conditioning category (mirrors the decoder).
    if (m < ((1 << c.dcL) >> 1)) c.dcContext = 0;
    else if (m > ((1 << c.dcU) >> 1)) c.dcContext = 12 + sign * 4;
    else c.dcContext = 4 + sign * 4;

    // Magnitude mantissa bits (MSB-first), fixed context.
    let bit = m >> 1;
    while (bit !== 0) {
      qm.encodeBinaryDecision(data, mantSt, w & bit ? 1 : 0);
      bit >>= 1;
    }
  }

  // AC coefficients (T.81 §F.1.4.4.2), dual of the decoder's AC path.
  _encodeAC(qm, c, buffer, off) {
    const data = c.acData;
    let k = 1;
    while (k <= 63) {
      let kn = k;
      while (kn <= 63 && buffer[off + kn] === 0) kn++;
      const eobSt = 3 * (k - 1);
      if (kn > 63) {
        qm.encodeBinaryDecision(data, eobSt, 1); // EOB
        return;
      }
      qm.encodeBinaryDecision(data, eobSt, 0);
      // Zero-run: advance to the nonzero at kn.
      let st = eobSt;
      for (let kk = k; kk < kn; kk++) {
        qm.encodeBinaryDecision(data, st + 1, 0);
        st += 3;
      }
      qm.encodeBinaryDecision(data, st + 1, 1);

      const v = buffer[off + kn];
      const sign = v < 0 ? 1 : 0;
      qm.encodeBinaryDecision(this._fixedBin, 0, sign);
      const base = st + 2;
      const absV = sign ? -v : v;
      const w = absV - 1;

      let m, mantSt;
      if (w === 0) {
        qm.encodeBinaryDecision(data, base, 0); // |v| == 1
        m = 0;
        mantSt = base + 14;
      } else {
        qm.encodeBinaryDecision(data, base, 1);
        const k2 = topBit(w);
        if (k2 === 0) {
          qm.encodeBinaryDecision(data, base, 0); // |v| == 2
          m = 1;
          mantSt = base + 14;
        } else {
          qm.encodeBinaryDecision(data, base, 1);
          let sst = kn <= c.acKx ? 189 : 217;
          m = 2;
          for (let i = 1; i < k2; i++) {
            qm.encodeBinaryDecision(data, sst, 1);
            m <<= 1;
            sst++;
          }
          qm.encodeBinaryDecision(data, sst, 0); // terminate size loop
          mantSt = sst + 14;
        }
      }

      let bit = m >> 1;
      while (bit !== 0) {
        qm.encodeBinaryDecision(data, mantSt, w & bit ? 1 : 0);
        bit >>= 1;
      }

      k = kn + 1;
    }
  }
}
