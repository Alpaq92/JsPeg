// Baseline JPEG encoder with optional optimized Huffman coding.
// Port of JpegEncoder.cs.
import { JpegMarker } from './JpegMarker.js';
import { JpegWriter } from './JpegWriter.js';
import { JpegFrameHeader, JpegFrameComponentSpecificationParameters } from './JpegFrameHeader.js';
import { JpegScanHeader, JpegScanComponentSpecificationParameters } from './JpegScanHeader.js';
import { JpegHuffmanEncodingTableCollection } from './JpegHuffmanEncodingTableCollection.js';
import { JpegHuffmanEncodingComponent } from './JpegHuffmanEncodingComponent.js';
import { JpegBlockAllocator } from './JpegBlockAllocator.js';
import { transformFDCT } from './dct.js';
import { bufferIndexToBlock } from './JpegZigZag.js';
import { roundToInt16, log2 } from './JpegMathHelper.js';

// Number of bits needed to hold an integer in [0, 255].
const BitCountTable = (() => {
  const t = new Uint8Array(256);
  for (let i = 1; i < 256; i++) t[i] = 32 - Math.clz32(i);
  return t;
})();

export class JpegEncoder {
  constructor() {
    this._input = null;
    this._output = null;
    /** @type {import('./JpegQuantizationTable.js').JpegQuantizationTable[]|null} */
    this._quantizationTables = null;
    this._huffmanTables = new JpegHuffmanEncodingTableCollection();
    /** @type {JpegHuffmanEncodingComponent[]|null} */
    this._encodeComponents = null;
    /** True to use the package-merge optimal Huffman algorithm. */
    this.mostOptimalCoding = false;
    /** Sample precision in bits — 8 emits SOF0 (baseline); 9..12 emits SOF1. */
    this.precision = 8;
  }

  setInputReader(inputReader) {
    if (inputReader == null) throw new Error('inputReader is required.');
    this._input = inputReader;
  }

  setQuantizationTable(table) {
    if (table == null || table.isEmpty) throw new Error('Quantization table is not initialized.');
    if (table.elementPrecision !== 0) throw new Error('Only baseline JPEG is supported.');
    let tables = this._quantizationTables;
    if (tables === null) tables = this._quantizationTables = [];
    for (let i = 0; i < tables.length; i++) {
      if (tables[i].identifier === table.identifier) {
        tables[i] = table;
        return;
      }
    }
    tables.push(table);
  }

  /** @param {object|null} table pass null to request automatic (optimized) generation */
  setHuffmanTable(isDcTable, identifier, table = null) {
    this._huffmanTables.addTable(isDcTable ? 0 : 1, identifier, table);
  }

  _getQuantizationTable(identifier) {
    if (this._quantizationTables === null) return null;
    for (const t of this._quantizationTables) {
      if (t.identifier === identifier) return t;
    }
    return null;
  }

  addComponent(componentIndex, quantizationTableIdentifier, huffmanDcTableIdentifier, huffmanAcTableIdentifier, horizontalSamplingFactor, verticalSamplingFactor) {
    for (const f of [horizontalSamplingFactor, verticalSamplingFactor]) {
      if (f !== 1 && f !== 2 && f !== 4) throw new RangeError('Sampling factor can only be 1, 2 or 4.');
    }
    let components = this._encodeComponents;
    if (components === null) components = this._encodeComponents = [];
    for (const item of components) {
      if (item.componentIndex === componentIndex) {
        throw new Error('The component index is already used by another component.');
      }
    }

    const quantizationTable = this._getQuantizationTable(quantizationTableIdentifier);
    if (quantizationTable == null || quantizationTable.isEmpty) {
      throw new Error('Quantization table is not defined.');
    }
    let dcTable = this._huffmanTables.getTable(true, huffmanDcTableIdentifier);
    let dcTableBuilder = null;
    if (dcTable === null) {
      dcTableBuilder = this._huffmanTables.getTableBuilder(true, huffmanDcTableIdentifier);
      if (dcTableBuilder === null) throw new Error('DC Huffman table is not defined.');
    }
    let acTable = this._huffmanTables.getTable(false, huffmanAcTableIdentifier);
    let acTableBuilder = null;
    if (acTable === null) {
      acTableBuilder = this._huffmanTables.getTableBuilder(false, huffmanAcTableIdentifier);
      if (acTableBuilder === null) throw new Error('AC Huffman table is not defined.');
    }

    const component = new JpegHuffmanEncodingComponent();
    component.index = components.length;
    component.componentIndex = componentIndex;
    component.horizontalSamplingFactor = horizontalSamplingFactor;
    component.verticalSamplingFactor = verticalSamplingFactor;
    component.dcTableIdentifier = huffmanDcTableIdentifier;
    component.acTableIdentifier = huffmanAcTableIdentifier;
    component.dcTable = dcTable;
    component.acTable = acTable;
    component.dcTableBuilder = dcTableBuilder;
    component.acTableBuilder = acTableBuilder;
    component.quantizationTable = quantizationTable;
    components.push(component);
  }

