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

// Baseline Huffman fixtures only (the optimizer handles neither progressive nor
// arithmetic scans).
const baseline = manifest.filter((f) => !f.name.includes('prog') && !f.name.includes('arith'));
for (const fx of baseline) {
  test(`optimize ${fx.name} is lossless and not larger`, () => {
    const src = readFileSync(new URL(`./fixtures/${fx.file}`, import.meta.url));
    const opt = optimize(src);
    assert.ok(opt.length <= src.length, `optimized (${opt.length}) <= original (${src.length})`);
    assert.ok(pixelsEqual(decode(src).data, decode(opt).data), 'decoded pixels are identical');
  });
}

// Re-optimizing an already-optimized stream must not grow it or change pixels.
test('optimize is idempotent (re-optimizing does not grow or alter pixels)', () => {
  const src = readFileSync(new URL(`./fixtures/${baseline[0].file}`, import.meta.url));
  const once = optimize(src);
  const twice = optimize(once);
  assert.ok(twice.length <= once.length, `re-optimized (${twice.length}) <= optimized (${once.length})`);
  assert.ok(pixelsEqual(decode(once).data, decode(twice).data), 'decoded pixels are identical');
});

test('optimize throws a clear error on progressive input', () => {
  const prog = readFileSync(new URL('./fixtures/rgb_prog_444_q88.jpg', import.meta.url));
  assert.throws(() => optimize(prog), /not supported/i);
});

test('optimize throws a clear error on arithmetic input', () => {
  const arith = readFileSync(new URL('./fixtures/arith_seq.jpg', import.meta.url));
  assert.throws(() => optimize(arith), /not supported/i);
});
