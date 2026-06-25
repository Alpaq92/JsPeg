// Output writer abstraction + shared block-write/upsample helper.
// Ports JpegBlockOutputWriter.cs and the WriteBlock/WriteBlockSlow logic that is
// duplicated across the baseline scan decoder and both allocators.
import { log2 } from './JpegMathHelper.js';

/**
 * A writer that receives decoded 8x8 spatial blocks at full image resolution.
 * Subclasses implement {@link writeBlock}.
 */
export class JpegBlockOutputWriter {
  /**
   * Write an 8x8 spatial block into the destination.
   * @param {Int16Array} blockData backing array containing the 64 samples
   * @param {number} blockOffset start index of the block within blockData
   * @param {number} componentIndex
   * @param {number} x X offset in the image
   * @param {number} y Y offset in the image
   */
  // eslint-disable-next-line no-unused-vars
  writeBlock(blockData, blockOffset, componentIndex, x, y) {
    throw new Error('writeBlock must be implemented by a subclass.');
  }
}

// Reused scratch block for the upsampling path (decode is single-threaded).
const _scratch = new Int16Array(64);

/**
 * Write a block to the output writer, replicating samples when the component is
 * subsampled (nearest-neighbour upsampling, matching the reference).
 */
export function writeBlock(outputWriter, blockData, blockOffset, componentIndex, x, y, horizontalSubsamplingFactor, verticalSubsamplingFactor) {
  if (horizontalSubsamplingFactor === 1 && verticalSubsamplingFactor === 1) {
    outputWriter.writeBlock(blockData, blockOffset, componentIndex, x, y);
    return;
  }

  const hShift = log2(horizontalSubsamplingFactor);
  const vShift = log2(verticalSubsamplingFactor);
  const temp = _scratch;

  for (let v = 0; v < verticalSubsamplingFactor; v++) {
    for (let h = 0; h < horizontalSubsamplingFactor; h++) {
      const vBlock = 8 * v;
      const hBlock = 8 * h;
      for (let i = 0; i < 8; i++) {
        const srcRow = blockOffset + (((vBlock + i) >> vShift) * 8);
        const dstRow = 8 * i;
        for (let j = 0; j < 8; j++) {
          temp[dstRow + j] = blockData[srcRow + ((hBlock + j) >> hShift)];
        }
      }
      outputWriter.writeBlock(temp, 0, componentIndex, x + 8 * h, y + 8 * v);
    }
  }
}
