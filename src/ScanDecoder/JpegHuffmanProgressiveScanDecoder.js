// Progressive DCT Huffman decoder (SOF2). Port of JpegHuffmanProgressiveScanDecoder.cs.
// Coefficients from every scan are accumulated in a JpegBlockAllocator; the final
// dequantize + IDCT + level-shift + flush happens in dispose().
import { JpegBitReader } from '../JpegBitReader.js';
import { isRestartMarker, JpegMarker } from '../JpegMarker.js';
import { JpegBlockAllocator } from '../JpegBlockAllocator.js';
import {
  JpegHuffmanDecodingComponent,
  initDecodeComponents,
  finalizeProgressiveBlocks,
  decodeHuffmanCode,
  receiveAndExtend,
  quantIsEmpty,
  throwInvalidData,
} from './common.js';

export class JpegHuffmanProgressiveScanDecoder {
  constructor(decoder, frameHeader) {
    this._decoder = decoder;
    this._frameHeader = frameHeader;

    let maxHorizontalSampling = 1;
    let maxVerticalSampling = 1;
    for (const c of frameHeader.components) {
      maxHorizontalSampling = Math.max(maxHorizontalSampling, c.horizontalSamplingFactor);
      maxVerticalSampling = Math.max(maxVerticalSampling, c.verticalSamplingFactor);
    }

    this._mcusPerLine = Math.trunc((frameHeader.samplesPerLine + 8 * maxHorizontalSampling - 1) / (8 * maxHorizontalSampling));
    this._mcusPerColumn = Math.trunc((frameHeader.numberOfLines + 8 * maxVerticalSampling - 1) / (8 * maxVerticalSampling));
    this._levelShift = 1 << (frameHeader.samplePrecision - 1);

    const outputWriter = decoder.getOutputWriter();
    if (outputWriter == null) throwInvalidData('Output writer is not set.');
    this._outputWriter = outputWriter;

    this._allocator = new JpegBlockAllocator();
    this._allocator.allocate(frameHeader);

    this._restartInterval = 0;
    this._mcusBeforeRestart = 0;
    this._eobrun = 0;

    this._components = new Array(frameHeader.numberOfComponents);
    for (let i = 0; i < this._components.length; i++) {
      this._components[i] = new JpegHuffmanDecodingComponent();
    }
  }

  processScan(reader, scanHeader) {
    if (scanHeader.components == null) throw new Error('Scan components missing.');
    if (this._decoder.getOutputWriter() == null) throw new Error('Output writer is not set.');

    const count = initDecodeComponents(this._decoder, this._frameHeader, scanHeader, this._components);
    const components = this._components.slice(0, count);
    for (const component of components) {
      if (quantIsEmpty(component.quantizationTable)) {
        throwInvalidData(`Quantization table of component ${component.componentIndex} is not defined.`);
      }
    }

    this._restartInterval = this._decoder.getRestartInterval();
    this._mcusBeforeRestart = this._restartInterval;
    this._eobrun = 0;

    if (components.length === 1) {
      this._decodeNonInterleaved(reader, scanHeader, components[0]);
    } else {
      this._decodeInterleaved(reader, scanHeader, components);
    }
  }

  _decodeInterleaved(reader, scanHeader, components) {
    for (const component of components) {
      if (component.dcTable == null) {
        throwInvalidData(`Huffman table of component ${component.componentIndex} is not defined.`);
      }
    }

    const allocator = this._allocator;
    const buffer = allocator.buffer;
    const bitReader = new JpegBitReader(reader.remainingBytes);

    const mcusPerColumn = this._mcusPerColumn;
    const mcusPerLine = this._mcusPerLine;

    for (let rowMcu = 0; rowMcu < mcusPerColumn; rowMcu++) {
      for (let colMcu = 0; colMcu < mcusPerLine; colMcu++) {
        for (const component of components) {
          const index = component.componentIndex;
          const h = component.horizontalSamplingFactor;
          const v = component.verticalSamplingFactor;
          const offsetX = colMcu * h;
          const offsetY = rowMcu * v;

          for (let y = 0; y < v; y++) {
            const blockOffsetY = offsetY + y;
            for (let x = 0; x < h; x++) {
              const offset = allocator.getBlockOffset(index, offsetX + x, blockOffsetY);
              this._readBlockProgressiveDC(bitReader, component, scanHeader, buffer, offset);
            }
          }
        }

        if (!this._handleRestart(bitReader, reader)) return;
      }
    }
  }

  _decodeNonInterleaved(reader, scanHeader, component) {
    const allocator = this._allocator;
    const buffer = allocator.buffer;
    const bitReader = new JpegBitReader(reader.remainingBytes);

    const componentIndex = component.componentIndex;
    const horizontalBlockCount = Math.trunc((this._frameHeader.samplesPerLine + 8 * component.horizontalSubsamplingFactor - 1) / (8 * component.horizontalSubsamplingFactor));
    const verticalBlockCount = Math.trunc((this._frameHeader.numberOfLines + 8 * component.verticalSubsamplingFactor - 1) / (8 * component.verticalSubsamplingFactor));

    if (scanHeader.startOfSpectralSelection === 0) {
      if (component.dcTable == null) {
        throwInvalidData(`Huffman table of component ${componentIndex} is not defined.`);
      }
      for (let blockY = 0; blockY < verticalBlockCount; blockY++) {
        for (let blockX = 0; blockX < horizontalBlockCount; blockX++) {
          const offset = allocator.getBlockOffset(componentIndex, blockX, blockY);
          this._readBlockProgressiveDC(bitReader, component, scanHeader, buffer, offset);
          if (!this._handleRestart(bitReader, reader)) return;
        }
      }
    } else {
      const acTable = component.acTable;
      if (acTable == null) {
        throwInvalidData(`Huffman table of component ${componentIndex} is not defined.`);
      }
      for (let blockY = 0; blockY < verticalBlockCount; blockY++) {
        for (let blockX = 0; blockX < horizontalBlockCount; blockX++) {
          const offset = allocator.getBlockOffset(componentIndex, blockX, blockY);
          this._readBlockProgressiveAC(bitReader, acTable, scanHeader, buffer, offset);
          if (!this._handleRestart(bitReader, reader)) return;
        }
      }
    }
  }

