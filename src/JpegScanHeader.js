// Scan header (StartOfScan marker). Port of JpegScanHeader.cs.

export class JpegScanComponentSpecificationParameters {
  /**
   * @param {number} scanComponentSelector
   * @param {number} dcEntropyCodingTableSelector
   * @param {number} acEntropyCodingTableSelector
   */
  constructor(scanComponentSelector, dcEntropyCodingTableSelector, acEntropyCodingTableSelector) {
    this.scanComponentSelector = scanComponentSelector & 0xff;
    this.dcEntropyCodingTableSelector = dcEntropyCodingTableSelector & 0xff;
    this.acEntropyCodingTableSelector = acEntropyCodingTableSelector & 0xff;
  }

  /**
   * @returns {{ value: JpegScanComponentSpecificationParameters, bytesConsumed: number } | null}
   */
  static parse(buffer, offset = 0) {
    if (buffer.length - offset < 2) return null;
    const scanComponentSelector = buffer[offset];
    const entropyCodingTableSelector = buffer[offset + 1];
    return {
      value: new JpegScanComponentSpecificationParameters(
        scanComponentSelector,
        entropyCodingTableSelector >> 4,
        entropyCodingTableSelector & 0xf,
      ),
      bytesConsumed: 2,
    };
  }

  /** @returns bytesWritten */
  write(dest, offset = 0) {
    if (dest.length - offset < 2) throw new RangeError('Destination buffer too small.');
    dest[offset] = this.scanComponentSelector;
    dest[offset + 1] = ((this.dcEntropyCodingTableSelector << 4) | (this.acEntropyCodingTableSelector & 0xf)) & 0xff;
    return 2;
  }
}

export class JpegScanHeader {
  /**
   * @param {number} numberOfComponents
   * @param {JpegScanComponentSpecificationParameters[]|null} components
   * @param {number} startOfSpectralSelection
   * @param {number} endOfSpectralSelection
   * @param {number} successiveApproximationBitPositionHigh
   * @param {number} successiveApproximationBitPositionLow
   */
  constructor(numberOfComponents, components, startOfSpectralSelection, endOfSpectralSelection, successiveApproximationBitPositionHigh, successiveApproximationBitPositionLow) {
    this.numberOfComponents = numberOfComponents & 0xff;
    this.components = components || null;
    this.startOfSpectralSelection = startOfSpectralSelection & 0xff;
    this.endOfSpectralSelection = endOfSpectralSelection & 0xff;
    this.successiveApproximationBitPositionHigh = successiveApproximationBitPositionHigh & 0xff;
    this.successiveApproximationBitPositionLow = successiveApproximationBitPositionLow & 0xff;
  }

  get bytesRequired() {
    return 4 + 2 * this.numberOfComponents;
  }

  shadowEquals(other) {
    return this.numberOfComponents === other.numberOfComponents
      && this.startOfSpectralSelection === other.startOfSpectralSelection
      && this.endOfSpectralSelection === other.endOfSpectralSelection
      && this.successiveApproximationBitPositionHigh === other.successiveApproximationBitPositionHigh
      && this.successiveApproximationBitPositionLow === other.successiveApproximationBitPositionLow;
  }

  /**
   * Parse a scan header from a segment buffer.
   * @param {Uint8Array} buffer segment content
   * @param {boolean} metadataOnly
   * @returns {{ value: JpegScanHeader, bytesConsumed: number } | null}
   */
  static parse(buffer, metadataOnly) {
    if (buffer.length < 1) return null;

    const numberOfComponents = buffer[0];
    let offset = 1;
    let bytesConsumed = 1;

    if (buffer.length - offset < 2 * numberOfComponents + 3) return null;

    let components = null;
    if (metadataOnly) {
      offset += 2 * numberOfComponents;
      bytesConsumed += 2 * numberOfComponents;
    } else {
      components = new Array(numberOfComponents);
      for (let i = 0; i < numberOfComponents; i++) {
        const r = JpegScanComponentSpecificationParameters.parse(buffer, offset);
        components[i] = r.value;
        offset += 2;
        bytesConsumed += 2;
      }
    }

    const startOfSpectralSelection = buffer[offset];
    const endOfSpectralSelection = buffer[offset + 1];
    const successiveApproximationBitPosition = buffer[offset + 2];
    bytesConsumed += 3;

    return {
      value: new JpegScanHeader(
        numberOfComponents,
        components,
        startOfSpectralSelection,
        endOfSpectralSelection,
        successiveApproximationBitPosition >> 4,
        successiveApproximationBitPosition & 0xf,
      ),
      bytesConsumed,
    };
  }

  /** @returns bytesWritten */
  write(dest, offset = 0) {
    if (dest.length - offset < 1) throw new RangeError('Destination buffer too small.');
    dest[offset] = this.numberOfComponents;
    let pos = offset + 1;
    let written = 1;

    if (!this.components || this.components.length < this.numberOfComponents) {
      throw new Error('Components are not specified.');
    }
    for (let i = 0; i < this.numberOfComponents; i++) {
      const bytes = this.components[i].write(dest, pos);
      pos += bytes;
      written += bytes;
    }

    if (dest.length - pos < 3) throw new RangeError('Destination buffer too small.');
    dest[pos] = this.startOfSpectralSelection;
    dest[pos + 1] = this.endOfSpectralSelection;
    dest[pos + 2] = ((this.successiveApproximationBitPositionHigh << 4) | (this.successiveApproximationBitPositionLow & 0xf)) & 0xff;
    written += 3;
    return written;
  }
}
