// Pure-JS encoder validation: encode an in-memory image, decode it back, and
// check the result is faithful within the loss expected at each quality.
// No fixtures, no external tooling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../src/index.js';
import { makeScene } from './_image.mjs';

function errorVsSource(rgba, src, w, h) {
  let sum = 0;
  let max = 0;
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(rgba[i * 4 + c] - src[i * 4 + c]);
      sum += d;
      if (d > max) max = d;
    }
  }
  return { mean: sum / (w * h * 3), max };
}

const W = 80;
const H = 64;
const source = makeScene(W, H);

// The mean is the correctness gate (kept tight); the max is loose because JPEG
// ringing + chroma subsampling legitimately spike single channels at the sharp
// sun/river edges of the scene.
const cases = [
  { name: '4:4:4 q92', opts: { quality: 92, subsampling: '4:4:4' }, meanTol: 2.5, maxTol: 42 },
  { name: '4:2:2 q90', opts: { quality: 90, subsampling: '4:2:2' }, meanTol: 4, maxTol: 75 },
  { name: '4:2:0 q90', opts: { quality: 90, subsampling: '4:2:0' }, meanTol: 5, maxTol: 105 },
  { name: '4:2:0 q75 optimized', opts: { quality: 75, subsampling: '4:2:0', optimizeCoding: true }, meanTol: 6, maxTol: 130 },
  { name: '4:4:4 q95 package-merge', opts: { quality: 95, subsampling: '4:4:4', optimizeCoding: true, mostOptimalCoding: true }, meanTol: 2, maxTol: 28 },
];

for (const c of cases) {
  test(`round-trip ${c.name}`, () => {
    const jpg = encode({ width: W, height: H, data: source, channels: 4 }, c.opts);

    // structural sanity
    assert.equal(jpg[0], 0xff);
    assert.equal(jpg[1], 0xd8, 'starts with SOI');
    assert.equal(jpg[jpg.length - 2], 0xff);
    assert.equal(jpg[jpg.length - 1], 0xd9, 'ends with EOI');

    const img = decode(jpg);
    assert.equal(img.width, W);
    assert.equal(img.height, H);

    const { mean, max } = errorVsSource(img.data, source, W, H);
    assert.ok(mean <= c.meanTol, `${c.name}: round-trip mean ${mean.toFixed(2)} > ${c.meanTol}`);
    assert.ok(max <= c.maxTol, `${c.name}: round-trip max ${max} > ${c.maxTol}`);
  });
}

test('round-trip grayscale q90', () => {
  const jpg = encode({ width: W, height: H, data: source, channels: 4 }, { quality: 90, grayscale: true });
  const img = decode(jpg);
  assert.equal(img.numberOfComponents, 1);
  // compare against the luma of the source
  let sum = 0;
  for (let i = 0; i < W * H; i++) {
    const luma = 0.299 * source[i * 4] + 0.587 * source[i * 4 + 1] + 0.114 * source[i * 4 + 2];
    sum += Math.abs(img.data[i * 4] - luma);
  }
  assert.ok(sum / (W * H) <= 3, 'grayscale round-trip mean within tolerance');
});

test('round-trip odd dimensions 37x19', () => {
  const w = 37;
  const h = 19;
  const src = makeScene(w, h);
  const jpg = encode({ width: w, height: h, data: src, channels: 4 }, { quality: 90, subsampling: '4:2:0' });
  const img = decode(jpg);
  assert.equal(img.width, w);
  assert.equal(img.height, h);
  const { mean } = errorVsSource(img.data, src, w, h);
  // small image + 4:2:0 + sharp colour blocks -> proportionally more chroma loss
  assert.ok(mean <= 9, `odd-size round-trip mean ${mean.toFixed(2)} within tolerance`);
});

test('optimized coding is smaller than or equal to standard coding', () => {
  const std = encode({ width: W, height: H, data: source, channels: 4 }, { quality: 80, subsampling: '4:2:0' });
  const opt = encode({ width: W, height: H, data: source, channels: 4 }, { quality: 80, subsampling: '4:2:0', optimizeCoding: true });
  assert.ok(opt.length <= std.length, `optimized (${opt.length}) <= standard (${std.length})`);
});