  _handleRestart(bitReader, reader) {
    if (this._restartInterval > 0 && --this._mcusBeforeRestart === 0) {
      bitReader.advanceAlignByte();
      const marker = bitReader.tryReadMarker();
      if (marker === JpegMarker.EndOfImage) {
        const bytesConsumedEoi = reader.remainingByteCount - Math.floor(bitReader.remainingBits / 8);
        reader.tryAdvance(bytesConsumedEoi - 2);
        return false;
      }
      if (!isRestartMarker(marker)) {
        throw new Error('Expect restart marker.');
      }
      this._mcusBeforeRestart = this._restartInterval;
      this._eobrun = 0;
      for (const component of this._components) component.dcPredictor = 0;
    }
    return true;
  }

  _readBlockProgressiveDC(reader, component, scanHeader, buffer, offset) {
    if (scanHeader.successiveApproximationBitPositionHigh === 0) {
      let s = decodeHuffmanCode(reader, component.dcTable);
      if (s !== 0) s = receiveAndExtend(reader, s);
      s += component.dcPredictor;
      component.dcPredictor = s;
      buffer[offset] = s << scanHeader.successiveApproximationBitPositionLow;
    } else {
      if (!reader.tryReadBits(1)) throwInvalidData('Unexpected end of JPEG data stream.');
      buffer[offset] |= reader.bits << scanHeader.successiveApproximationBitPositionLow;
    }
  }

  _readBlockProgressiveAC(reader, acTable, scanHeader, buffer, offset) {
    if (scanHeader.successiveApproximationBitPositionHigh === 0) {
      // AC initial scan
      if (this._eobrun !== 0) {
        this._eobrun--;
        return;
      }
      const start = scanHeader.startOfSpectralSelection;
      const end = scanHeader.endOfSpectralSelection;
      const low = scanHeader.successiveApproximationBitPositionLow;

      for (let i = start; i <= end; i++) {
        const s = decodeHuffmanCode(reader, acTable);
        const r = s >> 4;
        const sl = s & 15;
        i += r;
        if (sl !== 0) {
          const value = receiveAndExtend(reader, sl);
          buffer[offset + Math.min(i, 63)] = value << low;
        } else {
          if (r !== 15) {
            this._eobrun = 1 << r;
            if (r !== 0) {
              if (!reader.tryReadBits(r)) throwInvalidData('Unexpected end of JPEG data stream.');
              this._eobrun += reader.bits;
            }
            this._eobrun--;
            break;
          }
        }
      }
    } else {
      this._readBlockProgressiveACRefined(reader, acTable, scanHeader, buffer, offset);
    }
  }

  _readBlockProgressiveACRefined(reader, acTable, scanHeader, buffer, offset) {
    const start = scanHeader.startOfSpectralSelection;
    const end = scanHeader.endOfSpectralSelection;
    const low = scanHeader.successiveApproximationBitPositionLow;
    const p1 = 1 << low;
    const m1 = (-1) << low;

    let k = start;

    if (this._eobrun === 0) {
      for (; k <= end; k++) {
        const code = decodeHuffmanCode(reader, acTable);
        let r = code >> 4;
        let s = code & 15;

        if (s !== 0) {
          if (!reader.tryReadBits(1)) throwInvalidData('Unexpected end of JPEG data stream.');
          s = reader.bits !== 0 ? p1 : m1;
        } else {
          if (r !== 15) {
            this._eobrun = 1 << r;
            if (r !== 0) {
              if (!reader.tryReadBits(r)) throwInvalidData('Unexpected end of JPEG data stream.');
              this._eobrun += reader.bits;
            }
            break;
          }
        }

        do {
          const idx = offset + k;
          const coef = buffer[idx];
          if (coef !== 0) {
            if (!reader.tryReadBits(1)) throwInvalidData('Unexpected end of JPEG data stream.');
            if (reader.bits !== 0) {
              if ((coef & p1) === 0) {
                buffer[idx] = coef + (coef >= 0 ? p1 : m1);
              }
            }
          } else {
            if (--r < 0) break;
          }
          k++;
        } while (k <= end);

        if (s !== 0 && k < 64) {
          buffer[offset + k] = s;
        }
      }
    }

    if (this._eobrun > 0) {
      for (; k <= end; k++) {
        const idx = offset + k;
        const coef = buffer[idx];
        if (coef !== 0) {
          if (!reader.tryReadBits(1)) throwInvalidData('Unexpected end of JPEG data stream.');
          if (reader.bits !== 0) {
            if ((coef & p1) === 0) {
              buffer[idx] = coef + (coef > 0 ? p1 : m1);
            }
          }
        }
      }
      this._eobrun--;
    }
  }

  dispose() {
    // Final dequantize + IDCT + level shift over every stored block, then flush.
    finalizeProgressiveBlocks(this._decoder, this._frameHeader, this._allocator, this._levelShift, this._outputWriter);
  }
}
