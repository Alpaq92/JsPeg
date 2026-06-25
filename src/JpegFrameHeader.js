// Frame header (StartOfFrame marker). Port of JpegFrameHeader.cs.

export class JpegFrameComponentSpecificationParameters {
  /**
   * @param {number} identifier
   * @param {number} horizontalSamplingFactor
   * @param {number} verticalSamplingFactor
   * @param {number} quantizationTableSelector
   */
  constructor(identifier, horizontalSamplingFactor, verticalSamplingFactor, quantizationTableSelector) {
    this.identifier = identifier & 0xff;
    this.horizontalSamplingFactor = horizontalSamplingFactor & 0xff;
    this.verticalSamplingFactor = verticalSamplingFactor & 0xff;
    this.quantizationTableSelector = quantizationTableSelector & 0xff;
  }

  /**
   * Parse a 3-byte component spec from `buffer` at `offset`.
   * @returns {{ value: JpegFrameComponentSpecificationParameters, bytesConsumed: number } | null}
   */
  static parse(buffer, offset = 0) {
    if (buffer.length - offset < 3) return null;
    const identifier = buffer[offset];
    const samplingFactor = buffer[offset + 1];
    const quantizationTableSelector = buffer[offset + 2];
    return {
      value: new JpegFrameComponentSpecificationParameters(
        identifier,
        samplingFactor >> 4,
        samplingFactor & 0xf,
        quantizationTableSelector,
      ),
      bytesConsumed: 3,
    };
  }

  /** Write 3 bytes into `dest` at `offset`. @returns bytesWritten */
  write(dest, offset = 0) {
    if (dest.length - offset < 3) throw new RangeError('Destination buffer too small.');
    dest[offset] = this.identifier;
    dest[offset + 1] = ((this.horizontalSamplingFactor << 4) | (this.verticalSamplingFactor & 0xf)) & 0xff;
    dest[offset + 2] = this.quantizationTableSelector;
    return 3;
  }
}

export class JpegFrameHeader {
  /**
   * @param {number} samplePrecision
   * @param {number} numberOfLines
   * @param {number} samplesPerLine
   * @param {number} numberOfComponents
   * @param {JpegFrameComponentSpecificationParameters[]|null} components
   */
  constructor(samplePrecision, numberOfLines, samplesPerLine, numberOfComponents, components) {
    this.samplePrecision = samplePrecision & 0xff;
    this.numberOfLines = numberOfLines & 0xffff;
    this.samplesPerLine = samplesPerLine & 0xffff;
    this.numberOfComponents = numberOfComponents & 0xff;
    this.components = components || null;
  }

  /** Byte count required to encode this frame header (excluding marker + length). */
  get bytesRequired() {
    return 6 + 3 * this.numberOfComponents;
  }

  /**
   * Parse a frame header from a segment buffer.
   * @param {Uint8Array} buffer segment content (after marker + length)
   * @param {boolean} metadataOnly when true, the component array is not built
   * @returns {{ value: JpegFrameHeader, bytesConsumed: number } | null}
   */
  static parse(buffer, metadataOnly) {
    if (buffer.length < 6) return null;

    const precision = buffer[0];
    const numberOfLines = (buffer[1] << 8) | buffer[2];
    const samplesPerLine = (buffer[3] << 8) | buffer[4];
    const numberOfComponents = buffer[5];

    let bytesConsumed = 6;
    let offset = 6;

    if (buffer.length - offset < 3 * numberOfComponents) return null;

    if (metadataOnly) {
      bytesConsumed += 3 * numberOfComponents;
      return {
        value: new JpegFrameHeader(precision, numberOfLines, samplesPerLine, numberOfComponents, null),
        bytesConsumed,
      };
    }

    const components = new Array(numberOfComponents);
    for (let i = 0; i < numberOfComponents; i++) {
      const r = JpegFrameComponentSpecificationParameters.parse(buffer, offset);
      if (r === null) return null;
      components[i] = r.value;
      offset += 3;
      bytesConsumed += 3;
    }

    return {
      value: new JpegFrameHeader(precision, numberOfLines, samplesPerLine, numberOfComponents, components),
      bytesConsumed,
    };
  }

  /** Write the frame header into `dest` at `offset`. @returns bytesWritten */
  write(dest, offset = 0) {
    if (dest.length - offset < 6) throw new RangeError('Destination buffer too small.');
    dest[offset] = this.samplePrecision;
    dest[offset + 1] = (this.numberOfLines >> 8) & 0xff;
    dest[offset + 2] = this.numberOfLines & 0xff;
    dest[offset + 3] = (this.samplesPerLine >> 8) & 0xff;
    dest[offset + 4] = this.samplesPerLine & 0xff;
    dest[offset + 5] = this.numberOfComponents;
    let written = 6;
    let pos = offset + 6;

    if (!this.components || this.components.length < this.numberOfComponents) {
      throw new Error('Components are not specified.');
    }
    for (let i = 0; i < this.numberOfComponents; i++) {
      const bytes = this.components[i].write(dest, pos);
      pos += bytes;
      written += bytes;
    }
    return written;
  }

  shadowEquals(other) {
    return this.samplePrecision === other.samplePrecision
      && this.numberOfLines === other.numberOfLines
      && this.samplesPerLine === other.samplesPerLine
      && this.numberOfComponents === other.numberOfComponents;
  }
}
