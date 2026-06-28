// Arithmetic-coded progressive DCT (SOF10) scan encoder — the exact dual of
// JpegArithmeticProgressiveScanDecoder (T.81 Annex G + the Annex F context model).
// Reuses the verified QM-coder and the same DC/AC context layout as the sequential
// (SOF9) encoder, extended with the progressive point transform (Al) and the
// successive-approximation refinement scans (Ah>0).
//
// Each scan is a single component over its own block grid (non-interleaved), with
// a fresh QM-coder and fresh statistics — mirroring the decoder, which resets both
// at every scan boundary.
import { JpegArithmeticScanEncoder } from './JpegArithmeticScanEncoder.js';
import { DEFAULT_DC_L, DEFAULT_DC_U, DEFAULT_AC_KX } from './JpegArithmeticSequentialScanEncoder.js';

/** Leading-bit position of a positive integer (floor(log2(w))). */
function topBit(w) {
  return 31 - Math.clz32(w);
}

/** AC point transform: divide by 2^al toward zero (T.81 G.1.2.2). */
function pointTransform(coefficient, al) {
  if (al === 0) return coefficient;
  return coefficient >= 0 ? coefficient >> al : -((-coefficient) >> al);
}

/** Absolute value (coefficients are plain JS numbers, not a typed array). */
function absOf(c) {
  return c < 0 ? -c : c;
}

export class JpegArithmeticProgressiveScanEncoder {
  // State lifetime: `_dcPredictor`/`_dcContext` persist across a component's DC
  // scans (first then refine); the statistics banks reset per scan, mirroring the
  // decoder. A fresh QM-coder is used per scan (each scan is its own segment).
  /** @param {import('../JpegFrameHeader.js').JpegFrameHeader} frameHeader */
  constructor(frameHeader) {
    this._frameHeader = frameHeader;
    this._fixedBin = new Uint8Array(4);
    // Statistics shared by component class (luma vs chroma), like the decoder.
    this._dcStats = [new Uint8Array(64), new Uint8Array(64)];
    this._acStats = [new Uint8Array(256), new Uint8Array(256)];
    this._dcPredictor = new Int32Array(frameHeader.numberOfComponents);
    this._dcContext = new Int32Array(frameHeader.numberOfComponents);
  }

  /**
   * Encode one progressive scan (single component) → entropy byte stream.
   * @param {{comp:number, ss:number, se:number, ah:number, al:number}} scan
   * @param {import('../JpegBlockAllocator.js').JpegBlockAllocator} allocator
   */
  encode(scan, allocator) {
    const qm = new JpegArithmeticScanEncoder();
    const cls = scan.comp === 0 ? 0 : 1;
    const info = allocator.componentInfo(scan.comp);
    const buffer = allocator.buffer;
    this._fixedBin.fill(0);
    this._fixedBin[0] = 113; // fixed near-0.5 bin for signs / refinement bits

    if (scan.ss === 0) {
      const dcData = this._dcStats[cls];
      if (scan.ah === 0) {
        dcData.fill(0);
        this._dcPredictor[scan.comp] = 0;
        this._dcContext[scan.comp] = 0;
        this._forEachBlock(info, (bx, by) =>
          this._encodeDCFirst(qm, scan, dcData, buffer, allocator.getBlockOffset(scan.comp, bx, by)));
      } else {
        this._forEachBlock(info, (bx, by) => {
          const off = allocator.getBlockOffset(scan.comp, bx, by);
          qm.encodeBinaryDecision(this._fixedBin, 0, (buffer[off] >> scan.al) & 1);
        });
      }
    } else {
      const acData = this._acStats[cls];
      acData.fill(0);
      this._forEachBlock(info, (bx, by) => {
        const off = allocator.getBlockOffset(scan.comp, bx, by);
        if (scan.ah === 0) this._encodeACFirst(qm, scan, acData, buffer, off);
        else this._encodeACRefine(qm, scan, acData, buffer, off);
      });
    }
    return qm.flush();
  }

  _forEachBlock(info, fn) {
    for (let by = 0; by < info.vBlocks; by++) {
      for (let bx = 0; bx < info.hBlocks; bx++) fn(bx, by);
    }
  }

