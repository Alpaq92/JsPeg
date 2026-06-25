// Re-optimizes the Huffman coding of a baseline JPEG to shrink it losslessly
// (pixels unchanged). Port of JpegOptimizer.cs + JpegTranscodeComponent.cs.
//
// Two passes: scan() decodes the entropy stream to gather symbol statistics and
// builds new (optimal) Huffman tables; optimize() rewrites the file, swapping in
// the new tables and re-encoding each block — copying the magnitude bits
// verbatim so the decoded image is identical.
import { JpegMarker, isRestartMarker } from './JpegMarker.js';
import { JpegReader } from './JpegReader.js';
import { JpegBitReader } from './JpegBitReader.js';
import { JpegWriter } from './JpegWriter.js';
import { JpegFrameHeader } from './JpegFrameHeader.js';
import { JpegScanHeader } from './JpegScanHeader.js';
import { JpegQuantizationTable } from './JpegQuantizationTable.js';
import { JpegHuffmanDecodingTable } from './JpegHuffmanDecodingTable.js';
import { JpegHuffmanEncodingTableBuilderCollection } from './JpegHuffmanEncodingTableBuilderCollection.js';
import { decodeHuffmanCode } from './ScanDecoder/common.js';

export class JpegOptimizer {
  constructor() {
    this._inputBuffer = new Uint8Array(0);
    this._frameHeader = null;
    this._restartInterval = 0;
    this._quantizationTables = null;
    this._huffmanTables = null;
    this._encodingTables = null;
    /** True to use the package-merge optimal Huffman algorithm. */
    this.mostOptimalCoding = false;
  }

  setInput(input) {
    this._inputBuffer = input;
    this._frameHeader = null;
    this._restartInterval = 0;
  }

  // ---- Pass 1: gather statistics -----------------------------------------

  scan() {
    if (this._inputBuffer.length === 0) throw new Error('Input buffer is not specified.');
    const reader = new JpegReader(this._inputBuffer);
    this._frameHeader = null;

    let scanRead = false;
    let endOfImage = false;
    while (!endOfImage && !reader.isEmpty) {
      const marker = reader.tryReadMarker();
      if (marker === 0) throwAt(reader.consumedByteCount, 'No marker found.');

      switch (marker) {
        case JpegMarker.StartOfImage:
          break;
        case JpegMarker.StartOfFrame0:
        case JpegMarker.StartOfFrame1:
          this._processFrameHeader(reader);
          break;
        case JpegMarker.StartOfFrame2:
        case JpegMarker.StartOfFrame3:
        case JpegMarker.StartOfFrame5:
        case JpegMarker.StartOfFrame6:
        case JpegMarker.StartOfFrame7:
        case JpegMarker.StartOfFrame9:
        case JpegMarker.StartOfFrame10:
        case JpegMarker.StartOfFrame11:
        case JpegMarker.StartOfFrame13:
        case JpegMarker.StartOfFrame14:
        case JpegMarker.StartOfFrame15:
          throwAt(reader.consumedByteCount, `This type of JPEG stream is not supported (0x${marker.toString(16)}).`);
          break;
        case JpegMarker.DefineHuffmanTable:
          this._processDefineHuffmanTable(reader);
          break;
        case JpegMarker.DefineQuantizationTable:
          this._processDefineQuantizationTable(reader);
          break;
        case JpegMarker.DefineRestartInterval:
          this._processDefineRestartInterval(reader);
          break;
        case JpegMarker.StartOfScan: {
          const scanHeader = this._processScanHeader(reader);
          this._processScanBaseline(reader, scanHeader);
          scanRead = true;
          break;
        }
        case JpegMarker.EndOfImage:
          endOfImage = true;
          break;
        default:
          if (marker >= JpegMarker.DefineRestart0 && marker <= JpegMarker.DefineRestart7) break;
          this._skipMarkerData(reader);
          break;
      }
    }

    if (!scanRead) throwAt(reader.consumedByteCount, 'No image data is read.');
  }

  _processFrameHeader(reader) {
    const length = reader.tryReadLength();
    if (length < 0) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
    const buffer = reader.tryReadBytes(length);
    if (buffer === null) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
    const r = JpegFrameHeader.parse(buffer, false);
    if (r === null) throwAt(reader.consumedByteCount - length, 'Failed to parse frame header.');
    if (this._frameHeader !== null) throwAt(reader.consumedByteCount, 'Multiple frame is not supported.');
    this._frameHeader = r.value;
  }

