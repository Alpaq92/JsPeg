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
import { JpegScanHeader, JpegScanComponentSpecificationParameters } from './JpegScanHeader.js';
import {
  JpegArithmeticSequentialScanEncoder,
  DEFAULT_DC_L,
  DEFAULT_DC_U,
  DEFAULT_AC_KX,
} from './ScanEncoder/JpegArithmeticSequentialScanEncoder.js';
import { JpegArithmeticProgressiveScanEncoder } from './ScanEncoder/JpegArithmeticProgressiveScanEncoder.js';
import { JpegQuantizationTable } from './JpegQuantizationTable.js';
import { JpegHuffmanDecodingTable } from './JpegHuffmanDecodingTable.js';
import { JpegHuffmanEncodingTableBuilderCollection } from './JpegHuffmanEncodingTableBuilderCollection.js';
import { JpegBlockAllocator } from './JpegBlockAllocator.js';
import { JpegStandardHuffmanEncodingTable } from './JpegStandardHuffmanEncodingTable.js';
import { encodeBlock, gatherBlockStatistics } from './JpegEncoder.js';
import { trellisBlock, buildAcCostTable } from './JpegTrellis.js';
import { writeProgressiveScan } from './ScanEncoder/JpegHuffmanProgressiveScanEncoder.js';
import { decodeHuffmanCode, receiveAndExtend } from './ScanDecoder/common.js';

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
      let componentIndex = 0;
      for (let j = 0; j < frameHeader.numberOfComponents; j++) {
        if (scanComponent.scanComponentSelector === frameHeader.components[j].identifier) {
          frameComponent = frameHeader.components[j];
          componentIndex = j;
        }
      }
      if (frameComponent === null) throw new Error('Component is missing.');
      const component = {
        componentIndex,
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

  // ---- Progressive transcode (baseline -> progressive, lossless) ----------

  /** Transcode the baseline input to a progressive JPEG. @returns {Uint8Array} */
  optimizeProgressive(strip = true) {
    const { frameHeader, allocator, appSegments } = this._extractBaseline(strip);
    const writer = new JpegWriter();

    this._writeImagePreamble(writer, appSegments, strip);
    this._writeStartOfFrame(writer, JpegMarker.StartOfFrame2, frameHeader);

    for (const scan of buildSimpleProgression(frameHeader.numberOfComponents)) {
      writeProgressiveScan(writer, frameHeader, allocator, scan, this.mostOptimalCoding);
    }

    writer.writeMarker(JpegMarker.EndOfImage);
    return writer.toUint8Array().slice();
  }

  // SOI, optional copied metadata segments, then the quantization tables —
  // the shared opening of every re-emitted stream.
  _writeImagePreamble(writer, appSegments, strip) {
    writer.writeMarker(JpegMarker.StartOfImage);
    if (!strip) {
      for (const seg of appSegments) {
        writer.writeMarker(seg.marker);
        writer.writeLength(seg.data.length);
        writer.writeBytes(seg.data);
      }
    }
    this._writeQuantizationTables(writer);
  }

  // The frame-header body is identical for every SOF type — only the marker
  // differs — so one writer serves baseline/progressive/arithmetic alike.
  _writeStartOfFrame(writer, marker, frameHeader) {
    writer.writeMarker(marker);
    writer.writeLength(frameHeader.bytesRequired);
    const buf = new Uint8Array(frameHeader.bytesRequired);
    frameHeader.write(buf, 0);
    writer.writeBytes(buf);
  }

  // ---- Arithmetic transcode (baseline -> SOF9 arithmetic, lossless) -------

  /** Transcode the baseline input to an arithmetic-coded (SOF9) JPEG. Smaller
   *  than Huffman, but note: browsers cannot display arithmetic JPEGs.
   *  @returns {Uint8Array} */
  optimizeArithmetic(strip = true) {
    const { frameHeader, allocator, appSegments } = this._extractBaseline(strip);
    const writer = new JpegWriter();

    this._writeImagePreamble(writer, appSegments, strip);

    this._writeStartOfFrame(writer, JpegMarker.StartOfFrame9, frameHeader);

    this._writeArithmeticConditioning(writer, frameHeader.numberOfComponents);
    this._writeArithmeticScanHeader(writer, frameHeader);

    const encoder = new JpegArithmeticSequentialScanEncoder(frameHeader);
    writer.writeBytes(encoder.encode(allocator));

    writer.writeMarker(JpegMarker.EndOfImage);
    return writer.toUint8Array().slice();
  }

  // DAC marker with the default conditioning the encoder uses (DC L=0/U=1, AC Kx=5),
  // one DC+AC table for luma and, if multi-component, one for chroma.
  _writeArithmeticConditioning(writer, numComponents) {
    // Derived from the encoder's conditioning (single source of truth) so the
    // DAC marker can never drift from the contexts the encoder actually uses.
    const dc = (DEFAULT_DC_U << 4) | DEFAULT_DC_L;
    const tables = [[0, 0, dc], [1, 0, DEFAULT_AC_KX]];
    if (numComponents > 1) tables.push([0, 1, dc], [1, 1, DEFAULT_AC_KX]);
    writer.writeMarker(JpegMarker.DefineArithmeticCodingConditioning);
    writer.writeLength(2 * tables.length);
    for (const [tc, td, value] of tables) {
      writer.writeBytes(Uint8Array.of((tc << 4) | td, value));
    }
  }

  _writeArithmeticScanHeader(writer, frameHeader) {
    const components = frameHeader.components.map(
      (fc, i) => new JpegScanComponentSpecificationParameters(fc.identifier, i === 0 ? 0 : 1, i === 0 ? 0 : 1),
    );
    const scanHeader = new JpegScanHeader(components.length, components, 0, 63, 0, 0);
    writer.writeMarker(JpegMarker.StartOfScan);
    writer.writeLength(scanHeader.bytesRequired);
    const buf = new Uint8Array(scanHeader.bytesRequired);
    scanHeader.write(buf, 0);
    writer.writeBytes(buf);
  }

  // ---- Arithmetic progressive transcode (baseline -> SOF10, lossless) -----

  /** Transcode the baseline input to an arithmetic-coded progressive (SOF10) JPEG
   *  — combines the QM-coder with progressive successive approximation. As with
   *  SOF9, browsers cannot display arithmetic JPEGs. @returns {Uint8Array} */
  optimizeArithmeticProgressive(strip = true) {
    const { frameHeader, allocator, appSegments } = this._extractBaseline(strip);
    const writer = new JpegWriter();

    this._writeImagePreamble(writer, appSegments, strip);

    this._writeStartOfFrame(writer, JpegMarker.StartOfFrame10, frameHeader);

    this._writeArithmeticConditioning(writer, frameHeader.numberOfComponents);

    const encoder = new JpegArithmeticProgressiveScanEncoder(frameHeader);
    for (const scan of buildSimpleProgression(frameHeader.numberOfComponents)) {
      const entropy = encoder.encode(scan, allocator);
      this._writeArithmeticProgressiveScanHeader(writer, frameHeader, scan);
      writer.writeBytes(entropy);
    }

    writer.writeMarker(JpegMarker.EndOfImage);
    return writer.toUint8Array().slice();
  }

  _writeArithmeticProgressiveScanHeader(writer, frameHeader, scan) {
    const isDc = scan.ss === 0;
    const cls = scan.comp === 0 ? 0 : 1; // luma vs chroma conditioning bank
    const identifier = frameHeader.components[scan.comp].identifier;
    const component = new JpegScanComponentSpecificationParameters(identifier, isDc ? cls : 0, isDc ? 0 : cls);
    const scanHeader = new JpegScanHeader(1, [component], scan.ss, scan.se, scan.ah, scan.al);
    writer.writeMarker(JpegMarker.StartOfScan);
    writer.writeLength(scanHeader.bytesRequired);
    const buf = new Uint8Array(scanHeader.bytesRequired);
    scanHeader.write(buf, 0);
    writer.writeBytes(buf);
  }

  // ---- Trellis quantization (lossy R-D thresholding) ----------------------

  /** Lossily re-quantize via R-D optimal AC thresholding, then re-encode
   *  baseline. Smaller at a small, bounded quality cost. @returns {Uint8Array} */
  optimizeTrellis(lambda = 3, strip = true) {
    const { frameHeader, allocator, appSegments } = this._extractBaseline(strip);
    const lumaAc = buildAcCostTable(JpegStandardHuffmanEncodingTable.getLuminanceACTable());
    const chromaAc = buildAcCostTable(JpegStandardHuffmanEncodingTable.getChrominanceACTable());
    const buffer = allocator.buffer;

    for (let ci = 0; ci < frameHeader.numberOfComponents; ci++) {
      const quant = this._getQuantizationTableById(frameHeader.components[ci].quantizationTableSelector);
      if (quant == null) throwAt(0, 'Quantization table is missing for trellis.');
      const acCost = ci === 0 ? lumaAc : chromaAc;
      const info = allocator.componentInfo(ci);
      for (let by = 0; by < info.vBlocks; by++) {
        for (let bx = 0; bx < info.hBlocks; bx++) {
          trellisBlock(buffer, allocator.getBlockOffset(ci, bx, by), quant.elements, acCost, lambda);
        }
      }
    }

    return this._reencodeBaseline(frameHeader, allocator, appSegments, strip);
  }

  _getQuantizationTableById(identifier) {
    if (this._quantizationTables === null) return null;
    for (const t of this._quantizationTables) if (t.identifier === identifier) return t;
    return null;
  }

  // Re-encode a coefficient allocator as a baseline JPEG with optimal Huffman
  // tables (luma DC0/AC0, chroma DC1/AC1). Used after trellis re-quantization.
  _reencodeBaseline(frameHeader, allocator, appSegments, strip) {
    let maxH = 1;
    let maxV = 1;
    for (const c of frameHeader.components) {
      maxH = Math.max(maxH, c.horizontalSamplingFactor);
      maxV = Math.max(maxV, c.verticalSamplingFactor);
    }
    const mcusPerLine = Math.trunc((frameHeader.samplesPerLine + 8 * maxH - 1) / (8 * maxH));
    const mcusPerColumn = Math.trunc((frameHeader.numberOfLines + 8 * maxV - 1) / (8 * maxV));

    const builders = new JpegHuffmanEncodingTableBuilderCollection();
    const components = frameHeader.components.map((fc, i) => {
      const dcId = i === 0 ? 0 : 1;
      const acId = i === 0 ? 0 : 1;
      return {
        index: i,
        horizontalSamplingFactor: fc.horizontalSamplingFactor,
        verticalSamplingFactor: fc.verticalSamplingFactor,
        dcId,
        acId,
        dcPredictor: 0,
        dcTableBuilder: builders.getOrCreateTableBuilder(true, dcId),
        acTableBuilder: builders.getOrCreateTableBuilder(false, acId),
        dcTable: null,
        acTable: null,
      };
    });
    const buffer = allocator.buffer;

    const walk = (fn) => {
      for (let rowMcu = 0; rowMcu < mcusPerColumn; rowMcu++) {
        for (let colMcu = 0; colMcu < mcusPerLine; colMcu++) {
          for (const c of components) {
            const h = c.horizontalSamplingFactor;
            const v = c.verticalSamplingFactor;
            const baseCol = colMcu * h;
            const baseRow = rowMcu * v;
            for (let y = 0; y < v; y++) {
              for (let x = 0; x < h; x++) {
                fn(c, allocator.getBlockOffset(c.index, baseCol + x, baseRow + y));
              }
            }
          }
        }
      }
    };

    walk((c, off) => gatherBlockStatistics(c, buffer, off));
    const tables = builders.buildTables(this.mostOptimalCoding);
    for (const c of components) {
      c.dcPredictor = 0;
      c.dcTable = tables.getTable(true, c.dcId);
      c.acTable = tables.getTable(false, c.acId);
    }

    const writer = new JpegWriter();
    this._writeImagePreamble(writer, appSegments, strip);

    this._writeStartOfFrame(writer, JpegMarker.StartOfFrame0, frameHeader);

    writer.writeMarker(JpegMarker.DefineHuffmanTable);
    writer.writeLength(tables.getTotalBytesRequired());
    tables.write(writer);

    const scanComponents = components.map(
      (c) => new JpegScanComponentSpecificationParameters(frameHeader.components[c.index].identifier, c.dcId, c.acId),
    );
    const scanHeader = new JpegScanHeader(scanComponents.length, scanComponents, 0, 63, 0, 0);
    writer.writeMarker(JpegMarker.StartOfScan);
    writer.writeLength(scanHeader.bytesRequired);
    const sbuf = new Uint8Array(scanHeader.bytesRequired);
    scanHeader.write(sbuf, 0);
    writer.writeBytes(sbuf);

    writer.enterBitMode();
    walk((c, off) => encodeBlock(writer, c, buffer, off));
    writer.exitBitMode();

    writer.writeMarker(JpegMarker.EndOfImage);
    return writer.toUint8Array().slice();
  }

  // Walk the baseline file, capturing the frame header, quantization tables and
  // metadata, and decoding the scan's quantized coefficients into an allocator.
  _extractBaseline(strip = true) {
    if (this._inputBuffer.length === 0) throw new Error('Input buffer is not specified.');
    const reader = new JpegReader(this._inputBuffer);
    this._frameHeader = null;
    this._restartInterval = 0;
    const appSegments = [];
    let allocator = null;

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
          if (this._frameHeader === null) throwAt(reader.consumedByteCount, 'No frame header before scan.');
          allocator = new JpegBlockAllocator();
          allocator.allocate(this._frameHeader);
          this._extractScanBaseline(reader, scanHeader, allocator);
          break;
        }
        case JpegMarker.EndOfImage:
          endOfImage = true;
          break;
        default: {
          if (marker >= JpegMarker.DefineRestart0 && marker <= JpegMarker.DefineRestart7) break;
          const length = reader.tryReadLength();
          if (length < 0) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
          if (strip) {
            if (!reader.tryAdvance(length)) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
          } else {
            const data = reader.tryReadBytes(length);
            if (data === null) throwAt(reader.consumedByteCount, 'Unexpected end of input.');
            appSegments.push({ marker, data: data.slice() });
          }
          break;
        }
      }
    }

    if (allocator === null) throwAt(reader.consumedByteCount, 'No image data is read.');
    return { frameHeader: this._frameHeader, allocator, appSegments };
  }

  _extractScanBaseline(reader, scanHeader, allocator) {
    const frameHeader = this._frameHeader;
    let maxH = 1;
    let maxV = 1;
    for (const c of frameHeader.components) {
      maxH = Math.max(maxH, c.horizontalSamplingFactor);
      maxV = Math.max(maxV, c.verticalSamplingFactor);
    }

    const components = this._resolveComponents(scanHeader, (component) => { component.dcPredictor = 0; });
    const buffer = allocator.buffer;
    const mcusPerLine = Math.trunc((frameHeader.samplesPerLine + 8 * maxH - 1) / (8 * maxH));
    const mcusPerColumn = Math.trunc((frameHeader.numberOfLines + 8 * maxV - 1) / (8 * maxV));
    const bitReader = new JpegBitReader(reader.remainingBytes);
    let mcusBeforeRestart = this._restartInterval;

    for (let rowMcu = 0; rowMcu < mcusPerColumn; rowMcu++) {
      for (let colMcu = 0; colMcu < mcusPerLine; colMcu++) {
        for (const component of components) {
          const h = component.horizontalSamplingFactor;
          const v = component.verticalSamplingFactor;
          for (let y = 0; y < v; y++) {
            for (let x = 0; x < h; x++) {
              const off = allocator.getBlockOffset(component.componentIndex, colMcu * h + x, rowMcu * v + y);
              extractBlockBaseline(bitReader, component, buffer, off);
            }
          }
        }
        if (this._restartInterval > 0 && --mcusBeforeRestart === 0) {
          bitReader.advanceAlignByte();
          const marker = bitReader.tryReadMarker();
          if (marker === JpegMarker.EndOfImage) return;
          if (!isRestartMarker(marker)) throw new Error('Expect restart marker.');
          mcusBeforeRestart = this._restartInterval;
          for (const component of components) component.dcPredictor = 0;
        }
      }
    }
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

function extractBlockBaseline(reader, component, buffer, off) {
  // DC: absolute coefficient (predictor + diff)
  const t = decodeHuffmanCode(reader, component.dcTable);
  const diff = t !== 0 ? receiveAndExtend(reader, t) : 0;
  component.dcPredictor += diff;
  buffer[off] = component.dcPredictor;
  // AC (zig-zag order)
  for (let i = 1; i < 64;) {
    const s = decodeHuffmanCode(reader, component.acTable);
    const r = s >> 4;
    const size = s & 15;
    if (size !== 0) {
      i += r;
      if (i >= 64) break;
      buffer[off + i] = receiveAndExtend(reader, size);
      i++;
    } else {
      if (r === 0) break;
      i += 16;
    }
  }
}

// libjpeg-style "simple progression" scan script (spectral selection only): all
// components' DC first (for an early preview), then each component's full AC band.
// A standard 1-bit successive-approximation progression: each band is sent first
// at reduced precision (point transform Al=1), then refined by its lowest bit. The
// refinement bits are cheap, so the result is meaningfully smaller than a plain
// spectral-selection transcode on real images (the extra scan headers can cost
// more than they save on very small ones).
function buildSimpleProgression(numComponents) {
  const scans = [];
  for (let c = 0; c < numComponents; c++) {
    scans.push({ comp: c, ss: 0, se: 0, ah: 0, al: 1 }); // DC first (point transform)
    scans.push({ comp: c, ss: 1, se: 63, ah: 0, al: 1 }); // AC first (point transform)
    scans.push({ comp: c, ss: 1, se: 63, ah: 1, al: 0 }); // AC refinement (low bit)
    scans.push({ comp: c, ss: 0, se: 0, ah: 1, al: 0 }); // DC refinement (low bit)
  }
  return scans;
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
