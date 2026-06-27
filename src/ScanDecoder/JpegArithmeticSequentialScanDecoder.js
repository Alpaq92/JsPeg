// Arithmetic-coded extended-sequential DCT decoder (SOF9).
// Port of JpegArithmeticSequentialScanDecoder.cs.
import { JpegBitReader } from '../JpegBitReader.js';
import { isRestartMarker, JpegMarker } from '../JpegMarker.js';
import { transformIDCT } from '../dct.js';
import { writeBlock } from '../JpegBlockOutputWriter.js';
import { dequantizeBlockAndUnZigZag, shiftDataLevel, throwInvalidData } from './common.js';
import { JpegArithmeticScanDecoder, JpegArithmeticDecodingComponent } from './JpegArithmeticScanDecoder.js';

export class JpegArithmeticSequentialScanDecoder extends JpegArithmeticScanDecoder {
  constructor(decoder, frameHeader) {
    super(decoder);
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
      this._components[i] = new JpegArithmeticDecodingComponent();
    }
  }

  processScan(reader, scanHeader) {
    const frameHeader = this._frameHeader;
    const outputWriter = this._decoder.getOutputWriter();
    if (frameHeader.components == null) throwInvalidData('Component parameters are missing in JPEG frame header.');
    if (scanHeader.components == null) throwInvalidData('Component parameters are missing in JPEG scan header.');
    if (outputWriter == null) throw new Error('Output writer is not specified.');

    const count = this.initDecodeComponents(frameHeader, scanHeader, this._components);
    const components = this._components.slice(0, count);

    for (const component of this._components) {
      component.dcPredictor = 0;
      component.dcContext = 0;
      if (component.dcStatistics) component.dcStatistics.reset();
      if (component.acStatistics) component.acStatistics.reset();
    }
    this.reset();

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
              this._readBlock(bitReader, component, outputBuffer);
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
          if (!isRestartMarker(marker)) throwInvalidData('Restart marker is expected.');
          mcusBeforeRestart = restartInterval;
          for (const component of components) {
            component.dcPredictor = 0;
            component.dcContext = 0;
            if (component.dcStatistics) component.dcStatistics.reset();
            if (component.acStatistics) component.acStatistics.reset();
          }
          this.reset();
        }
      }
    }

    bitReader.advanceAlignByte();
    let bytesConsumed = reader.remainingByteCount - Math.floor(bitReader.remainingBits / 8);
    const peeked = bitReader.tryPeekMarker();
    if (peeked !== 0 && !isRestartMarker(peeked)) bytesConsumed -= 2;
    reader.tryAdvance(bytesConsumed);
  }

  _readBlock(reader, component, destinationBlock) {
    // DC coefficient (T.81 §F.2.4.1)
    const dcData = component.dcStatistics.data;
    const dcTable = component.dcTable;
    let st = component.dcContext; // bin S0 for the DC context
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
      // dc_context conditioning category (§F.1.4.4.1.2)
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
    destinationBlock[0] = component.dcPredictor;

    // AC coefficients (T.81 §F.2.4.2)
    const acData = component.acStatistics.data;
    const acTable = component.acTable;
    for (let k = 1; k <= 63; k++) {
      let st2 = 3 * (k - 1);
      if (this.decodeBinaryDecision(reader, acData, st2) !== 0) break; // EOB
      while (this.decodeBinaryDecision(reader, acData, st2 + 1) === 0) {
        st2 = st2 + 3;
        k++;
        if (k > 63) throwInvalidData('Invalid arithmetic code.');
      }
      const sign = this.decodeBinaryDecision(reader, this._fixedBin, 0);
      st2 = st2 + 2;
      let m = this.decodeBinaryDecision(reader, acData, st2);
      if (m !== 0) {
        if (this.decodeBinaryDecision(reader, acData, st2) !== 0) {
          m <<= 1;
          st2 = k <= acTable.acKx ? 189 : 217;
          while (this.decodeBinaryDecision(reader, acData, st2) !== 0) {
            m <<= 1;
            if (m === 0x8000) throwInvalidData('Invalid arithmetic code.');
            st2 = st2 + 1;
          }
        }
      }
      let v = m;
      st2 = st2 + 14;
      while ((m >>= 1) !== 0) {
        if (this.decodeBinaryDecision(reader, acData, st2) !== 0) v |= m;
      }
      v += 1;
      if (sign !== 0) v = -v;
      destinationBlock[k] = v;
    }
  }

  dispose() {
    // Sequential writes output immediately; nothing to flush.
  }
}