  _processScanHeader(reader) {
    const length = reader.tryReadLength();
    if (length < 0) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
    const buffer = reader.tryReadBytes(length);
    if (buffer === null) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
    const r = JpegScanHeader.parse(buffer, false);
    if (r === null) throwAt(reader.consumedByteCount - length, 'Failed to parse scan header.');
    return r.value;
  }

  _processDefineRestartInterval(reader) {
    const length = reader.tryReadLength();
    const buffer = reader.tryReadBytes(length);
    if (buffer === null || buffer.length < 2) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
    this._restartInterval = (buffer[0] << 8) | buffer[1];
  }

  _processDefineHuffmanTable(reader) {
    const length = reader.tryReadLength();
    const buffer = reader.tryReadBytes(length);
    if (buffer === null) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
    let offset = 0;
    while (offset < buffer.length) {
      const r = JpegHuffmanDecodingTable.parse(buffer, offset);
      if (r === null) throwAt(reader.consumedByteCount - length + offset, 'Failed to parse Huffman table.');
      offset += r.bytesConsumed;
      this._setHuffmanTable(r.value);
    }
  }

  _processDefineQuantizationTable(reader) {
    const length = reader.tryReadLength();
    const buffer = reader.tryReadBytes(length);
    if (buffer === null) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
    let offset = 0;
    while (offset < buffer.length) {
      const r = JpegQuantizationTable.parse(buffer, offset);
      if (r === null) throwAt(reader.consumedByteCount - length + offset, 'Failed to parse quantization table.');
      offset += r.bytesConsumed;
      this._setQuantizationTable(r.value);
    }
  }

  _setHuffmanTable(table) {
    if (this._huffmanTables === null) this._huffmanTables = [];
    for (let i = 0; i < this._huffmanTables.length; i++) {
      if (this._huffmanTables[i].tableClass === table.tableClass && this._huffmanTables[i].identifier === table.identifier) {
        this._huffmanTables[i] = table;
        return;
      }
    }
    this._huffmanTables.push(table);
  }

  _setQuantizationTable(table) {
    if (this._quantizationTables === null) this._quantizationTables = [];
    for (let i = 0; i < this._quantizationTables.length; i++) {
      if (this._quantizationTables[i].identifier === table.identifier) {
        this._quantizationTables[i] = table;
        return;
      }
    }
    this._quantizationTables.push(table);
  }

  _getHuffmanTable(isDcTable, identifier) {
    if (this._huffmanTables === null) return null;
    const tableClass = isDcTable ? 0 : 1;
    for (const t of this._huffmanTables) {
      if (t.tableClass === tableClass && t.identifier === identifier) return t;
    }
    return null;
  }

  _resolveComponents(scanHeader, perComponent) {
    const frameHeader = this._frameHeader;
    const components = new Array(scanHeader.numberOfComponents);
    for (let i = 0; i < scanHeader.numberOfComponents; i++) {
      const scanComponent = scanHeader.components[i];
      let frameComponent = null;
      for (let j = 0; j < frameHeader.numberOfComponents; j++) {
        if (scanComponent.scanComponentSelector === frameHeader.components[j].identifier) {
          frameComponent = frameHeader.components[j];
        }
      }
      if (frameComponent === null) throw new Error('Component is missing.');
      const component = {
        horizontalSamplingFactor: frameComponent.horizontalSamplingFactor,
        verticalSamplingFactor: frameComponent.verticalSamplingFactor,
        dcTable: this._getHuffmanTable(true, scanComponent.dcEntropyCodingTableSelector),
        acTable: this._getHuffmanTable(false, scanComponent.acEntropyCodingTableSelector),
      };
      perComponent(component, scanComponent);
      components[i] = component;
    }
    return components;
  }

