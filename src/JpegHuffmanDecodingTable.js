// Huffman decoding table. Port of JpegHuffmanDecodingTable.cs.
//
// Decoding strategy (same as libjpeg / the reference): an 8-bit lookahead table
// resolves all codes of length <= 8 in one indexed read; longer codes fall back
// to a maxCode/valOffset search. Lookup() returns a packed int
// `(codeSize << 8) | symbolValue` to avoid allocating an entry object per symbol.

export class JpegHuffmanDecodingTable {
  constructor(tableClass, identifier) {
    this.tableClass = tableClass & 0xff;
    this.identifier = identifier & 0xff;

    /** @type {Uint8Array} symbol values, in order of increasing code length */
    this._values = null;
    /** @type {Int32Array} largest code of each length (index 1..16), with sentinels */
    this._maxCode = null;
    /** @type {Uint8Array} values[] offset per length (stored as bytes, like the reference) */
    this._valOffset = null;
    /** @type {Uint8Array} lookahead code size keyed by the top 8 bits */
    this._lookaheadSize = null;
    /** @type {Uint8Array} lookahead symbol value keyed by the top 8 bits */
    this._lookaheadValue = null;
  }

  /**
   * Look up a symbol from the next 16 bits of the stream.
   * @param {number} code16bit
   * @returns {number} packed `(codeSize << 8) | symbolValue`
   */
  lookup(code16bit) {
    const high8 = code16bit >> 8;
    const size = this._lookaheadSize[high8];
    if (size !== 0) {
      return (size << 8) | this._lookaheadValue[high8];
    }
    return this._lookupSlow(code16bit);
  }

  _lookupSlow(code16bit) {
    const maxCode = this._maxCode;
    let size = 9;
    while (code16bit > maxCode[size]) {
      size++;
    }
    if (size > 16) {
      throw new Error('Invalid Huffman code encountered.');
    }
    const shifted = code16bit >> (16 - size);
    const symbol = this._values[(this._valOffset[size] + shifted) & 0xff];
    return (size << 8) | symbol;
  }

  /**
   * Parse a Huffman table from a segment buffer at `offset`.
   * @returns {{ value: JpegHuffmanDecodingTable, bytesConsumed: number } | null}
   */
  static parse(buffer, offset = 0) {
    if (buffer.length - offset < 1) return null;
    const tableClassAndIdentifier = buffer[offset];
    const r = JpegHuffmanDecodingTable.parseTable(
      tableClassAndIdentifier >> 4,
      tableClassAndIdentifier & 0xf,
      buffer,
      offset + 1,
    );
    if (r === null) return null;
    return { value: r.value, bytesConsumed: 1 + r.bytesConsumed };
  }

  /**
   * @returns {{ value: JpegHuffmanDecodingTable, bytesConsumed: number } | null}
   */
  static parseTable(tableClass, identifier, buffer, offset = 0) {
    if (buffer.length - offset < 16) return null;

    const codeLengths = buffer.subarray(offset, offset + 16);
    let codeCount = 0;
    for (let i = 15; i >= 0; i--) codeCount += codeLengths[i];
    if (codeCount > 256) return null;

    const huffSize = new Uint8Array(257);
    generateSizeTable(codeLengths, huffSize);
    let bytesConsumed = 16;
    const valuesOffset = offset + 16;

    if (buffer.length - valuesOffset < codeCount) return null;

    const huffCode = new Uint16Array(257);
    generateCodeTable(huffSize, huffCode);
    bytesConsumed += codeCount;

    const codeValues = buffer.subarray(valuesOffset, valuesOffset + codeCount);
    const table = new JpegHuffmanDecodingTable(tableClass, identifier);
    table._configure(codeLengths, huffCode, codeValues);

    return { value: table, bytesConsumed };
  }

  _configure(codeLengths, huffCode, values) {
    this._values = new Uint8Array(256);
    this._maxCode = new Int32Array(18);
    this._valOffset = new Uint8Array(19);
    this._lookaheadSize = new Uint8Array(256);
    this._lookaheadValue = new Uint8Array(256);

    this._values.set(values.subarray(0, Math.min(values.length, 256)));

    let p = 0;
    for (let l = 1; l <= 16; l++) {
      if (codeLengths[l - 1] !== 0) {
        const offset = (p - huffCode[p]) & 0xff; // stored as a byte, like (byte)offset
        this._valOffset[l] = offset;
        p += codeLengths[l - 1];
        let maxCode = huffCode[p - 1];
        maxCode = (maxCode << (16 - l)) & 0xffff;
        maxCode = (maxCode | ((1 << (16 - l)) - 1)) & 0xffff;
        this._maxCode[l] = maxCode;
      } else {
        this._maxCode[l] = 0;
      }
    }
    this._valOffset[18] = 0;
    this._maxCode[17] = 0xffff; // sentinel ensures termination

    p = 0;
    for (let l = 1; l <= 8; l++) {
      for (let i = 0; i < codeLengths[l - 1]; i++, p++) {
        this._fillByteLookupTable(huffCode[p], l, this._values[p]);
      }
    }
  }

  _fillByteLookupTable(code, codeSize, value) {
    const freeBitCount = 8 - codeSize;
    code = (code << freeBitCount) & 0xff;
    const count = 1 << freeBitCount;
    for (let i = 0; i < count; i++) {
      this._lookaheadSize[code + i] = codeSize;
      this._lookaheadValue[code + i] = value;
    }
  }
}

function generateSizeTable(bits, huffSize) {
  let k = 0;
  for (let i = 1; i <= 16; i++) {
    let j = 1;
    while (j++ <= bits[i - 1]) {
      huffSize[k++] = i;
    }
  }
  huffSize[k] = 0;
  return k;
}

function generateCodeTable(huffSize, huffCode) {
  let k = 0;
  let code = 0;
  let si = huffSize[0];

  for (;;) {
    do {
      huffCode[k] = code;
      code++;
      k++;
    } while (huffSize[k] === si);
    if (huffSize[k] === 0) {
      return;
    }
    do {
      code <<= 1;
      si++;
    } while (huffSize[k] !== si);
  }
}
