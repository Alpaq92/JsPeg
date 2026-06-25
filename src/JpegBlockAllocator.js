// Stores every 8x8 coefficient block of an image, used by progressive decoding
// which accumulates coefficients across multiple scans before the final IDCT.
// Port of JpegBlockAllocator.cs. Blocks live in one flat Int16Array; block 0 is
// a shared dummy target for out-of-range writes.
import { writeBlock } from './JpegBlockOutputWriter.js';

export class JpegBlockAllocator {
  constructor() {
    /** @type {Int16Array|null} */
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

    const horizontalBlockCount = (frameHeader.samplesPerLine + 7) >> 3;
    const verticalBlockCount = (frameHeader.numberOfLines + 7) >> 3;

    const components = this._components = new Array(frameHeader.numberOfComponents);
    let i = 0;
    for (const component of frameHeader.components) {
      const hSub = Math.trunc(maxHorizontalSampling / component.horizontalSamplingFactor);
      const vSub = Math.trunc(maxVerticalSampling / component.verticalSamplingFactor);
      const hBlocks = Math.trunc((horizontalBlockCount + hSub - 1) / hSub);
      const vBlocks = Math.trunc((verticalBlockCount + vSub - 1) / vSub);
      components[i++] = {
        hBlocks,
        vBlocks,
        hSub,
        vSub,
        blockOffset: 0, // in blocks; filled below
      };
    }

    // Reserve block index 0 as a dummy target; real blocks start at index 1.
    let index = 1;
    for (let k = 0; k < components.length; k++) {
      components[k].blockOffset = index;
      index += components[k].hBlocks * components[k].vBlocks;
    }

    this.buffer = new Int16Array(index * 64);
  }

  /** Block-grid info for a component: { hBlocks, vBlocks, hSub, vSub, blockOffset }. */
  componentInfo(componentIndex) {
    return this._components[componentIndex];
  }

  /**
   * Short-array offset of the block at (blockX, blockY) for a component.
   * Out-of-range coordinates resolve to the dummy block at offset 0.
   */
  getBlockOffset(componentIndex, blockX, blockY) {
    const component = this._components[componentIndex];
    if (blockX >= component.hBlocks || blockY >= component.vBlocks) {
      return 0;
    }
    return (component.blockOffset + blockY * component.hBlocks + blockX) * 64;
  }

  /** Flush all blocks to the output writer, upsampling subsampled components. */
  flush(outputWriter) {
    const components = this._components;
    if (components === null) return;
    const buffer = this.buffer;

    for (let i = 0; i < components.length; i++) {
      const component = components[i];
      const base = component.blockOffset * 64;
      for (let row = 0; row < component.vBlocks; row++) {
        const rowBase = base + row * component.hBlocks * 64;
        for (let col = 0; col < component.hBlocks; col++) {
          const blockOffset = rowBase + col * 64;
          writeBlock(
            outputWriter,
            buffer,
            blockOffset,
            i,
            col * component.hSub * 8,
            row * component.vSub * 8,
            component.hSub,
            component.vSub,
          );
        }
      }
    }
  }
}