  _processScanBaseline(reader, scanHeader) {
    const frameHeader = this._frameHeader;
    let maxH = 1;
    let maxV = 1;
    for (const c of frameHeader.components) {
      maxH = Math.max(maxH, c.horizontalSamplingFactor);
      maxV = Math.max(maxV, c.verticalSamplingFactor);
    }

    const tableBuilders = new JpegHuffmanEncodingTableBuilderCollection();
    const components = this._resolveComponents(scanHeader, (component, scanComponent) => {
      component.dcTableBuilder = tableBuilders.getOrCreateTableBuilder(true, scanComponent.dcEntropyCodingTableSelector);
      component.acTableBuilder = tableBuilders.getOrCreateTableBuilder(false, scanComponent.acEntropyCodingTableSelector);
    });

    const mcusPerLine = Math.trunc((frameHeader.samplesPerLine + 8 * maxH - 1) / (8 * maxH));
    const mcusPerColumn = Math.trunc((frameHeader.numberOfLines + 8 * maxV - 1) / (8 * maxV));
    const bitReader = new JpegBitReader(reader.remainingBytes);
    let mcusBeforeRestart = this._restartInterval;

    for (let rowMcu = 0; rowMcu < mcusPerColumn; rowMcu++) {
      for (let colMcu = 0; colMcu < mcusPerLine; colMcu++) {
        for (const component of components) {
          for (let y = 0; y < component.verticalSamplingFactor; y++) {
            for (let x = 0; x < component.horizontalSamplingFactor; x++) {
              gatherBlockBaseline(bitReader, component);
            }
          }
        }
        if (this._restartInterval > 0 && --mcusBeforeRestart === 0) {
          bitReader.advanceAlignByte();
          const marker = bitReader.tryReadMarker();
          if (marker === JpegMarker.EndOfImage) {
            const consumed = reader.remainingByteCount - Math.floor(bitReader.remainingBits / 8);
            reader.tryAdvance(consumed - 2);
            this._encodingTables = tableBuilders.buildTables(this.mostOptimalCoding);
            return;
          }
          if (!isRestartMarker(marker)) throw new Error('Expect restart marker.');
          mcusBeforeRestart = this._restartInterval;
        }
      }
    }

    bitReader.advanceAlignByte();
    let bytesConsumed = reader.remainingByteCount - Math.floor(bitReader.remainingBits / 8);
    const peeked = bitReader.tryPeekMarker();
    if (peeked !== 0 && !isRestartMarker(peeked)) bytesConsumed -= 2;
    reader.tryAdvance(bytesConsumed);

    this._encodingTables = tableBuilders.buildTables(this.mostOptimalCoding);
  }

  // ---- Pass 2: rewrite ----------------------------------------------------

  /** @param {boolean} strip drop non-essential metadata segments. @returns {Uint8Array} */
  optimize(strip = true) {
    if (this._encodingTables === null || this._encodingTables.isEmpty) {
      throw new Error('Call scan() before optimize().');
    }

    const reader = new JpegReader(this._inputBuffer);
    const writer = new JpegWriter();

    let eoiReached = false;
    let huffmanTableWritten = false;
    let quantizationTableWritten = false;

    while (!eoiReached && !reader.isEmpty) {
      const marker = reader.tryReadMarker();
      if (marker === 0) throwAt(reader.consumedByteCount, 'No marker found.');

      switch (marker) {
        case JpegMarker.StartOfImage:
          writer.writeMarker(marker);
          break;
        case JpegMarker.App0:
        case JpegMarker.StartOfFrame0:
        case JpegMarker.StartOfFrame1:
          writer.writeMarker(marker);
          copyMarkerData(reader, writer);
          break;
        case JpegMarker.DefineHuffmanTable:
          if (!huffmanTableWritten) {
            this._writeHuffmanTables(writer);
            huffmanTableWritten = true;
          }
          this._skipMarkerData(reader);
          break;
        case JpegMarker.DefineQuantizationTable:
          if (!quantizationTableWritten) {
            this._writeQuantizationTables(writer);
            quantizationTableWritten = true;
          }
          this._skipMarkerData(reader);
          break;
        case JpegMarker.StartOfScan: {
          writer.writeMarker(marker);
          const buffer = copyMarkerData(reader, writer);
          const r = JpegScanHeader.parse(buffer, false);
          if (r === null) throwAt(reader.consumedByteCount - buffer.length, 'Failed to parse scan header.');
          this._copyScanBaseline(reader, writer, r.value);
          break;
        }
        case JpegMarker.EndOfImage:
          writer.writeMarker(JpegMarker.EndOfImage);
          eoiReached = true;
          break;
        default:
          if (marker >= JpegMarker.DefineRestart0 && marker <= JpegMarker.DefineRestart7) {
            writer.writeMarker(marker);
            break;
          }
          if (strip) {
            this._skipMarkerData(reader);
          } else {
            writer.writeMarker(marker);
            copyMarkerData(reader, writer);
          }
          break;
      }
    }

    return writer.toUint8Array().slice();
  }

  _skipMarkerData(reader) {
    const length = reader.tryReadLength();
    if (length < 0) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
    if (!reader.tryAdvance(length)) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
  }

  _writeHuffmanTables(writer) {
    writer.writeMarker(JpegMarker.DefineHuffmanTable);
    writer.writeLength(this._encodingTables.getTotalBytesRequired());
    this._encodingTables.write(writer);
  }

