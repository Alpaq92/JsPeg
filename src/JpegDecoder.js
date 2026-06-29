// The JPEG decoder. Port of JpegDecoder.cs.
import { JpegMarker, isRestartMarker } from './JpegMarker.js';
import { JpegReader } from './JpegReader.js';
import { JpegFrameHeader } from './JpegFrameHeader.js';
import { JpegScanHeader } from './JpegScanHeader.js';
import { JpegQuantizationTable } from './JpegQuantizationTable.js';
import { JpegHuffmanDecodingTable } from './JpegHuffmanDecodingTable.js';
import { JpegArithmeticDecodingTable } from './JpegArithmeticDecodingTable.js';
import { JpegStandardQuantizationTable } from './JpegStandardQuantizationTable.js';
import { clamp } from './JpegMathHelper.js';
import { createScanDecoder } from './ScanDecoder/JpegScanDecoder.js';

export class JpegDecoder {
  constructor() {
    /** @type {Uint8Array} */
    this._inputBuffer = new Uint8Array(0);
    /** @type {JpegFrameHeader|null} */
    this._frameHeader = null;
    this._restartInterval = 0;
    this._maxHorizontalSamplingFactor = null;
    this._maxVerticalSamplingFactor = null;
    this._outputWriter = null;
    this._scanDecoder = null;

    /** @type {JpegQuantizationTable[]|null} */
    this._quantizationTables = null;
    /** @type {JpegHuffmanDecodingTable[]|null} */
    this._huffmanTables = null;
    /** @type {JpegArithmeticDecodingTable[]|null} */
    this._arithmeticTables = null;

    /** Start-of-frame marker of the current image. */
    this.startOfFrame = 0;
  }

  /** @param {Uint8Array} input */
  setInput(input) {
    this._inputBuffer = input;
    this._frameHeader = null;
    this._restartInterval = 0;
  }

  // ---- Identification -----------------------------------------------------

  /** Scan the stream for image metadata. @returns {number} bytes consumed */
  identify(loadQuantizationTables = false) {
    if (this._inputBuffer.length === 0) {
      throw new Error('Input buffer is not specified.');
    }
    const reader = new JpegReader(this._inputBuffer);
    this._frameHeader = null;

    let toContinue = true;
    while (toContinue && !reader.isEmpty) {
      const marker = reader.tryReadMarker();
      if (marker === 0) {
        throwInvalidDataAt(reader.consumedByteCount, 'No marker found.');
      }
      toContinue = this._processMarkerForIdentification(marker, reader, loadQuantizationTables);
    }

    if (this._frameHeader === null) {
      throw new Error('Frame header was not found.');
    }
    return reader.consumedByteCount;
  }

  _processMarkerForIdentification(marker, reader, loadQuantizationTables) {
    switch (marker) {
      case JpegMarker.StartOfImage:
        break;
      case JpegMarker.StartOfFrame0:
      case JpegMarker.StartOfFrame1:
      case JpegMarker.StartOfFrame2:
      case JpegMarker.StartOfFrame3:
      case JpegMarker.StartOfFrame9:
      case JpegMarker.StartOfFrame10:
      case JpegMarker.StartOfFrame5:
      case JpegMarker.StartOfFrame6:
      case JpegMarker.StartOfFrame7:
      case JpegMarker.StartOfFrame11:
      case JpegMarker.StartOfFrame13:
      case JpegMarker.StartOfFrame14:
      case JpegMarker.StartOfFrame15:
        this.startOfFrame = marker;
        this._processFrameHeader(reader, false, false);
        break;
      case JpegMarker.StartOfScan:
        this._processScanHeader(reader, true);
        break;
      case JpegMarker.DefineRestartInterval:
        this._processDefineRestartInterval(reader);
        break;
      case JpegMarker.DefineQuantizationTable:
        this._processDefineQuantizationTable(reader, loadQuantizationTables);
        break;
      case JpegMarker.DefineRestart0:
      case JpegMarker.DefineRestart1:
      case JpegMarker.DefineRestart2:
      case JpegMarker.DefineRestart3:
      case JpegMarker.DefineRestart4:
      case JpegMarker.DefineRestart5:
      case JpegMarker.DefineRestart6:
      case JpegMarker.DefineRestart7:
        break;
      case JpegMarker.EndOfImage:
        return false;
      default:
        this._processOtherMarker(reader);
        break;
    }
    return true;
  }

