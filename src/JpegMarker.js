// JPEG markers. Faithful port of JpegMarker.cs + JpegMarkerHelper.cs.
// Values are the marker byte (the byte that follows 0xFF).

export const JpegMarker = Object.freeze({
  Padding: 0xff,

  StartOfImage: 0xd8,

  App0: 0xe0,
  App1: 0xe1,
  App2: 0xe2,
  App3: 0xe3,
  App4: 0xe4,
  App5: 0xe5,
  App6: 0xe6,
  App7: 0xe7,
  App8: 0xe8,
  App9: 0xe9,
  App10: 0xea,
  App11: 0xeb,
  App12: 0xec,
  App13: 0xed,
  App14: 0xee,
  App15: 0xef,

  // Start of Frame markers
  StartOfFrame0: 0xc0, // Baseline DCT, Huffman
  StartOfFrame1: 0xc1, // Extended sequential DCT, Huffman
  StartOfFrame2: 0xc2, // Progressive DCT, Huffman
  StartOfFrame3: 0xc3, // Lossless (sequential), Huffman
  StartOfFrame5: 0xc5, // Differential sequential DCT, Huffman
  StartOfFrame6: 0xc6, // Differential progressive DCT, Huffman
  StartOfFrame7: 0xc7, // Differential lossless, Huffman
  StartOfFrame9: 0xc9, // Extended sequential DCT, arithmetic
  StartOfFrame10: 0xca, // Progressive DCT, arithmetic
  StartOfFrame11: 0xcb, // Lossless (sequential), arithmetic
  StartOfFrame13: 0xcd, // Differential sequential DCT, arithmetic
  StartOfFrame14: 0xce, // Differential progressive DCT, arithmetic
  StartOfFrame15: 0xcf, // Differential lossless, arithmetic

  DefineHuffmanTable: 0xc4,
  DefineArithmeticCodingConditioning: 0xcc,
  DefineQuantizationTable: 0xdb,
  DefineNumberOfLines: 0xdc,
  DefineRestartInterval: 0xdd,

  StartOfScan: 0xda,

  DefineRestart0: 0xd0,
  DefineRestart1: 0xd1,
  DefineRestart2: 0xd2,
  DefineRestart3: 0xd3,
  DefineRestart4: 0xd4,
  DefineRestart5: 0xd5,
  DefineRestart6: 0xd6,
  DefineRestart7: 0xd7,

  Comment: 0xfe,
  EndOfImage: 0xd9,
});

/**
 * Whether the marker is one of the 8 restart markers (RST0..RST7).
 * @param {number} marker
 * @returns {boolean}
 */
export function isRestartMarker(marker) {
  return marker >= JpegMarker.DefineRestart0 && marker <= JpegMarker.DefineRestart7;
}

/**
 * Human readable name for a marker byte (best effort, for diagnostics).
 * @param {number} marker
 * @returns {string}
 */
export function markerName(marker) {
  for (const [name, value] of Object.entries(JpegMarker)) {
    if (value === marker) return name;
  }
  return `0x${marker.toString(16).toUpperCase().padStart(2, '0')}`;
}
