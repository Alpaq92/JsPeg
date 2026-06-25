// A 16-row ring buffer per component, used by lossless decoding which produces
// samples scanline by scanline and flushes completed 8-row blocks to the output
// writer. Port of JpegPartialScanlineAllocator.cs.
import { writeBlock } from './JpegBlockOutputWriter.js';

export class JpegPartialScanlineAllocator {
  constructor(writer) {
    this._writer = writer;
    this.buffer = null;
    this._components = null;
  }

  allocate(frameHeader) {
    let maxHorizontalSampling = 1;
    let maxVerticalSampling = 1;
    for (const c of frameHeader.components) {
      maxHorizontalSampling = Math.max(maxHorizontalSampling, c.horizontalSamplingFactor);
      maxVerticalSampling = Math.max(maxVerticalSampling, c.verticalSamplingFactor);
    }

    const components = this._components = new Array(frameHeader.numberOfComponents);
    let i = 0;
    for (const component of frameHeader.components) {
      const hSub = Math.trunc(maxHorizontalSampling / component.horizontalSamplingFactor);
      const vSub = Math.trunc(maxVerticalSampling / component.verticalSamplingFactor);
      const width = Math.trunc((frameHeader.samplesPerLine + hSub - 1) / hSub);
      const height = Math.trunc((frameHeader.numberOfLines + vSub - 1) / vSub);
      components[i++] = { hSub, vSub, width, height, sampleOffset: 0 };
    }

    let index = 0;
    for (let k = 0; k < components.length; k++) {
      components[k].sampleOffset = index;
      index += components[k].width * 16;
    }

    this.buffer = new Int16Array(index);
  }

  /** A view over one scanline (row y, ring-indexed mod 16) of a component. */
  getScanlineSpan(componentIndex, y) {
    const component = this._components[componentIndex];
    if ((y >>> 0) >= component.height) throw new RangeError('y');
    const start = component.sampleOffset + component.width * (y & 0b1111);
    return this.buffer.subarray(start, start + component.width);
  }

  flushMcu(componentIndex, y) {
    if (y % 8 !== 0 || y === 0) return;
    this._flushCore(componentIndex, y - 8, 8);
  }

  flushLastMcu(componentIndex, y) {
    if (y === 0) return;
    const offsetY = Math.trunc((y - 1) / 8) * 8;
    this._flushCore(componentIndex, offsetY, y - offsetY);
  }

  _flushCore(componentIndex, y, writeHeight) {
    const components = this._components;
    if (components === null) return;
    const component = components[componentIndex];
    const width = component.width;
    const buffer = this.buffer;
    const rowBase = component.sampleOffset + component.width * (y & 0b1111);

    const block = new Int16Array(64);
    for (let x = 0; x < width; x += 8) {
      const writeWidth = Math.min(width - x, 8);
      block.fill(0);
      for (let i = 0; i < writeHeight; i++) {
        const src = rowBase + i * width + x;
        const dst = i * 8;
        for (let j = 0; j < writeWidth; j++) {
          block[dst + j] = buffer[src + j];
        }
      }
      writeBlock(
        this._writer,
        block,
        0,
        componentIndex,
        component.hSub * x,
        component.vSub * y,
        component.hSub,
        component.vSub,
      );
    }
  }
}
