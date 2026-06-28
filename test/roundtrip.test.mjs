// Pure-JS encoder validation: encode an in-memory image, decode it back, and
// check the result is faithful within the loss expected at each quality.
// No fixtures, no external tooling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, decodeComponents } from '../src/index.js';
import { makeScene, SAMPLES } from '../demo/samples.js';

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

// Subsampling / quality matrix on the landscape. The mean is the correctness
// gate (kept tight); the max is loose because JPEG ringing + chroma subsampling
// legitimately spike single channels at the sharp sun/river edges.
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

// Every built-in sample (grayscale, rainbow, colour bars, pure green, landscape)
// round-trips faithfully across colour and subsampled encodes — the mean is the
// correctness gate over very different content.
for (const sample of SAMPLES) {
  test(`round-trip sample: ${sample.name}`, () => {
    const w = 96;
    const h = 64;
    const src = sample.make(w, h);
    for (const [opts, meanTol] of [
      [{ quality: 92, subsampling: '4:4:4' }, 2.5],
      // 4:2:0 decode uses fancy (bilinear) chroma upsampling, which smooths the
      // saturated hard edges of the synthetic "Colour bars" sample — better on
      // real photos, marginally looser here. Still the correctness gate.
      [{ quality: 88, subsampling: '4:2:0' }, 7],
    ]) {
      const jpg = encode({ width: w, height: h, data: src, channels: 4 }, { ...opts, grayscale: sample.gray });
      const img = decode(jpg);
      assert.equal(img.width, w);
      assert.equal(img.height, h);
      if (sample.gray) assert.equal(img.numberOfComponents, 1, 'grayscale sample stays single-component');
      const { mean } = errorVsSource(img.data, src, w, h);
      assert.ok(mean <= meanTol, `${sample.name} ${opts.subsampling} q${opts.quality}: mean ${mean.toFixed(2)} > ${meanTol}`);
    }
  });
}

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

// --- lossless (SOF3) encode: must be bit-exact through the decoder ------------
// This also exercises the lossless decoder, which has no conformance fixture
// (no other tool here can produce a lossless JPEG to mint one from).
function isLossless(data) {
  for (let i = 0; i + 1 < data.length; i++) {
    if (data[i] === 0xff && data[i + 1] === 0xc3) return true;
  }
  return false;
}

test('lossless grayscale round-trips exactly for all 7 predictors', () => {
  const w = 70;
  const h = 47; // odd dimensions
  const gray = new Uint8Array(w * h);
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      gray[y * w + x] = Math.max(0, Math.min(255, 50 + x + 40 * Math.sin(y / 6) + 30 * (rnd() - 0.5))) | 0;
    }
  }
  for (let predictor = 1; predictor <= 7; predictor++) {
    const jpg = encode({ width: w, height: h, data: gray, channels: 1 }, { lossless: true, predictor });
    assert.ok(isLossless(jpg), `predictor ${predictor}: output is SOF3 lossless`);
    const img = decode(jpg);
    assert.equal(img.width, w);
    assert.equal(img.height, h);
    let max = 0;
    for (let i = 0; i < w * h; i++) max = Math.max(max, Math.abs(gray[i] - img.data[i * 4]));
    assert.equal(max, 0, `predictor ${predictor}: lossless (maxDiff ${max})`);
  }
});

test('lossless RGB round-trips exactly (no colour transform)', () => {
  const w = 64;
  const h = 48;
  const src = makeScene(w, h);
  const jpg = encode({ width: w, height: h, data: src, channels: 4 }, { lossless: true, predictor: 4 });
  assert.ok(isLossless(jpg), 'output is SOF3 lossless');
  const img = decode(jpg);
  let max = 0;
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(src[i * 4 + c] - img.data[i * 4 + c]));
  }
  assert.equal(max, 0, `lossless RGB (maxDiff ${max})`);
});

