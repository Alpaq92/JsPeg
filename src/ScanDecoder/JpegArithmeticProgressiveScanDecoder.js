// Arithmetic-coded progressive DCT decoder (SOF10).
// Port of JpegArithmeticProgressiveScanDecoder.cs.
import { JpegBitReader } from '../JpegBitReader.js';
import { isRestartMarker, JpegMarker } from '../JpegMarker.js';
import { JpegBlockAllocator } from '../JpegBlockAllocator.js';
import { finalizeProgressiveBlocks, throwInvalidData } from './common.js';
import { JpegArithmeticScanDecoder, JpegArithmeticDecodingComponent } from './JpegArithmeticScanDecoder.js';

export class JpegArithmeticProgressiveScanDecoder extends JpegArithmeticScanDecoder {
  constructor(decoder, frameHeader) {
    super(decoder);
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

    this._components = new Array(frameHeader.numberOfComponents);
    for (let i = 0; i < this._components.length; i++) {
      this._components[i] = new JpegArithmeticDecodingComponent();
    }
  }

  processScan(reader, scanHeader) {
    if (scanHeader.components == null) throw new Error('Scan components missing.');
    if (this._decoder.getOutputWriter() == null) throw new Error('Output writer is not set.');

    const count = this.initDecodeComponents(this._frameHeader, scanHeader, this._components);
    const components = this._components.slice(0, count);

    for (const component of this._components) {
      if (scanHeader.startOfSpectralSelection === 0 && scanHeader.successiveApproximationBitPositionHigh === 0) {
        component.dcPredictor = 0;
        component.dcContext = 0;
        if (component.dcStatistics) component.dcStatistics.reset();
      }
      if (scanHeader.startOfSpectralSelection !== 0 && component.acStatistics) {
        component.acStatistics.reset();
      }
    }

    this._restartInterval = this._decoder.getRestartInterval();
    this._mcusBeforeRestart = this._restartInterval;
    this.reset();

    if (components.length === 1) {
      this._decodeNonInterleaved(reader, scanHeader, components[0]);
    } else {
      this._decodeInterleaved(reader, scanHeader, components);
    }
  }

