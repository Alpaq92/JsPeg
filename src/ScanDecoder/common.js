// Shared scan-decoder helpers. Ports JpegScanDecoder.cs + JpegHuffmanScanDecoder.cs
// (the non-virtual helpers) and JpegHuffmanDecodingComponent.cs.
import { bufferIndexToBlock } from '../JpegZigZag.js';
import { roundToInt32 } from '../JpegMathHelper.js';
import { transformIDCT } from '../dct.js';

export class JpegHuffmanDecodingComponent {
  constructor() {
    this.componentIndex = 0;
    this.horizontalSamplingFactor = 0;
    this.verticalSamplingFactor = 0;
    this.dcPredictor = 0;
    /** @type {import('../JpegHuffmanDecodingTable.js').JpegHuffmanDecodingTable|null} */
    this.dcTable = null;
    this.acTable = null;
    /** @type {import('../JpegQuantizationTable.js').JpegQuantizationTable|null} */
    this.quantizationTable = null;
    this.horizontalSubsamplingFactor = 0;
    this.verticalSubsamplingFactor = 0;
  }
}

/** True if a quantization table reference is missing or empty. */
export function quantIsEmpty(table) {
  return table == null || table.isEmpty;
}

/**
 * Dequantize `input` (zig-zag order) into `output` (natural order) by multiplying
 * by the quantization table and un-zig-zagging.
 * @param {import('../JpegQuantizationTable.js').JpegQuantizationTable} quantizationTable
 * @param {Int16Array} input
 * @param {number} inputOffset
 * @param {Float32Array} output
 */
export function dequantizeBlockAndUnZigZag(quantizationTable, input, inputOffset, output) {
  const elements = quantizationTable.elements;
  for (let i = 0; i < 64; i++) {
    output[bufferIndexToBlock(i)] = elements[i] * input[inputOffset + i];
  }
}

/**
 * Round spatial samples and apply the level shift, writing int16 results.
 * @param {Float32Array} source
 * @param {Int16Array} destination
 * @param {number} destinationOffset
 * @param {number} levelShift
 */
export function shiftDataLevel(source, destination, destinationOffset, levelShift) {
  for (let i = 0; i < 64; i++) {
    destination[destinationOffset + i] = roundToInt32(source[i]) + levelShift;
  }
}

/**
 * Final pass for progressive scans (shared by the Huffman and arithmetic
 * progressive decoders): dequantize, inverse-DCT and level-shift every stored
 * block in place, then flush to the output writer.
 */
export function finalizeProgressiveBlocks(decoder, frameHeader, allocator, levelShift, outputWriter) {
  const buffer = allocator.buffer;
  const blockF = new Float32Array(64);
  const outputF = new Float32Array(64);
  for (let ci = 0; ci < frameHeader.numberOfComponents; ci++) {
    const quant = decoder.getQuantizationTable(frameHeader.components[ci].quantizationTableSelector);
    const info = allocator.componentInfo(ci);
    for (let by = 0; by < info.vBlocks; by++) {
      for (let bx = 0; bx < info.hBlocks; bx++) {
        const offset = (info.blockOffset + by * info.hBlocks + bx) * 64;
        dequantizeBlockAndUnZigZag(quant, buffer, offset, blockF);
        transformIDCT(blockF, outputF);
        shiftDataLevel(outputF, buffer, offset, levelShift);
      }
    }
  }
  allocator.flush(outputWriter);
}

/**
 * Resolve scan components against the frame header and (re)initialise the
 * pre-allocated component objects.
 * @returns {number} number of components in the scan
 */
export function initDecodeComponents(decoder, frameHeader, scanHeader, components) {
  let maxHorizontalSampling = 1;
  let maxVerticalSampling = 1;
  for (const c of frameHeader.components) {
    maxHorizontalSampling = Math.max(maxHorizontalSampling, c.horizontalSamplingFactor);
    maxVerticalSampling = Math.max(maxVerticalSampling, c.verticalSamplingFactor);
  }

  if (components.length < scanHeader.numberOfComponents) {
    throw new Error('Not enough component slots.');
  }

  for (let i = 0; i < scanHeader.numberOfComponents; i++) {
    const scanComponent = scanHeader.components[i];
    let componentIndex = 0;
    let frameComponent = null;
    for (let j = 0; j < frameHeader.numberOfComponents; j++) {
      const currentFrameComponent = frameHeader.components[j];
      if (scanComponent.scanComponentSelector === currentFrameComponent.identifier) {
        componentIndex = j;
        frameComponent = currentFrameComponent;
      }
    }
    if (frameComponent === null) {
      throwInvalidData('The specified component is missing.');
    }

    let component = components[i];
    if (component == null) {
      components[i] = component = new JpegHuffmanDecodingComponent();
    }
    component.componentIndex = componentIndex;
    component.horizontalSamplingFactor = frameComponent.horizontalSamplingFactor;
    component.verticalSamplingFactor = frameComponent.verticalSamplingFactor;
    component.dcTable = decoder.getHuffmanTable(true, scanComponent.dcEntropyCodingTableSelector);
    component.acTable = decoder.getHuffmanTable(false, scanComponent.acEntropyCodingTableSelector);
    component.quantizationTable = decoder.getQuantizationTable(frameComponent.quantizationTableSelector);
    component.horizontalSubsamplingFactor = Math.trunc(maxHorizontalSampling / component.horizontalSamplingFactor);
    component.verticalSubsamplingFactor = Math.trunc(maxVerticalSampling / component.verticalSamplingFactor);
    component.dcPredictor = 0;
  }

  return scanHeader.numberOfComponents;
}

/**
 * Decode one Huffman symbol from the bit reader.
 * @param {import('../JpegBitReader.js').JpegBitReader} reader
 * @param {import('../JpegHuffmanDecodingTable.js').JpegHuffmanDecodingTable} table
 * @returns {number} the symbol value
 */
export function decodeHuffmanCode(reader, table) {
  const bits = reader.peekBits(16);
  const bitsPeeked = reader.bitsPeeked;
  const entry = table.lookup(bits);
  const codeSize = entry >> 8;
  const bitsRead = Math.min(codeSize, bitsPeeked);
  reader.tryAdvanceBits(bitsRead);
  return entry & 0xff;
}

/** Read `length` bits and sign-extend them (JPEG "RECEIVE and EXTEND"). */
export function receiveAndExtend(reader, length) {
  if (!reader.tryReadBits(length)) {
    if (reader.markerEncountered) {
      throwInvalidData('Expect raw data from bit stream. Yet a marker is encountered.');
    }
    throwInvalidData('The bit stream ended prematurely.');
  }
  return extend(reader.bits, length);
}

export function extend(v, nbits) {
  return v - ((((v + v) >> nbits) - 1) & ((1 << nbits) - 1));
}

export function throwInvalidData(message) {
  throw new Error('Failed to decode JPEG data. ' + message);
}