test('lossless 12-bit grayscale round-trips exactly', () => {
  const w = 48;
  const h = 40;
  const gray = new Uint16Array(w * h); // 12-bit samples (0..4095)
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      gray[y * w + x] = Math.max(0, Math.min(4095, 800 + x * 30 + 600 * Math.sin(y / 5) + 400 * (rnd() - 0.5))) | 0;
    }
  }
  const jpg = encode({ width: w, height: h, data: gray, channels: 1, precision: 12 }, { lossless: true, predictor: 4 });
  assert.ok(isLossless(jpg), 'output is SOF3 lossless');
  const comp = decodeComponents(jpg);
  assert.equal(comp.precision, 12, 'decoded at 12-bit precision');
  let max = 0;
  for (let i = 0; i < w * h; i++) max = Math.max(max, Math.abs(gray[i] - comp.components[0][i]));
  assert.equal(max, 0, `12-bit lossless exact (maxDiff ${max})`);
});

// --- native progressive / arithmetic encode from pixels ----------------------
// encode({ progressive }) / { arithmetic } emit the requested frame type
// straight from pixels (internally: a baseline encode + a lossless transcode),
// so the decoded pixels are identical to a plain baseline encode.
function frameType(bytes) {
  for (let i = 2; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff) {
      const m = bytes[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8) return m; // an SOFn
    }
  }
  return 0;
}

test('native progressive / arithmetic encode from pixels (right frame type, pixel-identical)', () => {
  const opts = { quality: 85, subsampling: '4:2:0' };
  const baseline = decode(encode({ width: W, height: H, data: source, channels: 4 }, opts)).data;
  for (const [extra, sof] of [
    [{ progressive: true }, 0xc2], // SOF2
    [{ arithmetic: true }, 0xc9], // SOF9
    [{ arithmetic: true, progressive: true }, 0xca], // SOF10
  ]) {
    const out = encode({ width: W, height: H, data: source, channels: 4 }, { ...opts, ...extra });
    assert.equal(frameType(out), sof, `frame type 0x${sof.toString(16)}`);
    const back = decode(out).data;
    let max = 0;
    for (let i = 0; i < back.length; i++) max = Math.max(max, Math.abs(back[i] - baseline[i]));
    assert.equal(max, 0, `${JSON.stringify(extra)}: pixel-identical to the baseline encode`);
  }
});

test('native progressive encode preserves an embedded ICC profile', () => {
  const icc = new Uint8Array(1800);
  for (let i = 0; i < icc.length; i++) icc[i] = (i * 7 + 3) & 0xff;
  const prog = encode({ width: W, height: H, data: source, channels: 4 }, { quality: 85, progressive: true, icc });
  assert.equal(frameType(prog), 0xc2, 'SOF2 progressive');
  const back = decodeComponents(prog).icc;
  assert.ok(back && back.length === icc.length, 'ICC present, right length');
  let same = true;
  for (let i = 0; i < icc.length; i++) if (back[i] !== icc[i]) { same = false; break; }
  assert.ok(same, 'ICC bytes preserved through the transcode');
});

// --- ICC colour profile embed (encode) + read (decode) -----------------------

test('ICC profile embeds and reads back byte-exact (single + multi-chunk)', () => {
  const w = 32;
  const h = 24;
  const src = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { src[i * 4] = i % 200; src[i * 4 + 1] = 100; src[i * 4 + 2] = 200 - (i % 150); src[i * 4 + 3] = 255; }
  for (const size of [2000, 150000]) { // 1 chunk (≤65519), then multi-chunk
    const icc = new Uint8Array(size);
    for (let i = 0; i < size; i++) icc[i] = (i * 7 + 13) & 0xff;
    const jpg = encode({ width: w, height: h, data: src, channels: 4 }, { quality: 85, icc });
    const got = decodeComponents(jpg).icc;
    assert.ok(got && got.length === size, `ICC ${size}: present with the right length`);
    let same = true;
    for (let i = 0; same && i < size; i++) same = got[i] === icc[i];
    assert.ok(same, `ICC ${size}: round-trips byte-exact`);
    assert.equal(decode(jpg).width, w, `ICC ${size}: the image still decodes`);
  }
});

test('no ICC profile -> decodeComponents().icc is null', () => {
  const w = 16;
  const h = 16;
  const src = new Uint8Array(w * h * 4).fill(128);
  assert.equal(decodeComponents(encode({ width: w, height: h, data: src, channels: 4 }, { quality: 80 })).icc, null);
});