  /** Encode the image and return the JPEG byte stream. @returns {Uint8Array} */
  encode() {
    const optimizeCoding = this._huffmanTables.containsTableBuilder();
    const writer = new JpegWriter();

    writer.writeMarker(JpegMarker.StartOfImage);
    this._writeQuantizationTables(writer);
    const frameHeader = this._writeStartOfFrame(writer);

    if (optimizeCoding) {
      const allocator = new JpegBlockAllocator();
      allocator.allocate(frameHeader);
      this._transformBlocks(allocator);
      this._buildHuffmanTables(frameHeader, allocator, this.mostOptimalCoding);
      this._writeHuffmanTables(writer);
      this._writeStartOfScan(writer);
      this._writePreparedScanData(frameHeader, allocator, writer);
    } else {
      this._writeHuffmanTables(writer);
      this._writeStartOfScan(writer);
      this._writeScanData(writer);
    }

    writer.writeMarker(JpegMarker.EndOfImage);
    return writer.toUint8Array();
  }

  _writeQuantizationTables(writer) {
    const tables = this._quantizationTables;
    if (tables === null) throw new Error('Quantization tables are not set.');
    writer.writeMarker(JpegMarker.DefineQuantizationTable);
    let total = 0;
    for (const t of tables) total += t.bytesRequired;
    writer.writeLength(total);
    for (const t of tables) {
      const buf = new Uint8Array(t.bytesRequired);
      const n = t.write(buf, 0);
      writer.writeBytes(buf.subarray(0, n));
    }
  }

  _writeHuffmanTables(writer) {
    if (this._huffmanTables.isEmpty) throw new Error('Huffman tables are not set.');
    writer.writeMarker(JpegMarker.DefineHuffmanTable);
    writer.writeLength(this._huffmanTables.getTotalBytesRequired());
    this._huffmanTables.write(writer);
  }

  _writeStartOfFrame(writer) {
    const input = this._input;
    if (input == null) throw new Error('Input is not specified.');
    const encodeComponents = this._encodeComponents;
    if (encodeComponents == null || encodeComponents.length === 0) throw new Error('No component is specified.');

    const components = new Array(encodeComponents.length);
    for (let i = 0; i < encodeComponents.length; i++) {
      const c = encodeComponents[i];
      components[i] = new JpegFrameComponentSpecificationParameters(
        c.componentIndex, c.horizontalSamplingFactor, c.verticalSamplingFactor, c.quantizationTable.identifier,
      );
    }
    const frameHeader = new JpegFrameHeader(this.precision, input.height, input.width, components.length, components);

    writer.writeMarker(this.precision > 8 ? JpegMarker.StartOfFrame1 : JpegMarker.StartOfFrame0);
    writer.writeLength(frameHeader.bytesRequired);
    const buf = new Uint8Array(frameHeader.bytesRequired);
    frameHeader.write(buf, 0);
    writer.writeBytes(buf);
    return frameHeader;
  }

