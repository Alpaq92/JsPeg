import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JpegEncoder, JpegBufferInputReader, JpegStandardQuantizationTable,
  JpegStandardHuffmanEncodingTable, decode, componentsToRGBA,
} from '../src/index.js';

// Encode N full-resolution planes as an N-component JPEG (no Adobe marker, no subsampling).
function encodePlanes(w, h, planes) {
  const enc = new JpegEncoder();
  enc.setQuantizationTable(
    JpegStandardQuantizationTable.scaleByQuality(JpegStandardQuantizationTable.getLuminanceTable(0, 0), 95),
  );
  enc.setHuffmanTable(true, 0, JpegStandardHuffmanEncodingTable.getLuminanceDCTable());
  enc.setHuffmanTable(false, 0, JpegStandardHuffmanEncodingTable.getLuminanceACTable());
  for (let i = 0; i < planes.length; i++) enc.addComponent(i + 1, 0, 0, 0, 1, 1);
  enc.setInputReader(new JpegBufferInputReader(w, h, planes));
  return enc.encode();
}

test('decodes a 4-component (CMYK) JPEG to RGBA', () => {
  const w = 16, h = 16;
  const planes = [60, 40, 20, 200].map((v) => new Uint8Array(w * h).fill(v));
  const img = decode(encodePlanes(w, h, planes));
  assert.equal(img.width, w);
  assert.equal(img.height, h);
  assert.equal(img.numberOfComponents, 4);
  assert.equal(img.data.length, w * h * 4);
  // non-Adobe CMYK conversion: out = 255 - min(255, c + (255 - k))
  const exp = (c, k) => 255 - Math.min(255, c + (255 - k));
  assert.equal(img.data[0], exp(60, 200));
  assert.equal(img.data[1], exp(40, 200));
  assert.equal(img.data[2], exp(20, 200));
  assert.equal(img.data[3], 255);
});

test('componentsToRGBA handles YCCK (Adobe transform 2)', () => {
  // Y=120, neutral chroma (Cb=Cr=128), K=200
  const components = [Int16Array.of(120), Int16Array.of(128), Int16Array.of(128), Int16Array.of(200)];
  const rgba = componentsToRGBA({ width: 1, height: 1, components, componentIds: [1, 2, 3, 4], adobeTransform: 2 });
  const cmy = 255 - 120;                       // neutral chroma -> C = M = Y
  const expected = Math.trunc((cmy * 200) / 255); // then Adobe CMYK * K/255
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(rgba[i] - expected) <= 1, `channel ${i}: got ${rgba[i]}, expected ~${expected}`);
  assert.equal(rgba[3], 255);
});
