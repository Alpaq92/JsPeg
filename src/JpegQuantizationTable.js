// Quantization table. Port of JpegQuantizationTable.cs.

export class JpegQuantizationTable {
  /**
   * @param {number} elementPrecision 0 for 8-bit, 1 for 16-bit elements
   * @param {number} identifier
   * @param {Uint16Array|number[]} elements 64 elements in zig-zag order
   */
  constructor(elementPrecision, identifier, elements) {
    if (!elements) throw new Error('elements is required');
    if (elements.length !== 64) throw new Error('The length of elements must be 64.');
    this.elementPrecision = elementPrecision & 0xff;
    this.identifier = identifier & 0xff;
    this.elements = elements instanceof Uint16Array ? elements : Uint16Array.from(elements);
  }

  /** True when this table is the default/uninitialized value. */
  get isEmpty() {
    return this.elements == null;
  }

  /** Byte count required to encode this table into a JPEG stream. */
  get bytesRequired() {
    return this.elementPrecision === 0 ? 64 + 1 : 128 + 1;
  }

  /**
   * Parse a quantization table from a segment buffer at `offset`.
   * @returns {{ value: JpegQuantizationTable, bytesConsumed: number } | null}
   */
  static parse(buffer, offset = 0) {
    if (buffer.length - offset < 1) return null;
    const b = buffer[offset];
    const precision = b >> 4;
    const identifier = b & 0xf;
    const r = JpegQuantizationTable.parseElements(precision, identifier, buffer, offset + 1);
    if (r === null) return null;
    return { value: r.value, bytesConsumed: 1 + r.bytesConsumed };
  }

  /**
   * @returns {{ value: JpegQuantizationTable, bytesConsumed: number } | null}
   */
  static parseElements(precision, identifier, buffer, offset = 0) {
    const elements = new Uint16Array(64);
    if (precision === 0) {
      if (buffer.length - offset < 64) return null;
      for (let i = 0; i < 64; i++) elements[i] = buffer[offset + i];
      return { value: new JpegQuantizationTable(precision, identifier, elements), bytesConsumed: 64 };
    } else if (precision === 1) {
      if (buffer.length - offset < 128) return null;
      for (let i = 0; i < 64; i++) {
        elements[i] = (buffer[offset + 2 * i] << 8) | buffer[offset + 2 * i + 1];
      }
      return { value: new JpegQuantizationTable(precision, identifier, elements), bytesConsumed: 128 };
    }
    return null;
  }

  /** Write the table into `dest` at `offset`. @returns bytesWritten */
  write(dest, offset = 0) {
    if (dest.length - offset < 1) throw new RangeError('Destination buffer too small.');
    dest[offset] = ((this.elementPrecision << 4) | (this.identifier & 0xf)) & 0xff;
    let pos = offset + 1;
    let written = 1;
    const elements = this.elements;
    if (this.elementPrecision === 0) {
      if (dest.length - pos < 64) throw new RangeError('Destination buffer too small.');
      for (let i = 0; i < 64; i++) dest[pos + i] = elements[i] & 0xff;
      written += 64;
    } else {
      if (dest.length - pos < 128) throw new RangeError('Destination buffer too small.');
      for (let i = 0; i < 64; i++) {
        dest[pos + 2 * i] = (elements[i] >> 8) & 0xff;
        dest[pos + 2 * i + 1] = elements[i] & 0xff;
      }
      written += 128;
    }
    return written;
  }
}
