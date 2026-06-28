// Lossless (SOF3) JPEG encoder — spatial prediction + Huffman of residuals
// (ITU-T T.81 Annex H). The exact dual of JpegHuffmanLosslessScanDecoder: it
// operates on full-resolution sample planes (no DCT, no quantization), so the
// round-trip is exact — decode(encodeLossless(x)) reproduces x's samples.
//
// No color transform is applied. Grayscale is one component; RGB is coded as
// three components tagged 'R','G','B' (0x52/0x47/0x42), which our decoder
// recognizes and passes through without a YCbCr conversion — keeping it lossless.
import { JpegMarker } from './JpegMarker.js';
import { JpegWriter } from './JpegWriter.js';
import { JpegFrameHeader, JpegFrameComponentSpecificationParameters } from './JpegFrameHeader.js';
import { JpegScanHeader, JpegScanComponentSpecificationParameters } from './JpegScanHeader.js';
import { JpegHuffmanEncodingTableBuilderCollection } from './JpegHuffmanEncodingTableBuilderCollection.js';

/** Bits needed to hold a non-negative magnitude (the residual's SSSS category). */
function bitCount(magnitude) {
  return magnitude === 0 ? 0 : 32 - Math.clz32(magnitude);
}

/** Magnitude bits for a signed residual, per RECEIVE/EXTEND. */
function magnitudeBits(value, size) {
  return (value < 0 ? value - 1 : value) & ((1 << size) - 1);
}

/** Reduce a prediction residual modulo 2^16 into [-32768, 32767] (T.81 H.1.2.2). */
function reduceResidual(diff) {
  return ((diff & 0xffff) ^ 0x8000) - 0x8000;
}

/** SSSS category of a reduced residual: 0..15 ordinary, 16 ⇒ |diff| = 32768. */
function categoryOf(residual) {
  return residual === -32768 ? 16 : bitCount(residual < 0 ? -residual : residual);
}

/** The 7 standard predictors (T.81 H.1.2.1): ra=left, rb=above, rc=above-left. */
function predict(predictor, ra, rb, rc) {
  switch (predictor) {
    case 1: return ra;
    case 2: return rb;
    case 3: return rc;
    case 4: return ra + rb - rc;
    case 5: return ra + ((rb - rc) >> 1);
    case 6: return rb + ((ra - rc) >> 1);
    case 7: return (ra + rb) >> 1;
    default: return 0;
  }
}

/** Full-resolution sample planes (no color transform → lossless). */
function extractPlanes(image) {
  const { width, height } = image;
  const data = image.data;
  const channels = image.channels ?? 4;
  const count = width * height;
  const grayscale = image.grayscale || channels === 1;

  if (grayscale) {
    const p = new Int32Array(count);
    for (let i = 0; i < count; i++) p[i] = data[i * channels];
    return { planes: [p], ids: [1] };
  }

  const r = new Int32Array(count);
  const g = new Int32Array(count);
  const b = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    r[i] = data[i * channels];
    g[i] = data[i * channels + 1];
    b[i] = data[i * channels + 2];
  }
  // 'R','G','B' component ids → decoder passes the planes through unconverted.
  return { planes: [r, g, b], ids: [0x52, 0x47, 0x42] };
}

/**
 * Encode an image as a lossless (SOF3) JPEG.
 * @param {{width:number,height:number,data:ArrayLike<number>,channels?:number,grayscale?:boolean,precision?:number}} image
 *   For `precision` > 8, `data` must carry the wider samples (e.g. a Uint16Array).
 * @param {{predictor?:number, precision?:number, mostOptimalCoding?:boolean, grayscale?:boolean}} [options]
 *   `precision` is the sample bit depth, 2..16 (default 8); T.81 Annex H.
 * @returns {Uint8Array}
 */
