// EXIF orientation: parsing, the pixel transform, and end-to-end via decode().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, readExifOrientation, applyOrientation } from '../src/index.js';

// Build an APP1 EXIF segment carrying just the Orientation tag (0x0112).
function buildExifApp1(orientation, big = false) {
  const t = [];
  const w16 = (v) => (big ? t.push((v >> 8) & 0xff, v & 0xff) : t.push(v & 0xff, (v >> 8) & 0xff));
  const w32 = (v) => (big
    ? t.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
    : t.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff));

  t.push(big ? 0x4d : 0x49, big ? 0x4d : 0x49); // "MM" or "II"
  w16(42); // TIFF magic
  w32(8); // IFD0 offset
  w16(1); // one entry
  w16(0x0112); w16(3); w32(1); // tag=Orientation, type=SHORT, count=1
  if (big) t.push((orientation >> 8) & 0xff, orientation & 0xff, 0, 0);
  else t.push(orientation & 0xff, (orientation >> 8) & 0xff, 0, 0);
  w32(0); // next IFD

  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...t]; // "Exif\0\0" + TIFF
  const segLen = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff, ...payload]);
}

function spliceAfterSoi(jpeg, seg) {
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
}

const tinyJpeg = encode(
  { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(200), channels: 4 },
  { quality: 90 },
);

test('readExifOrientation reads both byte orders, defaults to 1', () => {
  assert.equal(readExifOrientation(tinyJpeg), 1, 'no EXIF -> normal');
  for (const big of [false, true]) {
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const j = spliceAfterSoi(tinyJpeg, buildExifApp1(o, big));
      assert.equal(readExifOrientation(j), o, `orientation ${o} (${big ? 'big' : 'little'}-endian)`);
    }
  }
});

test('applyOrientation transforms pixels correctly', () => {
  // a 2x1 image: [red, green]
  const rgba = Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255]);
  const px = (r, x, y, w) => Array.from(r.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 3));

  const flipH = applyOrientation(rgba, 2, 1, 2);
  assert.deepEqual([flipH.width, flipH.height], [2, 1]);
  assert.deepEqual(px(flipH, 0, 0, 2), [0, 255, 0]); // green now on the left

  const cw = applyOrientation(rgba, 2, 1, 6); // rotate 90 CW -> 1x2 column [red; green]
  assert.deepEqual([cw.width, cw.height], [1, 2]);
  assert.deepEqual(px(cw, 0, 0, 1), [255, 0, 0]);
  assert.deepEqual(px(cw, 0, 1, 1), [0, 255, 0]);

  const ccw = applyOrientation(rgba, 2, 1, 8); // rotate 90 CCW -> 1x2 column [green; red]
  assert.deepEqual(px(ccw, 0, 0, 1), [0, 255, 0]);
  assert.deepEqual(px(ccw, 0, 1, 1), [255, 0, 0]);

  // orientation 1 returns the buffer unchanged
  assert.equal(applyOrientation(rgba, 2, 1, 1).data, rgba);
});

test('decode() applies EXIF orientation (and can opt out)', () => {
  // 16x8 image, red in the top-left quadrant, white elsewhere
  const W = 16;
  const H = 8;
  const data = new Uint8Array(W * H * 4).fill(255);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x < W / 2 && y < H / 2) {
        const i = (y * W + x) * 4;
        data[i] = 255; data[i + 1] = 0; data[i + 2] = 0;
      }
    }
  }
  const jpg = encode({ width: W, height: H, data, channels: 4 }, { quality: 95, subsampling: '4:4:4' });
  const oriented = spliceAfterSoi(jpg, buildExifApp1(6)); // rotate 90 CW

  const img = decode(oriented);
  assert.equal(img.orientation, 6);
  assert.equal(img.width, 8, 'rotated width');
  assert.equal(img.height, 16, 'rotated height');
  // after 90° CW the red quadrant lands top-right; sample an interior point
  const i = (2 * img.width + 6) * 4;
  assert.ok(img.data[i] > 150 && img.data[i + 1] < 100, 'red is in the top-right after rotation');

  const raw = decode(oriented, { applyOrientation: false });
  assert.equal(raw.width, 16, 'raw (unrotated) width');
  assert.equal(raw.height, 8, 'raw (unrotated) height');
});