  _writeStartOfScan(writer) {
    const encodeComponents = this._encodeComponents;
    if (encodeComponents == null || encodeComponents.length === 0) throw new Error('No component is specified.');
    const components = new Array(encodeComponents.length);
    for (let i = 0; i < encodeComponents.length; i++) {
      const c = encodeComponents[i];
      components[i] = new JpegScanComponentSpecificationParameters(c.componentIndex, c.dcTableIdentifier, c.acTableIdentifier);
    }
    const scanHeader = new JpegScanHeader(components.length, components, 0, 63, 0, 0);

    writer.writeMarker(JpegMarker.StartOfScan);
    writer.writeLength(scanHeader.bytesRequired);
    const buf = new Uint8Array(scanHeader.bytesRequired);
    scanHeader.write(buf, 0);
    writer.writeBytes(buf);
  }

  _prepareSampling(components) {
    let maxH = 1;
    let maxV = 1;
    for (const c of components) {
      c.dcPredictor = 0;
      maxH = Math.max(maxH, c.horizontalSamplingFactor);
      maxV = Math.max(maxV, c.verticalSamplingFactor);
    }
    for (const c of components) {
      c.horizontalSubsamplingFactor = Math.trunc(maxH / c.horizontalSamplingFactor);
      c.verticalSubsamplingFactor = Math.trunc(maxV / c.verticalSamplingFactor);
    }
    return { maxH, maxV };
  }

  _transformBlocks(allocator) {
    const inputReader = this._input;
    const components = this._encodeComponents;
    const { maxH, maxV } = this._prepareSampling(components);

    const mcusPerLine = Math.trunc((inputReader.width + 8 * maxH - 1) / (8 * maxH));
    const mcusPerColumn = Math.trunc((inputReader.height + 8 * maxV - 1) / (8 * maxV));
    const levelShift = 1 << (this.precision - 1);

    const buffer = allocator.buffer;
    const inputF = new Float32Array(64);
    const outputF = new Float32Array(64);

    for (let rowMcu = 0; rowMcu < mcusPerColumn; rowMcu++) {
      for (let colMcu = 0; colMcu < mcusPerLine; colMcu++) {
        for (const component of components) {
          const index = component.index;
          const h = component.horizontalSamplingFactor;
          const v = component.verticalSamplingFactor;
          const hs = component.horizontalSubsamplingFactor;
          const vs = component.verticalSubsamplingFactor;
          const offsetX = colMcu * h;
          const offsetY = rowMcu * v;

          for (let y = 0; y < v; y++) {
            const blockOffsetY = offsetY + y;
            for (let x = 0; x < h; x++) {
              const off = allocator.getBlockOffset(index, offsetX + x, blockOffsetY);
              readBlock(inputReader, buffer, off, index, (offsetX + x) * 8 * hs, blockOffsetY * 8 * vs, hs, vs);
              shiftDataLevel(buffer, off, inputF, levelShift);
              transformFDCT(inputF, outputF);
              zigZagAndQuantize(component.quantizationTable, outputF, buffer, off);
            }
          }
        }
      }
    }
  }

  _buildHuffmanTables(frameHeader, allocator, optimal) {
    const components = this._encodeComponents;
    const { maxH, maxV } = this._prepareSampling(components);
    const buffer = allocator.buffer;

    const mcusPerLine = Math.trunc((frameHeader.samplesPerLine + 8 * maxH - 1) / (8 * maxH));
    const mcusPerColumn = Math.trunc((frameHeader.numberOfLines + 8 * maxV - 1) / (8 * maxV));

    for (let rowMcu = 0; rowMcu < mcusPerColumn; rowMcu++) {
      for (let colMcu = 0; colMcu < mcusPerLine; colMcu++) {
        for (const component of components) {
          const index = component.index;
          const h = component.horizontalSamplingFactor;
          const v = component.verticalSamplingFactor;
          const offsetX = colMcu * h;
          const offsetY = rowMcu * v;
          for (let y = 0; y < v; y++) {
            const blockOffsetY = offsetY + y;
            for (let x = 0; x < h; x++) {
              const off = allocator.getBlockOffset(index, offsetX + x, blockOffsetY);
              gatherBlockStatistics(component, buffer, off);
            }
          }
        }
      }
    }

    this._huffmanTables.buildTables(optimal);
    for (const component of components) {
      component.dcTable = this._huffmanTables.getTable(true, component.dcTableIdentifier);
      component.acTable = this._huffmanTables.getTable(false, component.acTableIdentifier);
      component.dcTableBuilder = null;
      component.acTableBuilder = null;
    }
  }

