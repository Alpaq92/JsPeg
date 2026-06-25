// Huffman encoding table. Port of JpegHuffmanEncodingTable.cs + JpegHuffmanCanonicalCode.cs.
// A canonical code is a plain object: { code, symbol, codeLength }.

export class JpegHuffmanEncodingTable {
  /** @param {{code:number,symbol:number,codeLength:number}[]} codes */
  constructor(codes) {
    if (!codes) throw new Error('codes is required');
    this._codes = codes;
    this._symbolMap = new Uint8Array(256);
    let codeCount = 0;
    for (let i = 0; i < codes.length; i++) {
      if (codes[i].codeLength !== 0) {
        this._symbolMap[codes[i].symbol] = i;
        codeCount++;
      }
    }
    this._codeCount = codeCount;

    // "out" fields populated by getCode (avoids per-symbol allocation).
    this.code = 0;
    this.codeLength = 0;
  }

  /** Bytes required to encode this table (16 length counts + symbols). */
  get bytesRequired() {
    return 16 + this._codeCount;
  }

  /** Write the table body (without the class/id prefix byte) into dest. @returns bytesWritten */
  write(dest, offset = 0) {
    if (dest.length - offset < 16) throw new RangeError('Destination buffer too small.');
    const start = this._codes.length - this._codeCount;
    for (let len = 1; len <= 16; len++) {
      let count = 0;
      for (let i = start; i < this._codes.length; i++) {
        if (this._codes[i].codeLength === len) count++;
      }
      dest[offset + len - 1] = count;
    }
    let pos = offset + 16;
    let written = 16;
    if (dest.length - pos < this._codeCount) throw new RangeError('Destination buffer too small.');
    for (let i = start; i < this._codes.length; i++) {
      dest[pos++] = this._codes[i].symbol;
      written++;
    }
    return written;
  }

  /** Resolve the canonical code for `symbol` into this.code / this.codeLength. */
  getCode(symbol) {
    const c = this._codes[this._symbolMap[symbol]];
    this.code = c.code;
    this.codeLength = c.codeLength;
  }
}

/**
 * Assign canonical code values to a list of codes that already have symbol +
 * codeLength set, in canonical (codeLength, symbol) order.
 * Shared by the builder and the standard-table helper.
 */
export function assignCanonicalCodes(codes) {
  let bitCode = (codes[0].code = 0);
  let bitCount = codes[0].codeLength;
  for (let i = 1; i < codes.length; i++) {
    const code = codes[i];
    if (code.codeLength > bitCount) {
      bitCode++;
      bitCode = (bitCode << (code.codeLength - bitCount)) & 0xffff;
      code.code = bitCode;
      bitCount = code.codeLength;
    } else {
      code.code = ++bitCode;
    }
  }
  return codes;
}