  _writeQuantizationTables(writer) {
    const tables = this._quantizationTables;
    if (tables === null) throw new Error('No quantization tables.');
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

  _copyScanBaseline(reader, writer, scanHeader) {
    const frameHeader = this._frameHeader;
    let maxH = 1;
    let maxV = 1;
    for (const c of frameHeader.components) {
      maxH = Math.max(maxH, c.horizontalSamplingFactor);
      maxV = Math.max(maxV, c.verticalSamplingFactor);
    }

    const components = this._resolveComponents(scanHeader, (component, scanComponent) => {
      component.dcEncodingTable = this._encodingTables.getTable(true, scanComponent.dcEntropyCodingTableSelector);
      component.acEncodingTable = this._encodingTables.getTable(false, scanComponent.acEntropyCodingTableSelector);
    });

    const mcusPerLine = Math.trunc((frameHeader.samplesPerLine + 8 * maxH - 1) / (8 * maxH));
    const mcusPerColumn = Math.trunc((frameHeader.numberOfLines + 8 * maxV - 1) / (8 * maxV));
    const bitReader = new JpegBitReader(reader.remainingBytes);
    let mcusBeforeRestart = this._restartInterval;

    let eoiReached = false;
    writer.enterBitMode();
    for (let rowMcu = 0; rowMcu < mcusPerColumn && !eoiReached; rowMcu++) {
      for (let colMcu = 0; colMcu < mcusPerLine && !eoiReached; colMcu++) {
        for (const component of components) {
          for (let y = 0; y < component.verticalSamplingFactor; y++) {
            for (let x = 0; x < component.horizontalSamplingFactor; x++) {
              copyBlockBaseline(bitReader, writer, component);
            }
          }
        }
        if (this._restartInterval > 0 && --mcusBeforeRestart === 0) {
          bitReader.advanceAlignByte();
          const marker = bitReader.tryReadMarker();
          if (marker === JpegMarker.EndOfImage) {
            eoiReached = true;
            break;
          }
          if (!isRestartMarker(marker)) throw new Error('Expect restart marker.');
          mcusBeforeRestart = this._restartInterval;
          writer.exitBitMode();
          writer.writeMarker(marker);
          writer.enterBitMode();
        }
      }
    }

    bitReader.advanceAlignByte();
    writer.exitBitMode();

    let bytesConsumed = reader.remainingByteCount - Math.floor(bitReader.remainingBits / 8);
    if (eoiReached) {
      bytesConsumed -= 2;
    } else {
      const peeked = bitReader.tryPeekMarker();
      if (peeked !== 0 && !isRestartMarker(peeked)) bytesConsumed -= 2;
    }
    reader.tryAdvance(bytesConsumed);
  }
}

function receive(reader, length) {
  if (!reader.tryReadBits(length)) {
    if (reader.markerEncountered) throw new Error('Expect raw data from bit stream. Yet a marker is encountered.');
    throw new Error('The bit stream ended prematurely.');
  }
  return reader.bits;
}

function gatherBlockBaseline(reader, component) {
  // DC
  let t = decodeHuffmanCode(reader, component.dcTable);
  component.dcTableBuilder.incrementCodeCount(t);
  if (t !== 0) receive(reader, t);

  // AC
  for (let i = 1; i < 64;) {
    const s = decodeHuffmanCode(reader, component.acTable);
    component.acTableBuilder.incrementCodeCount(s);
    const r = s >> 4;
    const size = s & 15;
    if (size !== 0) {
      i += r + 1;
      receive(reader, size);
    } else {
      if (r === 0) break;
      i += 16;
    }
  }
}

function copyBlockBaseline(reader, writer, component) {
  // DC
  let symbol = decodeHuffmanCode(reader, component.dcTable);
  component.dcEncodingTable.getCode(symbol);
  writer.writeBits(component.dcEncodingTable.code, component.dcEncodingTable.codeLength);
  if (symbol !== 0) {
    const received = receive(reader, symbol);
    writer.writeBits(received, symbol);
  }

  // AC
  for (let i = 1; i < 64;) {
    symbol = decodeHuffmanCode(reader, component.acTable);
    component.acEncodingTable.getCode(symbol);
    writer.writeBits(component.acEncodingTable.code, component.acEncodingTable.codeLength);
    const r = symbol >> 4;
    const size = symbol & 15;
    if (size !== 0) {
      i += r + 1;
      const received = receive(reader, size);
      writer.writeBits(received, size);
    } else {
      if (r === 0) break;
      i += 16;
    }
  }
}

function copyMarkerData(reader, writer) {
  const length = reader.tryReadLength();
  if (length < 0) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
  const buffer = reader.tryReadBytes(length);
  if (buffer === null) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
  writer.writeLength(length);
  writer.writeBytes(buffer);
  return buffer;
}

function throwAt(offset, message) {
  throw new Error(`Failed to optimize JPEG data at offset ${offset}. ${message}`);
}
