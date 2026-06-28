// Base class for arithmetic (QM-coder) scan decoders. Port of
// JpegArithmeticScanDecoder.cs — the binary arithmetic decoder (ISO/IEC 10918-1
// Annex D / ITU-T T.81), the Qe probability-estimation state table, and
// component initialisation. SOF9 (sequential) and SOF10 (progressive) extend it.
//
// All register math mirrors the C# `int` (32-bit signed) semantics via `| 0`.
import { JpegArithmeticStatistics } from '../JpegArithmeticStatistics.js';
import { throwInvalidData } from './common.js';

export class JpegArithmeticDecodingComponent {
  constructor() {
    this.componentIndex = 0;
    this.horizontalSamplingFactor = 0;
    this.verticalSamplingFactor = 0;
    this.dcPredictor = 0;
    this.dcTable = null;
    this.acTable = null;
    this.quantizationTable = null;
    this.horizontalSubsamplingFactor = 0;
    this.verticalSubsamplingFactor = 0;
    this.dcContext = 0;
    this.dcStatistics = null;
    this.acStatistics = null;
  }
}

// Qe table rows as [Qe, NLPS, NMPS, SWITCH] (ITU-T T.81 Table D.3), packed the
// way the reference does: Qe<<16 | NMPS<<8 | (SWITCH<<7 | NLPS).
const QE_ROWS = [
  [0x5a1d, 1, 1, 1], [0x2586, 14, 2, 0], [0x1114, 16, 3, 0], [0x080b, 18, 4, 0],
  [0x03d8, 20, 5, 0], [0x01da, 23, 6, 0], [0x00e5, 25, 7, 0], [0x006f, 28, 8, 0],
  [0x0036, 30, 9, 0], [0x001a, 33, 10, 0], [0x000d, 35, 11, 0], [0x0006, 9, 12, 0],
  [0x0003, 10, 13, 0], [0x0001, 12, 13, 0], [0x5a7f, 15, 15, 1], [0x3f25, 36, 16, 0],
  [0x2cf2, 38, 17, 0], [0x207c, 39, 18, 0], [0x17b9, 40, 19, 0], [0x1182, 42, 20, 0],
  [0x0cef, 43, 21, 0], [0x09a1, 45, 22, 0], [0x072f, 46, 23, 0], [0x055c, 48, 24, 0],
  [0x0406, 49, 25, 0], [0x0303, 51, 26, 0], [0x0240, 52, 27, 0], [0x01b1, 54, 28, 0],
  [0x0144, 56, 29, 0], [0x00f5, 57, 30, 0], [0x00b7, 59, 31, 0], [0x008a, 60, 32, 0],
  [0x0068, 62, 33, 0], [0x004e, 63, 34, 0], [0x003b, 32, 35, 0], [0x002c, 33, 9, 0],
  [0x5ae1, 37, 37, 1], [0x484c, 64, 38, 0], [0x3a0d, 65, 39, 0], [0x2ef1, 67, 40, 0],
  [0x261f, 68, 41, 0], [0x1f33, 69, 42, 0], [0x19a8, 70, 43, 0], [0x1518, 72, 44, 0],
  [0x1177, 73, 45, 0], [0x0e74, 74, 46, 0], [0x0bfb, 75, 47, 0], [0x09f8, 77, 48, 0],
  [0x0861, 78, 49, 0], [0x0706, 79, 50, 0], [0x05cd, 48, 51, 0], [0x04de, 50, 52, 0],
  [0x040f, 50, 53, 0], [0x0363, 51, 54, 0], [0x02d4, 52, 55, 0], [0x025c, 53, 56, 0],
  [0x01f8, 54, 57, 0], [0x01a4, 55, 58, 0], [0x0160, 56, 59, 0], [0x0125, 57, 60, 0],
  [0x00f6, 58, 61, 0], [0x00cb, 59, 62, 0], [0x00ab, 61, 63, 0], [0x008f, 61, 32, 0],
  [0x5b12, 65, 65, 1], [0x4d04, 80, 66, 0], [0x412c, 81, 67, 0], [0x37d8, 82, 68, 0],
  [0x2fe8, 83, 69, 0], [0x293c, 84, 70, 0], [0x2379, 86, 71, 0], [0x1edf, 87, 72, 0],
  [0x1aa9, 87, 73, 0], [0x174e, 72, 74, 0], [0x1424, 72, 75, 0], [0x119c, 74, 76, 0],
  [0x0f6b, 74, 77, 0], [0x0d51, 75, 78, 0], [0x0bb6, 77, 79, 0], [0x0a40, 77, 48, 0],
  [0x5832, 80, 81, 1], [0x4d1c, 88, 82, 0], [0x438e, 89, 83, 0], [0x3bdd, 90, 84, 0],
  [0x34ee, 91, 85, 0], [0x2eae, 92, 86, 0], [0x299a, 93, 87, 0], [0x2516, 86, 71, 0],
  [0x5570, 88, 89, 1], [0x4ca9, 95, 90, 0], [0x44d9, 96, 91, 0], [0x3e22, 97, 92, 0],
  [0x3824, 99, 93, 0], [0x32b4, 99, 94, 0], [0x2e17, 93, 86, 0], [0x56a8, 95, 96, 1],
  [0x4f46, 101, 97, 0], [0x47e5, 102, 98, 0], [0x41cf, 103, 99, 0], [0x3c3d, 104, 100, 0],
  [0x375e, 99, 93, 0], [0x5231, 105, 102, 0], [0x4c0f, 106, 103, 0], [0x4639, 107, 104, 0],
  [0x415e, 103, 99, 0], [0x5627, 105, 106, 1], [0x50e7, 108, 107, 0], [0x4b85, 109, 103, 0],
  [0x5597, 110, 109, 0], [0x504f, 111, 107, 0], [0x5a10, 110, 111, 1], [0x5522, 112, 109, 0],
  [0x59eb, 112, 111, 1],
  // Fixed 0.5-probability estimate (T.851 §10.3 Table 5).
  [0x5a1d, 113, 113, 0],
];