  // ---- Decoding -----------------------------------------------------------

  /** @param {object} outputWriter a JpegBlockOutputWriter */
  setOutputWriter(outputWriter) {
    if (outputWriter == null) throw new Error('outputWriter is required.');
    this._outputWriter = outputWriter;
  }

  getOutputWriter() {
    return this._outputWriter;
  }

  decode() {
    if (this._inputBuffer.length === 0) throw new Error('Input buffer is not specified.');
    if (this._outputWriter == null) throw new Error('The output buffer is not specified.');

    const reader = new JpegReader(this._inputBuffer);
    this._scanDecoder = null;

    if (!reader.tryReadStartOfImageMarker()) {
      throwInvalidDataAt(reader.consumedByteCount, 'Marker StartOfImage not found.');
    }

    try {
      let toContinue = true;
      while (toContinue && !reader.isEmpty) {
        const marker = reader.tryReadMarker();
        if (marker === 0) {
          throwInvalidDataAt(reader.consumedByteCount, 'No marker found.');
        }
        toContinue = this._processMarkerForDecode(marker, reader);
      }
    } finally {
      if (this._scanDecoder) this._scanDecoder.dispose();
      this._scanDecoder = null;
    }
  }

  _processMarkerForDecode(marker, reader) {
    switch (marker) {
      case JpegMarker.StartOfFrame0:
      case JpegMarker.StartOfFrame1:
      case JpegMarker.StartOfFrame2:
      case JpegMarker.StartOfFrame3:
      case JpegMarker.StartOfFrame9:
      case JpegMarker.StartOfFrame10:
        this.startOfFrame = marker;
        this._processFrameHeader(reader, false, true);
        this._scanDecoder = createScanDecoder(marker, this, this._frameHeader);
        if (this._scanDecoder === null) {
          throwInvalidDataAt(reader.consumedByteCount, `This type of JPEG stream is not supported (0x${marker.toString(16)}).`);
        }
        break;
      case JpegMarker.StartOfFrame5:
      case JpegMarker.StartOfFrame6:
      case JpegMarker.StartOfFrame7:
      case JpegMarker.StartOfFrame11:
      case JpegMarker.StartOfFrame13:
      case JpegMarker.StartOfFrame14:
      case JpegMarker.StartOfFrame15:
        throwInvalidDataAt(reader.consumedByteCount, `This type of JPEG stream is not supported (0x${marker.toString(16)}).`);
        break;
      case JpegMarker.DefineHuffmanTable:
        this._processDefineHuffmanTable(reader);
        break;
      case JpegMarker.DefineArithmeticCodingConditioning:
        this._processDefineArithmeticCodingConditioning(reader);
        break;
      case JpegMarker.DefineQuantizationTable:
        this._processDefineQuantizationTable(reader, true);
        break;
      case JpegMarker.DefineRestartInterval:
        this._processDefineRestartInterval(reader);
        break;
      case JpegMarker.StartOfScan: {
        if (this._scanDecoder === null) {
          throwInvalidDataAt(reader.consumedByteCount, 'Scan header appears before frame header.');
        }
        const scanHeader = this._processScanHeader(reader, false);
        this._scanDecoder.processScan(reader, scanHeader);
        break;
      }
      case JpegMarker.DefineRestart0:
      case JpegMarker.DefineRestart1:
      case JpegMarker.DefineRestart2:
      case JpegMarker.DefineRestart3:
      case JpegMarker.DefineRestart4:
      case JpegMarker.DefineRestart5:
      case JpegMarker.DefineRestart6:
      case JpegMarker.DefineRestart7:
        break;
      case JpegMarker.EndOfImage:
        return false;
      default:
        this._processOtherMarker(reader);
        break;
    }
    return true;
  }

