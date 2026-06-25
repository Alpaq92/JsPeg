// Standard JPEG quantization tables + quality scaling. Port of JpegStandardQuantizationTable.cs.
import { JpegQuantizationTable } from './JpegQuantizationTable.js';
import { clamp } from './JpegMathHelper.js';

// Standard luminance/chrominance tables, in zig-zag order (Annex K of the spec,
// matching the reference implementation).
const s_luminanceTable = Uint16Array.of(
  16, 11, 12, 14, 12, 10, 16, 14,
  13, 14, 18, 17, 16, 19, 24, 40,
  26, 24, 22, 22, 24, 49, 35, 37,
  29, 40, 58, 51, 61, 60, 57, 51,
  56, 55, 64, 72, 92, 78, 64, 68,
  87, 69, 55, 56, 80, 109, 81, 87,
  95, 98, 103, 104, 103, 62, 77, 113,
  121, 112, 100, 120, 92, 101, 103, 99,
);

const s_chrominanceTable = Uint16Array.of(
  17, 18, 18, 24, 21, 24, 47, 26,
  26, 47, 99, 66, 56, 66, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
);

export const JpegStandardQuantizationTable = {
  /** Standard luminance quantization table. */
  getLuminanceTable(elementPrecision = 0, identifier = 0) {
    return new JpegQuantizationTable(elementPrecision, identifier, Uint16Array.from(s_luminanceTable));
  },

  /** Standard chrominance quantization table. */
  getChrominanceTable(elementPrecision = 0, identifier = 0) {
    return new JpegQuantizationTable(elementPrecision, identifier, Uint16Array.from(s_chrominanceTable));
  },

  /**
   * Scale a (standard) quantization table to a quality factor in [0, 100].
   * @param {JpegQuantizationTable} quantizationTable
   * @param {number} quality
   * @returns {JpegQuantizationTable}
   */
  scaleByQuality(quantizationTable, quality) {
    if (!quantizationTable || quantizationTable.isEmpty) {
      throw new Error('Quantization table is not initialized.');
    }
    if ((quality >>> 0) > 100) throw new RangeError('quality');

    const scale = quality < 50 ? Math.trunc(5000 / quality) : 200 - quality * 2;

    const source = quantizationTable.elements;
    const elements = new Uint16Array(64);
    for (let i = 0; i < 64; i++) {
      let x = source[i];
      x = Math.trunc((x * scale + 50) / 100);
      elements[i] = clamp(x, 1, 255);
    }
    return new JpegQuantizationTable(quantizationTable.elementPrecision, quantizationTable.identifier, elements);
  },
};