  // DC first scan (Ah=0): differential, point-transformed by Al. Identical context
  // layout to the sequential DC encoder.
  _encodeDCFirst(qm, scan, data, buffer, off) {
    const comp = scan.comp;
    const dc = buffer[off] >> scan.al; // arithmetic point transform
    const v = ((dc - this._dcPredictor[comp]) << 16) >> 16;
    this._dcPredictor[comp] = ((this._dcPredictor[comp] + v) << 16) >> 16;
    const st = this._dcContext[comp];

    if (v === 0) {
      qm.encodeBinaryDecision(data, st, 0);
      this._dcContext[comp] = 0;
      return;
    }
    qm.encodeBinaryDecision(data, st, 1);
    const sign = v < 0 ? 1 : 0;
    qm.encodeBinaryDecision(data, st + 1, sign);
    const base = st + 2 + sign;
    const w = (sign ? -v : v) - 1;

    let m, mantSt;
    if (w === 0) {
      qm.encodeBinaryDecision(data, base, 0);
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
      qm.encodeBinaryDecision(data, sst, 0);
      mantSt = sst + 14;
    }

    if (m < ((1 << DEFAULT_DC_L) >> 1)) this._dcContext[comp] = 0;
    else if (m > ((1 << DEFAULT_DC_U) >> 1)) this._dcContext[comp] = 12 + sign * 4;
    else this._dcContext[comp] = 4 + sign * 4;

    for (let bit = m >> 1; bit !== 0; bit >>= 1) {
      qm.encodeBinaryDecision(data, mantSt, w & bit ? 1 : 0);
    }
  }

  // AC first scan (Ah=0) over the band [ss, se], point-transformed by Al. Identical
  // context layout to the sequential AC encoder, with EOB at the end of the band.
  _encodeACFirst(qm, scan, data, buffer, off) {
    const { ss, se, al } = scan;
    let k = ss;
    while (k <= se) {
      let kn = k;
      let v = 0;
      while (kn <= se && (v = pointTransform(buffer[off + kn], al)) === 0) kn++;
      const eobSt = 3 * (k - 1);
      if (kn > se) {
        qm.encodeBinaryDecision(data, eobSt, 1); // end of band
        return;
      }
      qm.encodeBinaryDecision(data, eobSt, 0);
      let st = eobSt;
      for (let kk = k; kk < kn; kk++) {
        qm.encodeBinaryDecision(data, st + 1, 0);
        st += 3;
      }
      qm.encodeBinaryDecision(data, st + 1, 1);

      // v already holds pointTransform(buffer[off + kn], al) from the scan above.
      const sign = v < 0 ? 1 : 0;
      qm.encodeBinaryDecision(this._fixedBin, 0, sign);
      const base = st + 2;
      const w = (sign ? -v : v) - 1;

      let m, mantSt;
      if (w === 0) {
        qm.encodeBinaryDecision(data, base, 0);
        m = 0;
        mantSt = base + 14;
      } else {
        qm.encodeBinaryDecision(data, base, 1);
        const k2 = topBit(w);
        if (k2 === 0) {
          qm.encodeBinaryDecision(data, base, 0);
          m = 1;
          mantSt = base + 14;
        } else {
          qm.encodeBinaryDecision(data, base, 1);
          let sst = kn <= DEFAULT_AC_KX ? 189 : 217;
          m = 2;
          for (let i = 1; i < k2; i++) {
            qm.encodeBinaryDecision(data, sst, 1);
            m <<= 1;
            sst++;
          }
          qm.encodeBinaryDecision(data, sst, 0);
          mantSt = sst + 14;
        }
      }

      for (let bit = m >> 1; bit !== 0; bit >>= 1) {
        qm.encodeBinaryDecision(data, mantSt, w & bit ? 1 : 0);
      }
      k = kn + 1;
    }
  }

  // AC refinement scan (Ah>0): per-coefficient correction / newly-significant
  // coding, the dual of _readBlockProgressiveACRefined. `al` is the bit being added.
  _encodeACRefine(qm, scan, data, buffer, off) {
    const { ss, se, al } = scan;

    // One backward pass finds both bounds:
    //   kex  = highest index already significant (a bit at or above al+1), or 0;
    //   knew = highest index that becomes significant exactly at plane al, or ss-1.
    // Beyond kex only newly-significant coefficients can appear, so end-of-band is
    // simply "k has passed knew".
    let kex = 0;
    let knew = ss - 1;
    for (let j = se; j >= 1; j--) {
      const a = absOf(buffer[off + j]);
      if ((a >> (al + 1)) !== 0) {
        if (kex === 0) kex = j;
      } else if (j >= ss && (a >> al) !== 0 && knew < ss) {
        knew = j;
      }
    }

    for (let k = ss; k <= se; k++) {
      let st = 3 * (k - 1);
      if (k > kex) {
        if (k > knew) {
          qm.encodeBinaryDecision(data, st, 1); // end of band
          return;
        }
        qm.encodeBinaryDecision(data, st, 0);
      }
      for (;;) {
        const c = buffer[off + k];
        const a = absOf(c);
        if ((a >> (al + 1)) !== 0) {
          // Already significant: emit the correction bit (bit al of the magnitude).
          qm.encodeBinaryDecision(data, st + 2, (a >> al) & 1);
          break;
        }
        if ((a >> al) !== 0) {
          // Newly significant at this bit-plane (magnitude became 1).
          qm.encodeBinaryDecision(data, st + 1, 1);
          qm.encodeBinaryDecision(this._fixedBin, 0, c < 0 ? 1 : 0);
          break;
        }
        // Still zero here: advance within the run.
        qm.encodeBinaryDecision(data, st + 1, 0);
        st += 3;
        k++;
      }
    }
  }
}