  // ---- Segment processing -------------------------------------------------

  _processOtherMarker(reader) {
    const length = reader.tryReadLength();
    if (length < 0) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data when reading segment length.');
    if (!reader.tryAdvance(length)) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data reached.');
  }

  _processFrameHeader(reader, metadataOnly, overrideAllowed) {
    const length = reader.tryReadLength();
    if (length < 0) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data when reading segment length.');
    const buffer = reader.tryReadBytes(length);
    if (buffer === null) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data when reading segment content.');
    const r = JpegFrameHeader.parse(buffer, metadataOnly);
    if (r === null) throwInvalidDataAt(reader.consumedByteCount - length, 'Failed to parse frame header.');
    if (!overrideAllowed && this._frameHeader !== null) {
      throwInvalidDataAt(reader.consumedByteCount, 'Multiple frame is not supported.');
    }
    this._frameHeader = r.value;
    // A frame may declare numberOfLines === 0 and defer the real height to a DNL
    // ("Define Number of Lines") marker after the first scan. Resolve it now, so
    // the scan decoder and output writer are sized correctly.
    if (r.value.numberOfLines === 0) {
      const lines = resolveDnlHeight(this._inputBuffer, reader.consumedByteCount);
      if (lines > 0) r.value.numberOfLines = lines;
    }
  }

  _processScanHeader(reader, metadataOnly) {
    const length = reader.tryReadLength();
    if (length < 0) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data when reading segment length.');
    const buffer = reader.tryReadBytes(length);
    if (buffer === null) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data when reading segment content.');
    const r = JpegScanHeader.parse(buffer, metadataOnly);
    if (r === null) throwInvalidDataAt(reader.consumedByteCount - length, 'Failed to parse scan header.');
    return r.value;
  }

  _processDefineRestartInterval(reader) {
    const length = reader.tryReadLength();
    if (length < 0) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data when reading segment length.');
    const buffer = reader.tryReadBytes(length);
    if (buffer === null || buffer.length < 2) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data when reading segment content.');
    this._restartInterval = (buffer[0] << 8) | buffer[1];
  }

  _processDefineHuffmanTable(reader) {
    const length = reader.tryReadLength();
    if (length < 0) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data when reading segment length.');
    const buffer = reader.tryReadBytes(length);
    if (buffer === null) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data when reading segment content.');
    let offset = 0;
    while (offset < buffer.length) {
      const r = JpegHuffmanDecodingTable.parse(buffer, offset);
      if (r === null) throwInvalidDataAt(reader.consumedByteCount - length + offset, 'Failed to parse Huffman table.');
      offset += r.bytesConsumed;
      this.setHuffmanTable(r.value);
    }
  }

  _processDefineArithmeticCodingConditioning(reader) {
    const length = reader.tryReadLength();
    if (length < 0) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data when reading segment length.');
    const buffer = reader.tryReadBytes(length);
    if (buffer === null) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data when reading segment content.');
    let offset = 0;
    while (offset < buffer.length) {
      const r = JpegArithmeticDecodingTable.parse(buffer, offset);
      if (r === null) throwInvalidDataAt(reader.consumedByteCount - length + offset, 'Failed to parse arithmetic coding conditioning.');
      offset += r.bytesConsumed;
      this.setArithmeticTable(r.value);
    }
  }

  _processDefineQuantizationTable(reader, loadQuantizationTables) {
    const length = reader.tryReadLength();
    if (length < 0) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data when reading segment length.');
    const buffer = reader.tryReadBytes(length);
    if (buffer === null) throwInvalidDataAt(reader.consumedByteCount, 'Unexpected end of input data when reading segment content.');
    if (!loadQuantizationTables) return;
    let offset = 0;
    while (offset < buffer.length) {
      const r = JpegQuantizationTable.parse(buffer, offset);
      if (r === null) throwInvalidDataAt(reader.consumedByteCount - length + offset, 'Failed to parse quantization table.');
      offset += r.bytesConsumed;
      this.setQuantizationTable(r.value);
    }
  }

