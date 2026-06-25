// A concrete output writer that gathers decoded samples into per-component
// full-resolution planes (Int16Array). This is the JS equivalent of the sample
// output writers in the reference's apps. Color conversion is layered on top.
import { JpegBlockOutputWriter } from '../JpegBlockOutputWriter.js';

export class JpegBufferOutputWriter extends JpegBlockOutputWriter {
  /**
   * @param {number} width image width
   * @param {number} height image height
   * @param {number} numberOfComponents
   */
  constructor(width, height, numberOfComponents) {
    super();
    this.width = width;
    this.height = height;
    this.numberOfComponents = numberOfComponents;
    /** @type {Int16Array[]} one full-resolution plane per component */
    this.components = new Array(numberOfComponents);
    for (let i = 0; i < numberOfComponents; i++) {
      this.components[i] = new Int16Array(width * height);
    }
  }

  /** Raw sample plane for a component (Int16Array, length width*height). */
  getComponentData(componentIndex) {
    return this.components[componentIndex];
  }

  writeBlock(blockData, blockOffset, componentIndex, x, y) {
    if (componentIndex >= this.numberOfComponents) return;
    const width = this.width;
    const height = this.height;
    const plane = this.components[componentIndex];

    const maxDy = Math.min(8, height - y);
    const maxDx = Math.min(8, width - x);
    if (maxDy <= 0 || maxDx <= 0) return;

    for (let dy = 0; dy < maxDy; dy++) {
      let dst = (y + dy) * width + x;
      let src = blockOffset + dy * 8;
      for (let dx = 0; dx < maxDx; dx++) {
        plane[dst++] = blockData[src++];
      }
    }
  }
}