  _decodeInterleaved(reader, scanHeader, components) {
    for (const component of components) {
      if (component.dcTable == null || component.dcStatistics == null) throwInvalidData('DC table is missing.');
    }
    const allocator = this._allocator;
    const buffer = allocator.buffer;
    const bitReader = new JpegBitReader(reader.remainingBytes);

    for (let rowMcu = 0; rowMcu < this._mcusPerColumn; rowMcu++) {
      for (let colMcu = 0; colMcu < this._mcusPerLine; colMcu++) {
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
        if (!this._handleRestart(bitReader, reader, scanHeader, components)) return;
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
      if (component.dcTable == null || component.dcStatistics == null) throwInvalidData('DC table is missing.');
      for (let blockY = 0; blockY < verticalBlockCount; blockY++) {
        for (let blockX = 0; blockX < horizontalBlockCount; blockX++) {
          const offset = allocator.getBlockOffset(componentIndex, blockX, blockY);
          this._readBlockProgressiveDC(bitReader, component, scanHeader, buffer, offset);
          if (!this._handleRestart(bitReader, reader, scanHeader, this._components)) return;
        }
      }
    } else {
      if (component.acTable == null || component.acStatistics == null) throwInvalidData('AC table is missing');
      for (let blockY = 0; blockY < verticalBlockCount; blockY++) {
        for (let blockX = 0; blockX < horizontalBlockCount; blockX++) {
          const offset = allocator.getBlockOffset(componentIndex, blockX, blockY);
          this._readBlockProgressiveAC(bitReader, component, scanHeader, buffer, offset);
          if (!this._handleRestart(bitReader, reader, scanHeader, this._components)) return;
        }
      }
    }
  }

  _handleRestart(bitReader, reader, scanHeader, components) {
    if (this._restartInterval > 0 && --this._mcusBeforeRestart === 0) {
      bitReader.advanceAlignByte();
      const marker = bitReader.tryReadMarker();
      if (marker === JpegMarker.EndOfImage) {
        const bytesConsumedEoi = reader.remainingByteCount - Math.floor(bitReader.remainingBits / 8);
        reader.tryAdvance(bytesConsumedEoi - 2);
        return false;
      }
      if (!isRestartMarker(marker)) throw new Error('Expect restart marker.');
      this._mcusBeforeRestart = this._restartInterval;
      for (const component of components) {
        if (scanHeader.startOfSpectralSelection === 0 && scanHeader.successiveApproximationBitPositionHigh === 0) {
          component.dcPredictor = 0;
          component.dcContext = 0;
          if (component.dcStatistics) component.dcStatistics.reset();
        }
        if (scanHeader.startOfSpectralSelection !== 0 && component.acStatistics) {
          component.acStatistics.reset();
        }
      }
      this.reset();
    }
    return true;
  }

  _readBlockProgressiveDC(reader, component, scanHeader, buffer, offset) {
    if (scanHeader.successiveApproximationBitPositionHigh === 0) {
      const dcData = component.dcStatistics.data;
      const dcTable = component.dcTable;
      let st = component.dcContext;
      if (this.decodeBinaryDecision(reader, dcData, st) === 0) {
        component.dcContext = 0;
      } else {
        const sign = this.decodeBinaryDecision(reader, dcData, st + 1);
        st = st + 2 + sign;
        let m = this.decodeBinaryDecision(reader, dcData, st);
        if (m !== 0) {
          st = 20;
          while (this.decodeBinaryDecision(reader, dcData, st) !== 0) {
            m <<= 1;
            if (m === 0x8000) throwInvalidData('Invalid arithmetic code.');
            st = st + 1;
          }
        }
        if (m < ((1 << dcTable.dcL) >> 1)) component.dcContext = 0;
        else if (m > ((1 << dcTable.dcU) >> 1)) component.dcContext = 12 + sign * 4;
        else component.dcContext = 4 + sign * 4;

        let v = m;
        st = st + 14;
        while ((m >>= 1) !== 0) {
          if (this.decodeBinaryDecision(reader, dcData, st) !== 0) v |= m;
        }
        v += 1;
        if (sign !== 0) v = -v;
        component.dcPredictor = ((component.dcPredictor + v) << 16) >> 16;
      }
      buffer[offset] = component.dcPredictor << scanHeader.successiveApproximationBitPositionLow;
    } else {
      // Refinement scan
      buffer[offset] |= this.decodeBinaryDecision(reader, this._fixedBin, 0) << scanHeader.successiveApproximationBitPositionLow;
    }
  }

  _readBlockProgressiveAC(reader, component, scanHeader, buffer, offset) {
    const acData = component.acStatistics.data;
    const acTable = component.acTable;
    if (scanHeader.successiveApproximationBitPositionHigh === 0) {
      const start = scanHeader.startOfSpectralSelection;
      const end = scanHeader.endOfSpectralSelection;
      const low = scanHeader.successiveApproximationBitPositionLow;
      for (let k = start; k <= end; k++) {
        let st = 3 * (k - 1);
        if (this.decodeBinaryDecision(reader, acData, st) !== 0) break;
        while (this.decodeBinaryDecision(reader, acData, st + 1) === 0) {
          st = st + 3;
          k++;
          if (k > 63) throwInvalidData('Invalid arithmetic code.');
        }
        const sign = this.decodeBinaryDecision(reader, this._fixedBin, 0);
        st = st + 2;
        let m = this.decodeBinaryDecision(reader, acData, st);
        if (m !== 0) {
          if (this.decodeBinaryDecision(reader, acData, st) !== 0) {
            m <<= 1;
            st = k <= acTable.acKx ? 189 : 217;
            while (this.decodeBinaryDecision(reader, acData, st) !== 0) {
              m <<= 1;
              if (m === 0x8000) throwInvalidData('Invalid arithmetic code.');
              st = st + 1;
            }
          }
        }
        let v = m;
        st = st + 14;
        while ((m >>= 1) !== 0) {
          if (this.decodeBinaryDecision(reader, acData, st) !== 0) v |= m;
        }
        v += 1;
        if (sign !== 0) v = -v;
        buffer[offset + k] = v << low;
      }
    } else {
      this._readBlockProgressiveACRefined(reader, component.acStatistics, scanHeader, buffer, offset);
    }
  }

  _readBlockProgressiveACRefined(reader, acStatistics, scanHeader, buffer, offset) {
    const acData = acStatistics.data;
    const start = scanHeader.startOfSpectralSelection;
    const end = scanHeader.endOfSpectralSelection;
    const p1 = 1 << scanHeader.successiveApproximationBitPositionLow;
    const m1 = (-1) << scanHeader.successiveApproximationBitPositionLow;

    // EOBx: index of the previous stage's end-of-block
    let kex = end;
    for (; kex > 0; kex--) {
      if (buffer[offset + kex] !== 0) break;
    }

    for (let k = start; k <= end; k++) {
      let st = 3 * (k - 1);
      if (k > kex) {
        if (this.decodeBinaryDecision(reader, acData, st) !== 0) break;
      }
      for (;;) {
        const idx = offset + k;
        const coef = buffer[idx];
        if (coef !== 0) {
          // previously nonzero coefficient
          if (this.decodeBinaryDecision(reader, acData, st + 2) !== 0) {
            buffer[idx] = coef < 0 ? coef + m1 : coef + p1;
          }
          break;
        }
        if (this.decodeBinaryDecision(reader, acData, st + 1) !== 0) {
          // newly nonzero coefficient
          buffer[idx] = this.decodeBinaryDecision(reader, this._fixedBin, 0) !== 0 ? coef + m1 : coef + p1;
          break;
        }
        st = st + 3;
        k++;
        if (k > end) throwInvalidData('Invalid arithmetic code.');
      }
    }
  }

  dispose() {
    // Final dequantize + IDCT + level shift over every stored block, then flush.
    finalizeProgressiveBlocks(this._decoder, this._frameHeader, this._allocator, this._levelShift, this._outputWriter);
  }
}