  // ---- Tables -------------------------------------------------------------

  setHuffmanTable(table) {
    if (table == null) throw new Error('table is required.');
    let list = this._huffmanTables;
    if (list === null) list = this._huffmanTables = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].tableClass === table.tableClass && list[i].identifier === table.identifier) {
        list[i] = table;
        return;
      }
    }
    list.push(table);
  }

  setQuantizationTable(table) {
    if (table == null || table.isEmpty) throw new Error('No actual quantization table is provided.');
    let list = this._quantizationTables;
    if (list === null) list = this._quantizationTables = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].identifier === table.identifier) {
        list[i] = table;
        return;
      }
    }
    list.push(table);
  }

  getHuffmanTable(isDcTable, identifier) {
    const list = this._huffmanTables;
    if (list === null) return null;
    const tableClass = isDcTable ? 0 : 1;
    for (const item of list) {
      if (item.tableClass === tableClass && item.identifier === identifier) return item;
    }
    return null;
  }

  getQuantizationTable(identifier) {
    const list = this._quantizationTables;
    if (list === null) return null;
    for (const item of list) {
      if (item.identifier === identifier) return item;
    }
    return null;
  }

  setArithmeticTable(table) {
    if (table == null) throw new Error('table is required.');
    let list = this._arithmeticTables;
    if (list === null) list = this._arithmeticTables = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].tableClass === table.tableClass && list[i].identifier === table.identifier) {
        list[i] = table;
        return;
      }
    }
    list.push(table);
  }

  getArithmeticTable(isDcTable, identifier) {
    const list = this._arithmeticTables;
    if (list === null) return null;
    const tableClass = isDcTable ? 0 : 1;
    for (const item of list) {
      if (item.tableClass === tableClass && item.identifier === identifier) return item;
    }
    return null;
  }

  clearHuffmanTable() { if (this._huffmanTables) this._huffmanTables.length = 0; }
  clearQuantizationTable() { if (this._quantizationTables) this._quantizationTables.length = 0; }
  clearArithmeticTable() { if (this._arithmeticTables) this._arithmeticTables.length = 0; }

  // ---- Frame metadata accessors ------------------------------------------

  _getFrameHeader() {
    if (this._frameHeader === null) throw new Error('Call identify() before this operation.');
    return this._frameHeader;
  }

  setFrameHeader(frameHeader) { this._frameHeader = frameHeader; }

  get width() { return this._getFrameHeader().samplesPerLine; }
  get height() { return this._getFrameHeader().numberOfLines; }
  get precision() { return this._getFrameHeader().samplePrecision; }
  get numberOfComponents() { return this._getFrameHeader().numberOfComponents; }

  getMaximumHorizontalSampling() {
    if (this._maxHorizontalSamplingFactor !== null) return this._maxHorizontalSamplingFactor;
    const frameHeader = this._getFrameHeader();
    let max = 1;
    for (const c of frameHeader.components) max = Math.max(max, c.horizontalSamplingFactor);
    this._maxHorizontalSamplingFactor = max;
    return max;
  }

  getMaximumVerticalSampling() {
    if (this._maxVerticalSamplingFactor !== null) return this._maxVerticalSamplingFactor;
    const frameHeader = this._getFrameHeader();
    let max = 1;
    for (const c of frameHeader.components) max = Math.max(max, c.verticalSamplingFactor);
    this._maxVerticalSamplingFactor = max;
    return max;
  }

  getHorizontalSampling(componentIndex) {
    const components = this._getFrameHeader().components;
    if ((componentIndex >>> 0) >= components.length) throw new RangeError('componentIndex');
    return components[componentIndex].horizontalSamplingFactor;
  }

  getVerticalSampling(componentIndex) {
    const components = this._getFrameHeader().components;
    if ((componentIndex >>> 0) >= components.length) throw new RangeError('componentIndex');
    return components[componentIndex].verticalSamplingFactor;
  }

  getRestartInterval() { return this._restartInterval; }
  setRestartInterval(restartInterval) {
    if ((restartInterval >>> 0) > 0xffff) throw new RangeError('restartInterval');
    this._restartInterval = restartInterval;
  }

  // ---- Quality estimation -------------------------------------------------

  /** @returns {{ ok: boolean, quality: number }} */
  tryEstimateQuality() {
    if (this._quantizationTables === null) return { ok: false, quality: 0 };

    let table = this.getQuantizationTable(0);
    if (table == null || table.isEmpty) return { ok: false, quality: 0 };
    let quality = estimateQuality(table, JpegStandardQuantizationTable.getLuminanceTable(0, 0));

    table = this.getQuantizationTable(1);
    if (table != null && !table.isEmpty) {
      const quality2 = estimateQuality(table, JpegStandardQuantizationTable.getChrominanceTable(0, 0));
      quality = Math.min(quality, quality2);
    }

    return { ok: true, quality: clamp(quality, 0, 100) };
  }

  // ---- Reset --------------------------------------------------------------

  reset() {
    this.resetInput();
    this.resetHeader();
    this.resetTables();
    this.resetOutputWriter();
  }

  resetInput() { this._inputBuffer = new Uint8Array(0); }
  resetHeader() {
    this._frameHeader = null;
    this._restartInterval = 0;
    this._maxHorizontalSamplingFactor = null;
    this._maxVerticalSamplingFactor = null;
  }
  resetTables() {
    if (this._huffmanTables) this._huffmanTables.length = 0;
    if (this._quantizationTables) this._quantizationTables.length = 0;
    if (this._arithmeticTables) this._arithmeticTables.length = 0;
  }
  resetOutputWriter() { this._outputWriter = null; }
}

