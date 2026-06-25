// Input reader abstraction for the encoder. Port of JpegBlockInputReader.cs.
export class JpegBlockInputReader {
  get width() { throw new Error('not implemented'); }
  get height() { throw new Error('not implemented'); }

  /**
   * Read an 8x8 spatial block from the source into `blockData` at `blockOffset`.
   * Implementations must handle x/y beyond the image bounds (edge clamping).
   */
  // eslint-disable-next-line no-unused-vars
  readBlock(blockData, blockOffset, componentIndex, x, y) {
    throw new Error('readBlock must be implemented by a subclass.');
  }
}
