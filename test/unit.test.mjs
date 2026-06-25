// Pure-JS known-answer unit tests for the codec internals.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blockIndexToBuffer, bufferIndexToBlock } from '../src/JpegZigZag.js';
import { JpegBitReader } from '../src/JpegBitReader.js';
import { JpegWriter } from '../src/JpegWriter.js';
import { transformFDCT, transformIDCT } from '../src/FastFloatingPointDCT.js';
import { JpegHuffmanDecodingTable } from '../src/JpegHuffmanDecodingTable.js';
import { JpegStandardHuffmanEncodingTable } from '../src/JpegStandardHuffmanEncodingTable.js';
import { JpegStandardQuantizationTable } from '../src/JpegStandardQuantizationTable.js';
import { extend } from '../src/ScanDecoder/common.js';

test('zigzag tables are inverses and match the standard order', () => {
  for (let i = 0; i < 64; i++) {
    assert.equal(bufferIndexToBlock(blockIndexToBuffer(i)), i);
    assert.equal(blockIndexToBuffer(bufferIndexToBlock(i)), i);
  }
  // first 8 entries of the canonical zig-zag (buffer -> natural) order
  assert.deepEqual(
    Array.from({ length: 8 }, (_, i) => bufferIndexToBlock(i)),
    [0, 1, 8, 16, 9, 2, 3, 10],
  );
});

test('RECEIVE/EXTEND sign-extension matches the JPEG spec', () => {
  assert.equal(extend(5, 3), 5);
  assert.equal(extend(4, 3), 4);
  assert.equal(extend(3, 3), -4);
  assert.equal(extend(1, 3), -6);
  assert.equal(extend(1, 1), 1);
  assert.equal(extend(0, 1), -1);
});

test('quantization quality scaling has known values', () => {
  const lum = JpegStandardQuantizationTable.getLuminanceTable(0, 0);
  // q50 leaves the standard table unchanged
  assert.equal(JpegStandardQuantizationTable.scaleByQuality(lum, 50).elements[0], 16);
  // q100 collapses every element to 1
  assert.equal(JpegStandardQuantizationTable.scaleByQuality(lum, 100).elements[0], 1);
  // q1 saturates to 255
  assert.equal(JpegStandardQuantizationTable.scaleByQuality(lum, 1).elements[0], 255);
});

test('bit writer output round-trips through the bit reader (with 0xFF stuffing)', () => {
  // deterministic pseudo-random (value, length) pairs
  const pairs = [];
  let s = 12345;
  for (let i = 0; i < 500; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const length = 1 + (s % 16);
    const value = (s >> 4) & ((1 << length) - 1);
    pairs.push([value, length]);
  }

  const writer = new JpegWriter();
  writer.enterBitMode();
  for (const [value, length] of pairs) writer.writeBits(value, length);
  writer.exitBitMode();
  const bytes = writer.toUint8Array().slice();

  const reader = new JpegBitReader(bytes);
  for (const [value, length] of pairs) {
    assert.ok(reader.tryReadBits(length), 'reader has enough bits');
    assert.equal(reader.bits, value, `bits for length ${length}`);
  }
});

test('FDCT and IDCT are an inverse pair', () => {
  const src = new Float32Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      src[y * 8 + x] = (x * 17 + y * 9) % 64 - 32 + Math.sin(x + y) * 5;
    }
  }
  const freq = new Float32Array(64);
  const out = new Float32Array(64);
  const tmp = new Float32Array(64);
  transformFDCT(src, freq, tmp);
  transformIDCT(freq, out, tmp);

  let max = 0;
  for (let i = 0; i < 64; i++) max = Math.max(max, Math.abs(out[i] - src[i]));
  assert.ok(max < 1e-2, `IDCT(FDCT(x)) recovers x (max diff ${max})`);
});

test('IDCT of a DC-only block is flat', () => {
  const freq = new Float32Array(64);
  freq[0] = 64; // pure DC
  const out = new Float32Array(64);
  const tmp = new Float32Array(64);
  transformIDCT(freq, out, tmp);
  for (let i = 1; i < 64; i++) {
    assert.ok(Math.abs(out[i] - out[0]) < 1e-3, 'all samples equal for DC-only input');
  }
});

test('standard Huffman encode/decode tables share the same canonical codes', () => {
  // Build a DHT body for the standard luminance DC table and parse a decode table.
  const lengths = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const dht = Uint8Array.from([...lengths, ...values]);
  const parsed = JpegHuffmanDecodingTable.parseTable(0, 0, dht, 0);
  assert.ok(parsed, 'decode table parsed');
  const decodeTable = parsed.value;

  const encodeTable = JpegStandardHuffmanEncodingTable.getLuminanceDCTable();

  for (const symbol of values) {
    encodeTable.getCode(symbol);
    const code = encodeTable.code;
    const length = encodeTable.codeLength;
    // left-align the code into a 16-bit window, as the decoder sees it
    const code16 = (code << (16 - length)) & 0xffff;
    const packed = decodeTable.lookup(code16);
    assert.equal(packed & 0xff, symbol, `decoded symbol for ${symbol}`);
    assert.equal(packed >> 8, length, `code length for symbol ${symbol}`);
  }
});

test('full entropy path: encode symbols then decode them back', () => {
  const lengths = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const dht = Uint8Array.from([...lengths, ...values]);
  const decodeTable = JpegHuffmanDecodingTable.parseTable(0, 0, dht, 0).value;
  const encodeTable = JpegStandardHuffmanEncodingTable.getLuminanceDCTable();

  const sequence = [0, 11, 5, 5, 1, 8, 2, 7, 3, 9, 4, 6, 10, 0, 0, 11];
  const writer = new JpegWriter();
  writer.enterBitMode();
  for (const sym of sequence) {
    encodeTable.getCode(sym);
    writer.writeBits(encodeTable.code, encodeTable.codeLength);
  }
  writer.exitBitMode();
  const bytes = writer.toUint8Array().slice();

  const reader = new JpegBitReader(bytes);
  for (const expected of sequence) {
    const bits = reader.peekBits(16);
    const packed = decodeTable.lookup(bits);
    const codeSize = packed >> 8;
    reader.tryAdvanceBits(Math.min(codeSize, reader.bitsPeeked));
    assert.equal(packed & 0xff, expected);
  }
});