function estimateQuality(quantizationTable, standardTable) {
  let allOnes = true;
  let dSumPercent = 0;
  const elements = quantizationTable.elements;
  const standard = standardTable.elements;

  for (let i = 0; i < 64; i++) {
    const element = elements[i];
    let dComparePercent;
    if (element === 0) {
      dComparePercent = 999.99;
    } else {
      dComparePercent = (100.0 * element) / standard[i];
    }
    dSumPercent += dComparePercent;
    if (element !== 1) allOnes = false;
  }

  dSumPercent /= 64.0;

  if (allOnes) return 100.0;
  if (dSumPercent <= 100.0) return (200.0 - dSumPercent) / 2.0;
  return 5000.0 / dSumPercent;
}

function throwInvalidDataAt(offset, message) {
  throw new Error(`Failed to decode JPEG data at offset ${offset}. ${message}`);
}

// Find the height carried by a DNL ("Define Number of Lines") marker, used when a
// frame declares numberOfLines === 0. Walks the marker structure from `from`,
// skipping length-prefixed segments and the entropy-coded scan data (FF00 byte
// stuffing + RSTn). Returns 0 if no DNL is found before EOI / end of input.
function resolveDnlHeight(buffer, from) {
  const len = buffer.length;
  let p = from;
  while (p + 1 < len) {
    if (buffer[p] !== 0xff) { p++; continue; }
    let m = buffer[p + 1];
    while (m === 0xff && p + 2 < len) { p++; m = buffer[p + 1]; } // skip fill bytes
    if (m === 0x00 || isRestartMarker(m)) { p += 2; continue; } // FF00 stuffing / RSTn inside a scan
    if (m === JpegMarker.DefineNumberOfLines) return p + 6 <= len ? ((buffer[p + 4] << 8) | buffer[p + 5]) : 0;
    if (m === JpegMarker.EndOfImage) return 0; // EOI before any DNL
    if (m === JpegMarker.StartOfImage || m === 0x01) { p += 2; continue; } // SOI / TEM carry no length
    if (p + 4 > len) break;
    p += 2 + ((buffer[p + 2] << 8) | buffer[p + 3]); // skip a length-prefixed segment (incl. the SOS header)
  }
  return 0;
}
