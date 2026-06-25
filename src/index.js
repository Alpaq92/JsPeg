// JsPeg — a pure-JavaScript JPEG decoder/encoder/optimizer.
// Faithful port of yigolden/JpegLibrary, plus a small convenience API.

export { JpegDecoder } from './JpegDecoder.js';
export { JpegMarker, isRestartMarker, markerName } from './JpegMarker.js';
export { JpegFrameHeader, JpegFrameComponentSpecificationParameters } from './JpegFrameHeader.js';
export { JpegScanHeader, JpegScanComponentSpecificationParameters } from './JpegScanHeader.js';
export { JpegQuantizationTable } from './JpegQuantizationTable.js';
export { JpegStandardQuantizationTable } from './JpegStandardQuantizationTable.js';
export { JpegHuffmanDecodingTable } from './JpegHuffmanDecodingTable.js';
export { JpegElementPrecision } from './JpegElementPrecision.js';
export { JpegReader } from './JpegReader.js';
export { JpegBlockOutputWriter } from './JpegBlockOutputWriter.js';
export { JpegBufferOutputWriter } from './output/JpegBufferOutputWriter.js';
export { JpegEncoder } from './JpegEncoder.js';
export { JpegBlockInputReader } from './JpegBlockInputReader.js';
export { JpegBufferInputReader } from './input/JpegBufferInputReader.js';
export { JpegHuffmanEncodingTable } from './JpegHuffmanEncodingTable.js';
export { JpegHuffmanEncodingTableBuilder } from './JpegHuffmanEncodingTableBuilder.js';
export { JpegStandardHuffmanEncodingTable } from './JpegStandardHuffmanEncodingTable.js';
export { JpegWriter } from './JpegWriter.js';
export { JpegOptimizer } from './JpegOptimizer.js';
export {
  componentsToRGBA, readAdobeTransform, rgbToYCbCrPlanes, rgbToGrayPlane, buildJfifApp0,
} from './colorConverter.js';

import { JpegDecoder } from './JpegDecoder.js';
import { JpegEncoder } from './JpegEncoder.js';
import { JpegOptimizer } from './JpegOptimizer.js';
import { JpegBufferOutputWriter } from './output/JpegBufferOutputWriter.js';
import { JpegBufferInputReader } from './input/JpegBufferInputReader.js';
import { JpegStandardQuantizationTable } from './JpegStandardQuantizationTable.js';
import { JpegStandardHuffmanEncodingTable } from './JpegStandardHuffmanEncodingTable.js';
import {
  componentsToRGBA, readAdobeTransform, rgbToYCbCrPlanes, rgbToGrayPlane, buildJfifApp0,
} from './colorConverter.js';

/** Coerce common inputs (ArrayBuffer, Buffer, typed array) to a Uint8Array. */
function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Expected a Uint8Array, ArrayBuffer or typed array.');
}

/**
 * Decode a JPEG into raw component planes plus image metadata.
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{
 *   width: number, height: number, precision: number,
 *   numberOfComponents: number, componentIds: number[],
 *   components: Int16Array[], adobeTransform: number|null,
 *   quality: number|null, progressive: boolean, startOfFrame: number
 * }}
 */
export function decodeComponents(input) {
  const data = toUint8Array(input);
  const decoder = new JpegDecoder();
  decoder.setInput(data);
  decoder.identify(true);

  const width = decoder.width;
  const height = decoder.height;
  const numberOfComponents = decoder.numberOfComponents;

  const writer = new JpegBufferOutputWriter(width, height, numberOfComponents);
  decoder.setOutputWriter(writer);
  decoder.decode();

  const frameHeader = decoder._frameHeader;
  const componentIds = frameHeader.components.map((c) => c.identifier);
  const q = decoder.tryEstimateQuality();

  return {
    width,
    height,
    precision: decoder.precision,
    numberOfComponents,
    componentIds,
    components: writer.components,
    adobeTransform: readAdobeTransform(data),
    quality: q.ok ? q.quality : null,
    progressive: decoder.startOfFrame === 0xc2,
    startOfFrame: decoder.startOfFrame,
  };
}

/**
 * Decode a JPEG into an interleaved RGBA buffer (canvas ImageData compatible).
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }}
 */
export function decode(input) {
  const result = decodeComponents(input);
  const rgba = componentsToRGBA({
    width: result.width,
    height: result.height,
    components: result.components,
    componentIds: result.componentIds,
    adobeTransform: result.adobeTransform,
  });
  return { ...result, data: rgba };
}

const SUBSAMPLING = {
  '4:4:4': [1, 1],
  '4:2:2': [2, 1],
  '4:2:0': [2, 2],
};

