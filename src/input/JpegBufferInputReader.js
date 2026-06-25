// A concrete input reader backed by full-resolution component planes.
// Samples outside the image are clamped to the nearest edge (standard JPEG
// edge handling). The encoder performs any chroma downsampling itself.
import { JpegBlockInputReader } from '../JpegBlockInputReader.js';

export class JpegBufferInputReader extends JpegBlockInputReader {
  /**
   * @param {number} width
   * @param {number} height
   * @param {Array<Int16Array|Uint8Array|Uint8ClampedArray|number[]>} components
   *   one full-resolution sample plane (length width*height) per component
   */
  constructor(width, height, components) {
    super();
    this._width = width;
    this._height = height;
    this.components = components;
  }

  get width() { return this._width; }
  get height() { return this._height; }

  readBlock(blockData, blockOffset, componentIndex, x, y) {
    const width = this._width;
    const height = this._height;
    const plane = this.components[componentIndex];
    for (let dy = 0; dy < 8; dy++) {
      let sy = y + dy;
      if (sy < 0) sy = 0; else if (sy >= height) sy = height - 1;
      const row = sy * width;
      const dst = blockOffset + dy * 8;
      for (let dx = 0; dx < 8; dx++) {
        let sx = x + dx;
        if (sx < 0) sx = 0; else if (sx >= width) sx = width - 1;
        blockData[dst + dx] = plane[row + sx];
      }
    }
  }
}
