// Lossless (sequential) Huffman decoder (SOF3). Port of JpegHuffmanLosslessScanDecoder.cs.
// Uses the 7 standard one-/two-dimensional predictors.
import { JpegBitReader } from '../JpegBitReader.js';
import { isRestartMarker, JpegMarker } from '../JpegMarker.js';
import { JpegPartialScanlineAllocator } from '../JpegPartialScanlineAllocator.js';
import {
  JpegHuffmanDecodingComponent,
  initDecodeComponents,
  decodeHuffmanCode,
  receiveAndExtend,
  throwInvalidData,
} from './common.js';

export class JpegHuffmanLosslessScanDecoder {
  constructor(decoder, frameHeader) {
    this._decoder = decoder;
    this._frameHeader = frameHeader;

    let maxHorizontalSampling = 1;
    let maxVerticalSampling = 1;
    for (const c of frameHeader.components) {
      maxHorizontalSampling = Math.max(maxHorizontalSampling, c.horizontalSamplingFactor);
      maxVerticalSampling = Math.max(maxVerticalSampling, c.verticalSamplingFactor);
    }

    this._restartInterval = decoder.getRestartInterval();
    this._mcusPerLine = Math.trunc((frameHeader.samplesPerLine + maxHorizontalSampling - 1) / maxHorizontalSampling);
    this._mcusPerColumn = Math.trunc((frameHeader.numberOfLines + maxVerticalSampling - 1) / maxVerticalSampling);

    const outputWriter = decoder.getOutputWriter();
    if (outputWriter == null) throwInvalidData('Output writer is not set.');
    this._allocator = new JpegPartialScanlineAllocator(outputWriter);
    this._allocator.allocate(frameHeader);

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
      if (component.dcTable == null) {
        throwInvalidData(`Huffman table of component ${component.componentIndex} is not defined.`);
      }
    }

    const allocator = this._allocator;
    const mcusPerLine = this._mcusPerLine;
    const mcusPerColumn = this._mcusPerColumn;

    const bitReader = new JpegBitReader(reader.remainingBytes);
    const restartInterval = this._restartInterval;
    let mcusBeforeRestart = restartInterval;
    const predictor = scanHeader.startOfSpectralSelection;
    const initialPrediction = 1 << (this._frameHeader.samplePrecision - scanHeader.successiveApproximationBitPositionLow - 1);

    for (let rowMcu = 0; rowMcu < mcusPerColumn; rowMcu++) {
      for (let colMcu = 0; colMcu < mcusPerLine; colMcu++) {
        for (const component of components) {
          const index = component.componentIndex;
          const losslessTable = component.dcTable;
          const h = component.horizontalSamplingFactor;
          const v = component.verticalSamplingFactor;
          const offsetX = colMcu * h;
          const offsetY = rowMcu * v;

          for (let y = 0; y < v; y++) {
            const scanline = allocator.getScanlineSpan(index, offsetY + y);
            const lastScanline = (y === 0 && rowMcu === 0) ? null : allocator.getScanlineSpan(index, offsetY + y - 1);

            for (let x = 0; x < h; x++) {
              let diffValue = readSampleLossless(bitReader, losslessTable);
              const px = offsetX + x;

              if (rowMcu === 0 || (restartInterval > 0 && mcusBeforeRestart === restartInterval)) {
                if (colMcu === 0 && x === 0) {
                  diffValue += initialPrediction;
                } else if (y === 0) {
                  // First line: the horizontal predictor Ra is forced regardless of
                  // the selected predictor (T.81 H.1.2.1).
                  diffValue += scanline[px - 1];
                } else {
                  const ra = scanline[px - 1];
                  const rb = lastScanline[px];
                  const rc = lastScanline[px - 1];
                  diffValue += predict(predictor, ra, rb, rc);
                }
              } else if (colMcu === 0) {
                diffValue += lastScanline[px];
              } else {
                const ra = scanline[px - 1];
                const rb = lastScanline[px];
                const rc = lastScanline[px - 1];
                diffValue += predict(predictor, ra, rb, rc);
              }

              scanline[px] = diffValue;
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
        }
      }

      if (rowMcu === mcusPerColumn - 1) {
        for (const component of components) {
          allocator.flushLastMcu(component.componentIndex, (rowMcu + 1) * component.verticalSamplingFactor);
        }
      } else {
        for (const component of components) {
          allocator.flushMcu(component.componentIndex, (rowMcu + 1) * component.verticalSamplingFactor);
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

  dispose() {
    // Lossless flushes during the scan; nothing deferred.
  }
}

function readSampleLossless(reader, losslessTable) {
  let t = decodeHuffmanCode(reader, losslessTable);
  if (t === 16) {
    t = 32768;
  } else if (t !== 0) {
    t = receiveAndExtend(reader, t);
  }
  return t;
}

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
