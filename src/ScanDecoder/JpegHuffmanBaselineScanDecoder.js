// Baseline / extended sequential DCT Huffman decoder (SOF0 / SOF1).
// Port of JpegHuffmanBaselineScanDecoder.cs.
import { JpegBitReader } from '../JpegBitReader.js';
import { isRestartMarker, JpegMarker } from '../JpegMarker.js';
import { transformIDCT } from '../dct.js';
import { writeBlock } from '../JpegBlockOutputWriter.js';
import {
  JpegHuffmanDecodingComponent,
  initDecodeComponents,
  dequantizeBlockAndUnZigZag,
  shiftDataLevel,
  decodeHuffmanCode,
  receiveAndExtend,
  quantIsEmpty,
  throwInvalidData,
} from './common.js';

export class JpegHuffmanBaselineScanDecoder {
  constructor(decoder, frameHeader) {
    this._decoder = decoder;
    this._frameHeader = frameHeader;

    let maxHorizontalSampling = 1;
    let maxVerticalSampling = 1;
    for (const c of frameHeader.components) {
      maxHorizontalSampling = Math.max(maxHorizontalSampling, c.horizontalSamplingFactor);
      maxVerticalSampling = Math.max(maxVerticalSampling, c.verticalSamplingFactor);
    }
    this._maxHorizontalSampling = maxHorizontalSampling;
    this._maxVerticalSampling = maxVerticalSampling;

    this._restartInterval = decoder.getRestartInterval();
    this._mcusPerLine = Math.trunc((frameHeader.samplesPerLine + 8 * maxHorizontalSampling - 1) / (8 * maxHorizontalSampling));
    this._mcusPerColumn = Math.trunc((frameHeader.numberOfLines + 8 * maxVerticalSampling - 1) / (8 * maxVerticalSampling));
    this._levelShift = 1 << (frameHeader.samplePrecision - 1);

    this._components = new Array(frameHeader.numberOfComponents);
    for (let i = 0; i < this._components.length; i++) {
      this._components[i] = new JpegHuffmanDecodingComponent();
    }
  }

  processScan(reader, scanHeader) {
    const frameHeader = this._frameHeader;
    const outputWriter = this._decoder.getOutputWriter();

    if (frameHeader.components == null) throwInvalidData('Component parameters are missing in JPEG frame header.');
    if (scanHeader.components == null) throwInvalidData('Component parameters are missing in JPEG scan header.');
    if (outputWriter == null) throw new Error('Output writer is not specified.');

    const count = initDecodeComponents(this._decoder, frameHeader, scanHeader, this._components);
    const components = this._components.slice(0, count);
    for (const component of components) {
      if (component.dcTable == null || component.acTable == null) {
        throwInvalidData(`Huffman table of component ${component.componentIndex} is not defined.`);
      }
      if (quantIsEmpty(component.quantizationTable)) {
        throwInvalidData(`Quantization table of component ${component.componentIndex} is not defined.`);
      }
    }

    const maxHorizontalSampling = this._maxHorizontalSampling;
    const maxVerticalSampling = this._maxVerticalSampling;
    const restartInterval = this._restartInterval;
    let mcusBeforeRestart = restartInterval;
    const mcusPerLine = this._mcusPerLine;
    const mcusPerColumn = this._mcusPerColumn;
    const levelShift = this._levelShift;
    const bitReader = new JpegBitReader(reader.remainingBytes);

    const blockF = new Float32Array(64);
    const outputF = new Float32Array(64);
    const outputBuffer = new Int16Array(64);

    for (let rowMcu = 0; rowMcu < mcusPerColumn; rowMcu++) {
      const offsetY = rowMcu * maxVerticalSampling;
      for (let colMcu = 0; colMcu < mcusPerLine; colMcu++) {
        const offsetX = colMcu * maxHorizontalSampling;

        for (const component of components) {
          const index = component.componentIndex;
          const h = component.horizontalSamplingFactor;
          const v = component.verticalSamplingFactor;
          const hs = component.horizontalSubsamplingFactor;
          const vs = component.verticalSubsamplingFactor;

          for (let y = 0; y < v; y++) {
            const blockOffsetY = (offsetY + y) * 8;
            for (let x = 0; x < h; x++) {
              outputBuffer.fill(0);
              this._readBlockBaseline(bitReader, component, outputBuffer);

              dequantizeBlockAndUnZigZag(component.quantizationTable, outputBuffer, 0, blockF);
              transformIDCT(blockF, outputF);
              shiftDataLevel(outputF, outputBuffer, 0, levelShift);

              writeBlock(outputWriter, outputBuffer, 0, index, (offsetX + x) * 8, blockOffsetY, hs, vs);
            }
          }
        }

        if (restartInterval > 0 && --mcusBeforeRestart === 0) {
          bitReader.advanceAlignByte();
          const marker = bitReader.tryReadMarker();
          if (marker === JpegMarker.EndOfImage) {
            const bytesConsumedEoi = reader.remainingByteCount - Math.floor(bitReader.remainingBits / 8);
            reader.tryAdvance(bytesConsumedEoi - 2);
            return;
          }
          if (!isRestartMarker(marker)) {
            throw new Error('Expect restart marker.');
          }
          mcusBeforeRestart = restartInterval;
          for (const component of components) component.dcPredictor = 0;
        }
      }
    }

    bitReader.advanceAlignByte();
    let bytesConsumed = reader.remainingByteCount - Math.floor(bitReader.remainingBits / 8);
    const peeked = bitReader.tryPeekMarker();
    if (peeked !== 0 && !isRestartMarker(peeked)) {
      bytesConsumed -= 2;
    }
    reader.tryAdvance(bytesConsumed);
  }

  _readBlockBaseline(reader, component, destinationBlock) {
    // DC coefficient
    let t = decodeHuffmanCode(reader, component.dcTable);
    if (t !== 0) {
      t = receiveAndExtend(reader, t);
    }
    t += component.dcPredictor;
    component.dcPredictor = t;
    destinationBlock[0] = t;

    // AC coefficients (zig-zag order)
    const acTable = component.acTable;
    for (let i = 1; i < 64;) {
      const s = decodeHuffmanCode(reader, acTable);
      const r = s >> 4;
      const sl = s & 15;

      if (sl !== 0) {
        i += r;
        const value = receiveAndExtend(reader, sl);
        destinationBlock[Math.min(i, 63)] = value;
        i++;
      } else {
        if (r === 0) break;
        i += 16;
      }
    }
  }

  dispose() {
    // Baseline writes output immediately; nothing to flush.
  }
}