  _writePreparedScanData(frameHeader, allocator, writer) {
    const components = this._encodeComponents;
    const { maxH, maxV } = this._prepareSampling(components);
    const buffer = allocator.buffer;

    const mcusPerLine = Math.trunc((frameHeader.samplesPerLine + 8 * maxH - 1) / (8 * maxH));
    const mcusPerColumn = Math.trunc((frameHeader.numberOfLines + 8 * maxV - 1) / (8 * maxV));

    writer.enterBitMode();
    for (let rowMcu = 0; rowMcu < mcusPerColumn; rowMcu++) {
      for (let colMcu = 0; colMcu < mcusPerLine; colMcu++) {
        for (const component of components) {
          const index = component.index;
          const h = component.horizontalSamplingFactor;
          const v = component.verticalSamplingFactor;
          const offsetX = colMcu * h;
          const offsetY = rowMcu * v;
          for (let y = 0; y < v; y++) {
            const blockOffsetY = offsetY + y;
            for (let x = 0; x < h; x++) {
              const off = allocator.getBlockOffset(index, offsetX + x, blockOffsetY);
              encodeBlock(writer, component, buffer, off);
            }
          }
        }
      }
    }
    writer.exitBitMode();
  }

  _writeScanData(writer) {
    const inputReader = this._input;
    const components = this._encodeComponents;
    const { maxH, maxV } = this._prepareSampling(components);

    const mcusPerLine = Math.trunc((inputReader.width + 8 * maxH - 1) / (8 * maxH));
    const mcusPerColumn = Math.trunc((inputReader.height + 8 * maxV - 1) / (8 * maxV));

    writer.enterBitMode();
    const levelShift = 1 << (this.precision - 1);
    const inputBuffer = new Int16Array(64);
    const inputF = new Float32Array(64);
    const outputF = new Float32Array(64);

    for (let rowMcu = 0; rowMcu < mcusPerColumn; rowMcu++) {
      const offsetY = rowMcu * maxV;
      for (let colMcu = 0; colMcu < mcusPerLine; colMcu++) {
        const offsetX = colMcu * maxH;
        for (const component of components) {
          const h = component.horizontalSamplingFactor;
          const v = component.verticalSamplingFactor;
          const hs = component.horizontalSubsamplingFactor;
          const vs = component.verticalSubsamplingFactor;
          for (let y = 0; y < v; y++) {
            const blockOffsetY = (offsetY + y) * 8;
            for (let x = 0; x < h; x++) {
              readBlock(inputReader, inputBuffer, 0, component.index, (offsetX + x) * 8, blockOffsetY, hs, vs);
              shiftDataLevel(inputBuffer, 0, inputF, levelShift);
              transformFDCT(inputF, outputF);
              zigZagAndQuantize(component.quantizationTable, outputF, inputBuffer, 0);
              encodeBlock(writer, component, inputBuffer, 0);
            }
          }
        }
      }
    }
    writer.exitBitMode();
  }

  reset() {
    this._input = null;
    this._quantizationTables = null;
    this._huffmanTables = new JpegHuffmanEncodingTableCollection();
    this._encodeComponents = null;
  }
}

// ---- block-level helpers ----------------------------------------------------

const _subsampleScratch = new Int16Array(64);

function readBlock(inputReader, block, blockOffset, componentIndex, x, y, h, v) {
  if (h === 1 && v === 1) {
    inputReader.readBlock(block, blockOffset, componentIndex, x, y);
    return;
  }
  readBlockWithSubsample(inputReader, block, blockOffset, componentIndex, x, y, h, v);
}

function readBlockWithSubsample(inputReader, block, blockOffset, componentIndex, x, y, horizontalSubsampling, verticalSubsampling) {
  for (let i = 0; i < 64; i++) block[blockOffset + i] = 0;

  const temp = _subsampleScratch;
  const hShift = log2(horizontalSubsampling);
  const vShift = log2(verticalSubsampling);
  const hBlockShift = 3 - hShift;
  const vBlockShift = 3 - vShift;

  for (let v = 0; v < verticalSubsampling; v++) {
    for (let h = 0; h < horizontalSubsampling; h++) {
      inputReader.readBlock(temp, 0, componentIndex, x + 8 * h, y + 8 * v);
      copySubsampleBlock(temp, block, blockOffset, h << hBlockShift, v << vBlockShift, hShift, vShift);
    }
  }

  const totalShift = hShift + vShift;
  if (totalShift > 0) {
    const delta = 1 << (totalShift - 1);
    for (let i = 0; i < 64; i++) {
      block[blockOffset + i] = (block[blockOffset + i] + delta) >> totalShift;
    }
  }
}

