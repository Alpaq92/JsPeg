// The optimizer must be lossless (identical decoded pixels) and not larger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode, decode, optimize } from '../src/index.js';

const manifest = JSON.parse(
  readFileSync(new URL('./fixtures/manifest.json', import.meta.url), 'utf8'),
);

function pixelsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

test('optimize shrinks standard-table output and is lossless', () => {
  const W = 96;
  const H = 64;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = (x * 255 / W) | 0;
      data[i + 1] = (y * 255 / H) | 0;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  const jpg = encode({ width: W, height: H, data, channels: 4 }, { quality: 85, subsampling: '4:2:0' });
  const opt = optimize(jpg);

  assert.ok(opt.length < jpg.length, `optimized (${opt.length}) < original (${jpg.length})`);
  assert.ok(pixelsEqual(decode(jpg).data, decode(opt).data), 'decoded pixels are identical');
});

// Baseline fixtures only (the optimizer does not handle progressive JPEGs).
for (const fx of manifest.filter((f) => !f.name.includes('prog'))) {
  test(`optimize ${fx.name} is lossless and not larger`, () => {
    const src = readFileSync(new URL(`./fixtures/${fx.file}`, import.meta.url));
    const opt = optimize(src);
    assert.ok(opt.length <= src.length, `optimized (${opt.length}) <= original (${src.length})`);
    assert.ok(pixelsEqual(decode(src).data, decode(opt).data), 'decoded pixels are identical');
  });
}

test('optimize throws a clear error on progressive input', () => {
  const prog = readFileSync(new URL('./fixtures/rgb_prog_444_q88.jpg', import.meta.url));
  assert.throws(() => optimize(prog), /not supported/i);
});
