// Per-context statistics bins for arithmetic decoding. Port of
// JpegArithmeticStatistics.cs. Each byte holds a state value: bit 7 is the MPS,
// bits 0-6 are the index into the Qe probability-estimation table.
export class JpegArithmeticStatistics {
  /** @param {boolean} dc @param {number} identifier */
  constructor(dc, identifier) {
    this.dc = dc;
    this.identifier = identifier;
    this.data = new Uint8Array(dc ? 64 : 256);
  }

  reset() {
    this.data.fill(0);
  }
}