/**
 * Encode an image to a baseline JPEG byte stream.
 *
 * @param {object} image
 *   `{ width, height, data, channels? }` with interleaved samples (channels
 *   defaults to 4 = RGBA), or `{ width, height, components: plane[] }` with raw
 *   full-resolution component planes (1 = grayscale, 3 = YCbCr).
 * @param {object} [options]
 * @param {number} [options.quality=75] 1..100
 * @param {'4:4:4'|'4:2:2'|'4:2:0'} [options.subsampling='4:2:0'] chroma subsampling
 * @param {boolean} [options.optimizeCoding=false] build image-specific Huffman tables
 * @param {boolean} [options.mostOptimalCoding=false] use the package-merge algorithm
 * @param {boolean} [options.grayscale] force single-component output
 * @param {boolean} [options.jfif=true] prepend a JFIF APP0 segment
 * @returns {Uint8Array} the encoded JPEG
 */
export function encode(image, options = {}) {
  const { width, height } = image;
  const quality = options.quality ?? 75;
  const subsampling = options.subsampling ?? '4:2:0';
  const optimize = options.optimizeCoding ?? false;
  const jfif = options.jfif ?? true;
  const grayscale = options.grayscale
    ?? (image.channels === 1 || (Array.isArray(image.components) && image.components.length === 1));

  const encoder = new JpegEncoder();
  encoder.mostOptimalCoding = options.mostOptimalCoding ?? false;

  // Quantization tables (scaled to the requested quality).
  encoder.setQuantizationTable(
    JpegStandardQuantizationTable.scaleByQuality(JpegStandardQuantizationTable.getLuminanceTable(0, 0), quality),
  );
  if (!grayscale) {
    encoder.setQuantizationTable(
      JpegStandardQuantizationTable.scaleByQuality(JpegStandardQuantizationTable.getChrominanceTable(0, 1), quality),
    );
  }

  // Huffman tables: standard, or builders (for optimized coding).
  if (optimize) {
    encoder.setHuffmanTable(true, 0, null);
    encoder.setHuffmanTable(false, 0, null);
    if (!grayscale) {
      encoder.setHuffmanTable(true, 1, null);
      encoder.setHuffmanTable(false, 1, null);
    }
  } else {
    encoder.setHuffmanTable(true, 0, JpegStandardHuffmanEncodingTable.getLuminanceDCTable());
    encoder.setHuffmanTable(false, 0, JpegStandardHuffmanEncodingTable.getLuminanceACTable());
    if (!grayscale) {
      encoder.setHuffmanTable(true, 1, JpegStandardHuffmanEncodingTable.getChrominanceDCTable());
      encoder.setHuffmanTable(false, 1, JpegStandardHuffmanEncodingTable.getChrominanceACTable());
    }
  }

  // Component planes.
  let planes;
  if (Array.isArray(image.components)) {
    planes = image.components;
  } else {
    const channels = image.channels ?? 4;
    planes = grayscale
      ? [rgbToGrayPlane(width, height, image.data, channels)]
      : (() => {
          const { y, cb, cr } = rgbToYCbCrPlanes(width, height, image.data, channels);
          return [y, cb, cr];
        })();
  }

  // Components and sampling factors.
  if (grayscale) {
    encoder.addComponent(1, 0, 0, 0, 1, 1);
  } else {
    const ss = SUBSAMPLING[subsampling];
    if (!ss) throw new Error(`Unsupported subsampling: ${subsampling}`);
    encoder.addComponent(1, 0, 0, 0, ss[0], ss[1]); // Y
    encoder.addComponent(2, 1, 1, 1, 1, 1); // Cb
    encoder.addComponent(3, 1, 1, 1, 1, 1); // Cr
  }

  encoder.setInputReader(new JpegBufferInputReader(width, height, planes));
  const bytes = encoder.encode();

  if (jfif) {
    const app0 = buildJfifApp0();
    const out = new Uint8Array(bytes.length + app0.length);
    out.set(bytes.subarray(0, 2), 0); // SOI
    out.set(app0, 2);
    out.set(bytes.subarray(2), 2 + app0.length);
    return out;
  }
  return bytes.slice();
}

/**
 * Losslessly re-optimize the Huffman coding of a baseline JPEG to reduce its
 * size. The decoded pixels are unchanged.
 * @param {Uint8Array|ArrayBuffer} input
 * @param {object} [options]
 * @param {boolean} [options.strip=true] drop non-essential metadata segments
 * @param {boolean} [options.mostOptimalCoding=false] use the package-merge algorithm
 * @returns {Uint8Array} the optimized JPEG
 */
export function optimize(input, options = {}) {
  const data = toUint8Array(input);
  const optimizer = new JpegOptimizer();
  optimizer.mostOptimalCoding = options.mostOptimalCoding ?? false;
  optimizer.setInput(data);
  optimizer.scan();
  return optimizer.optimize(options.strip ?? true);
}