export function encodeLossless(image, options = {}) {
  const predictor = options.predictor ?? 1;
  if (predictor < 1 || predictor > 7) throw new Error('Lossless predictor must be 1..7.');

  const precision = options.precision ?? image.precision ?? 8;
  if (precision < 2 || precision > 16) throw new Error('Lossless sample precision must be 2..16.');

  const { width, height } = image;
  const { planes, ids } = extractPlanes({ ...image, grayscale: options.grayscale ?? image.grayscale });
  const n = planes.length;
  const initialPrediction = 1 << (precision - 1);

  // Per-component state: its plane, frame id, and Huffman table id (the first
  // component gets table 0, the rest share table 1 — same convention as baseline).
  const components = planes.map((plane, i) => ({ plane, id: ids[i], tableId: i === 0 ? 0 : 1 }));

  // Visit every pixel in MCU (raster, per-component-interleaved) order, computing
  // each residual exactly as the decoder will predict it. `fn(tableId, residual)`.
  const walk = (fn) => {
    for (let row = 0; row < height; row++) {
      const rowBase = row * width;
      for (let col = 0; col < width; col++) {
        const o = rowBase + col;
        for (const c of components) {
          const p = c.plane;
          let prediction;
          if (row === 0) {
            // First line: 2^(P-1) for the first sample, then the horizontal
            // predictor Ra — forced regardless of the selected predictor (T.81 H.1.2.1).
            prediction = col === 0 ? initialPrediction : p[o - 1];
          } else if (col === 0) {
            prediction = p[o - width]; // first column: the vertical predictor Rb
          } else {
            prediction = predict(predictor, p[o - 1], p[o - width], p[o - width - 1]);
          }
          fn(c.tableId, reduceResidual(p[o] - prediction));
        }
      }
    }
  };

  // Pass 1: gather residual-category counts, build optimal Huffman tables.
  const builders = new JpegHuffmanEncodingTableBuilderCollection();
  for (const c of components) builders.getOrCreateTableBuilder(true, c.tableId);
  walk((tableId, residual) => {
    builders.getOrCreateTableBuilder(true, tableId).incrementCodeCount(categoryOf(residual));
  });
  const tables = builders.buildTables(options.mostOptimalCoding ?? false);

  // Assemble the stream: SOI, SOF3, DHT, SOS, entropy, EOI (no DQT — lossless).
  const writer = new JpegWriter();
  writer.writeMarker(JpegMarker.StartOfImage);

  const frameComponents = components.map((c) => new JpegFrameComponentSpecificationParameters(c.id, 1, 1, 0));
  const frameHeader = new JpegFrameHeader(precision, height, width, n, frameComponents);
  writer.writeMarker(JpegMarker.StartOfFrame3);
  writer.writeLength(frameHeader.bytesRequired);
  const frameBuf = new Uint8Array(frameHeader.bytesRequired);
  frameHeader.write(frameBuf, 0);
  writer.writeBytes(frameBuf);

  writer.writeMarker(JpegMarker.DefineHuffmanTable);
  writer.writeLength(tables.getTotalBytesRequired());
  tables.write(writer);

  // SOS: the predictor goes in the spectral-selection-start field (T.81 H.1).
  const scanComponents = components.map((c) => new JpegScanComponentSpecificationParameters(c.id, c.tableId, 0));
  const scanHeader = new JpegScanHeader(n, scanComponents, predictor, 0, 0, 0);
  writer.writeMarker(JpegMarker.StartOfScan);
  writer.writeLength(scanHeader.bytesRequired);
  const scanBuf = new Uint8Array(scanHeader.bytesRequired);
  scanHeader.write(scanBuf, 0);
  writer.writeBytes(scanBuf);

  // Pass 2: emit the Huffman-coded residuals.
  writer.enterBitMode();
  walk((tableId, residual) => {
    const size = categoryOf(residual);
    const table = tables.getTable(true, tableId);
    table.getCode(size);
    writer.writeBits(table.code, table.codeLength);
    // Categories 1..15 carry magnitude bits; 0 and the 16-bit special case (16) don't.
    if (size > 0 && size < 16) writer.writeBits(magnitudeBits(residual, size), size);
  });
  writer.exitBitMode();

  writer.writeMarker(JpegMarker.EndOfImage);
  return writer.toUint8Array().slice();
}