function copySubsampleBlock(source, dest, destOffset, blockOffsetX, blockOffsetY, hShift, vShift) {
  for (let y = 0; y < 8; y++) {
    const srcRow = y * 8;
    const dstRow = destOffset + (blockOffsetY + (y >> vShift)) * 8 + blockOffsetX;
    for (let x = 0; x < 8; x++) {
      dest[dstRow + (x >> hShift)] += source[srcRow + x];
    }
  }
}

function shiftDataLevel(source, sourceOffset, destination, levelShift) {
  for (let i = 0; i < 64; i++) {
    destination[i] = source[sourceOffset + i] - levelShift;
  }
}

function zigZagAndQuantize(quantizationTable, input, output, outputOffset) {
  const elements = quantizationTable.elements;
  for (let i = 0; i < 64; i++) {
    const coefficient = input[bufferIndexToBlock(i)];
    output[outputOffset + i] = roundToInt16(coefficient / elements[i]);
  }
}

function bitCountOf(value) {
  return value < 0x100 ? BitCountTable[value] : 8 + BitCountTable[value >> 8];
}

export function encodeBlock(writer, component, block, blockOffset) {
  // DC
  const dcValue = block[blockOffset];
  let t = dcValue - component.dcPredictor;
  component.dcPredictor = dcValue;
  encodeRunLength(writer, component.dcTable, 0, t);

  // AC
  const acTable = component.acTable;
  let runLength = 0;
  for (let i = 1; i < 64; i++) {
    t = block[blockOffset + i];
    if (t === 0) {
      runLength++;
    } else {
      while (runLength > 15) {
        encodeHuffmanSymbol(writer, acTable, 0xf0);
        runLength -= 16;
      }
      encodeRunLength(writer, acTable, runLength, t);
      runLength = 0;
    }
  }
  if (runLength > 0) {
    encodeHuffmanSymbol(writer, acTable, 0); // EOB
  }
}

function encodeRunLength(writer, table, zeroRunLength, value) {
  let a = value;
  let b = value;
  if (a < 0) {
    a = -value;
    b = value - 1;
  }
  const bitCount = bitCountOf(a);
  encodeHuffmanSymbol(writer, table, (zeroRunLength << 4) | bitCount);
  if (bitCount > 0) {
    writer.writeBits(b & ((1 << bitCount) - 1), bitCount);
  }
}

function encodeHuffmanSymbol(writer, table, symbol) {
  table.getCode(symbol);
  writer.writeBits(table.code, table.codeLength);
}

export function gatherBlockStatistics(component, block, blockOffset) {
  // DC
  const dcValue = block[blockOffset];
  const t = dcValue - component.dcPredictor;
  component.dcPredictor = dcValue;
  if (component.dcTableBuilder !== null) {
    gatherRunLengthCodeStatistics(component.dcTableBuilder, 0, t);
  }

  // AC
  const acTableBuilder = component.acTableBuilder;
  if (acTableBuilder === null) return;
  let runLength = 0;
  for (let i = 1; i < 64; i++) {
    const v = block[blockOffset + i];
    if (v === 0) {
      runLength++;
    } else {
      while (runLength > 15) {
        acTableBuilder.incrementCodeCount(0xf0);
        runLength -= 16;
      }
      gatherRunLengthCodeStatistics(acTableBuilder, runLength, v);
      runLength = 0;
    }
  }
  if (runLength > 0) {
    acTableBuilder.incrementCodeCount(0); // EOB
  }
}

function gatherRunLengthCodeStatistics(tableBuilder, zeroRunLength, value) {
  const a = value < 0 ? -value : value;
  const bitCount = bitCountOf(a);
  tableBuilder.incrementCodeCount((zeroRunLength << 4) | bitCount);
}