export const QE_TABLE = Int32Array.from(QE_ROWS, ([qe, nlps, nmps, sw]) => (qe << 16) | (nmps << 8) | (sw << 7) | nlps);

export class JpegArithmeticScanDecoder {
  constructor(decoder) {
    this._decoder = decoder;
    // The fixed bin for sign / 0.5-probability decisions (state 113).
    this._fixedBin = Uint8Array.of(113, 0, 0, 0);
    /** @type {JpegArithmeticStatistics[]} */
    this._statistics = [];
    this.reset(); // establishes _c / _a / _ct
  }

  reset() {
    this._c = 0;
    this._a = 0;
    this._ct = -16; // forces reading 2 initial bytes to fill the C register
  }

  _createOrGetStatisticsBin(dc, identifier) {
    for (const item of this._statistics) {
      if (item.dc === dc && item.identifier === identifier) return item;
    }
    const statistics = new JpegArithmeticStatistics(dc, identifier);
    this._statistics.push(statistics);
    return statistics;
  }

  /** Resolve scan components against the frame header. @returns component count */
  initDecodeComponents(frameHeader, scanHeader, components) {
    let maxHorizontalSampling = 1;
    let maxVerticalSampling = 1;
    for (const c of frameHeader.components) {
      maxHorizontalSampling = Math.max(maxHorizontalSampling, c.horizontalSamplingFactor);
      maxVerticalSampling = Math.max(maxVerticalSampling, c.verticalSamplingFactor);
    }

    if (components.length < scanHeader.numberOfComponents) throw new Error('Not enough component slots.');

    for (let i = 0; i < scanHeader.numberOfComponents; i++) {
      const scanComponent = scanHeader.components[i];
      let componentIndex = 0;
      let frameComponent = null;
      for (let j = 0; j < frameHeader.numberOfComponents; j++) {
        if (scanComponent.scanComponentSelector === frameHeader.components[j].identifier) {
          componentIndex = j;
          frameComponent = frameHeader.components[j];
        }
      }
      if (frameComponent === null) throwInvalidData('The specified component is missing.');

      let component = components[i];
      if (component == null) components[i] = component = new JpegArithmeticDecodingComponent();

      const dcTable = this._decoder.getArithmeticTable(true, scanComponent.dcEntropyCodingTableSelector);
      const acTable = this._decoder.getArithmeticTable(false, scanComponent.acEntropyCodingTableSelector);
      component.componentIndex = componentIndex;
      component.horizontalSamplingFactor = frameComponent.horizontalSamplingFactor;
      component.verticalSamplingFactor = frameComponent.verticalSamplingFactor;
      component.dcTable = dcTable;
      component.acTable = acTable;
      component.quantizationTable = this._decoder.getQuantizationTable(frameComponent.quantizationTableSelector);
      component.horizontalSubsamplingFactor = Math.trunc(maxHorizontalSampling / component.horizontalSamplingFactor);
      component.verticalSubsamplingFactor = Math.trunc(maxVerticalSampling / component.verticalSamplingFactor);
      component.dcPredictor = 0;
      component.dcContext = 0;
      component.dcStatistics = dcTable == null ? null : this._createOrGetStatisticsBin(true, dcTable.identifier);
      component.acStatistics = acTable == null ? null : this._createOrGetStatisticsBin(false, acTable.identifier);
    }

    return scanHeader.numberOfComponents;
  }

  /**
   * Decode one binary decision against the statistics byte at `stats[offset]`.
   * Reads data bytes from the bit reader during renormalization.
   * @returns {number} the decoded bit (0 or 1)
   */
  decodeBinaryDecision(reader, stats, offset) {
    // Renormalization & data input (T.81 §D.2.6).
    while (this._a < 0x8000) {
      if (--this._ct < 0) {
        reader.tryReadBits(8);
        this._c = ((this._c << 8) | reader.bits) | 0;
        this._ct += 8;
        if (this._ct < 0) {
          if (++this._ct === 0) this._a = 0x8000;
        }
      }
      this._a = (this._a << 1) | 0;
    }

    let sv = stats[offset];
    const packed = QE_TABLE[sv & 0x7f];
    const nl = packed & 0xff; // SWITCH<<7 | Next_Index_LPS
    const nm = (packed >> 8) & 0xff; // Next_Index_MPS
    const qe = packed >>> 16;

    // Decode & estimation (T.81 §D.2.4 & §D.2.5). `_a` is left as (a - qe) for
    // the conditional-exchange test, then set to qe in the chosen branch.
    let temp = (this._a - qe) | 0;
    this._a = temp;
    temp = (temp << this._ct) | 0;

    if (this._c >= temp) {
      this._c = (this._c - temp) | 0;
      if (this._a < qe) {
        // Conditional LPS exchange
        this._a = qe;
        stats[offset] = (sv & 0x80) ^ nm; // Estimate_after_MPS
      } else {
        this._a = qe;
        stats[offset] = (sv & 0x80) ^ nl; // Estimate_after_LPS
        sv ^= 0x80; // exchange LPS/MPS
      }
    } else if (this._a < 0x8000) {
      // Conditional MPS exchange
      if (this._a < qe) {
        stats[offset] = (sv & 0x80) ^ nl; // Estimate_after_LPS
        sv ^= 0x80;
      } else {
        stats[offset] = (sv & 0x80) ^ nm; // Estimate_after_MPS
      }
    }

    return sv >> 7;
  }
}
