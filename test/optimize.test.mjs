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

// --- progressive transcode (baseline -> progressive), lossless ---------------

/** True if the stream contains a Start-of-Frame-2 (progressive) marker. */
function isProgressive(data) {
  for (let i = 0; i + 1 < data.length; i++) {
    if (data[i] === 0xff && data[i + 1] === 0xc2) return true;
  }
  return false;
}

for (const fx of baseline) {
  test(`optimize ${fx.name} --progressive is lossless and valid progressive`, () => {
    const src = readFileSync(new URL(`./fixtures/${fx.file}`, import.meta.url));
    const prog = optimize(src, { progressive: true });
    assert.ok(isProgressive(prog), 'output is a progressive (SOF2) JPEG');
    assert.ok(pixelsEqual(decode(src).data, decode(prog).data), 'decoded pixels are identical');
  });
}

test('optimize --progressive throws a clear error on non-baseline input', () => {
  const prog = readFileSync(new URL('./fixtures/rgb_prog_444_q88.jpg', import.meta.url));
  assert.throws(() => optimize(prog, { progressive: true }), /not supported/i);
});

// Successive approximation is the part that makes progressive meaningfully
// smaller. On the tiny fixtures the extra scan headers dominate, so the win only
// shows at real image sizes — synthesize one and assert it beats baseline-optimal.
test('optimize --progressive (successive approximation) beats baseline-optimal at real size', () => {
  const W = 384;
  const H = 384;
  const data = new Uint8Array(W * H * 4);
  let seed = 9;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = 128 + 80 * Math.sin(x / 20) + 30 * (rnd() - 0.5);
      data[i + 1] = 120 + 70 * Math.sin((x + y) / 25) + 30 * (rnd() - 0.5);
      data[i + 2] = 140 + 60 * Math.cos(x / 30) + 30 * (rnd() - 0.5);
      data[i + 3] = 255;
    }
  }
  const base = encode({ width: W, height: H, data, channels: 4 }, { quality: 85 });
  const prog = optimize(base, { progressive: true });
  const optimal = optimize(base);
  assert.ok(isProgressive(prog), 'output is progressive (SOF2)');
  assert.ok(prog.length < optimal.length, `progressive ${prog.length} should be < baseline-optimal ${optimal.length}`);
  assert.ok(pixelsEqual(decode(base).data, decode(prog).data), 'decoded pixels are identical');
});

// --- arithmetic transcode (baseline -> SOF9 arithmetic), lossless ------------

/** True if the stream contains a Start-of-Frame-9 (arithmetic sequential) marker. */
function isArithmetic(data) {
  for (let i = 0; i + 1 < data.length; i++) {
    if (data[i] === 0xff && data[i + 1] === 0xc9) return true;
  }
  return false;
}

for (const fx of baseline) {
  test(`optimize ${fx.name} --arithmetic is lossless and valid SOF9`, () => {
    const src = readFileSync(new URL(`./fixtures/${fx.file}`, import.meta.url));
    const ari = optimize(src, { arithmetic: true });
    assert.ok(isArithmetic(ari), 'output is an arithmetic-coded (SOF9) JPEG');
    assert.ok(ari.length <= src.length, `arithmetic (${ari.length}) <= original (${src.length})`);
    assert.ok(pixelsEqual(decode(src).data, decode(ari).data), 'decoded pixels are identical');
  });
}

test('optimize --arithmetic throws a clear error on non-baseline input', () => {
  const prog = readFileSync(new URL('./fixtures/rgb_prog_444_q88.jpg', import.meta.url));
  assert.throws(() => optimize(prog, { arithmetic: true }), /not supported/i);
});

// --- trellis quantization (lossy rate-distortion thresholding) ---------------

/** True if the stream contains a Start-of-Frame-0 (baseline) marker. */
function isBaseline(data) {
  for (let i = 0; i + 1 < data.length; i++) {
    if (data[i] === 0xff && data[i + 1] === 0xc0) return true;
  }
  return false;
}

function psnr(a, b) {
  let se = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if ((i & 3) === 3) continue; // skip alpha
    const d = a[i] - b[i];
    se += d * d;
    n++;
  }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n));
}

test('optimize --trellis is a smaller, valid, high-quality baseline JPEG', () => {
  const src = readFileSync(new URL('./fixtures/rgb_444_q92.jpg', import.meta.url));
  const trellised = optimize(src, { trellis: true, lambda: 8 });
  assert.ok(isBaseline(trellised), 'output is a baseline (SOF0) JPEG');
  assert.ok(trellised.length < optimize(src).length, 'trellis is smaller than lossless optimize');
  const p = psnr(decode(src).data, decode(trellised).data);
  assert.ok(p > 35, `trellis stays high quality (PSNR ${p.toFixed(1)}dB > 35)`);
});

test('optimize --trellis throws a clear error on non-baseline input', () => {
  const prog = readFileSync(new URL('./fixtures/rgb_prog_444_q88.jpg', import.meta.url));
  assert.throws(() => optimize(prog, { trellis: true }), /not supported/i);
});
