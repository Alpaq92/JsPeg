// Metadata readers vs. a frozen fixture (test/fixtures/meta.jpg) whose EXIF +
// thumbnail were written by piexif and whose XMP + IPTC segments were appended
// by hand — so the parser is checked against an independent writer. (Pillow and
// IptcImagePlugin read the same values out-of-band.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readMetadata, decodeComponents } from '../src/index.js';

const jpg = new Uint8Array(readFileSync(new URL('./fixtures/meta.jpg', import.meta.url)));
const m = readMetadata(jpg);

test('EXIF image / photo / GPS IFD tags', () => {
  assert.equal(m.exif.image.Make, 'JsPegCam');
  assert.equal(m.exif.image.Model, 'Model-X');
  assert.equal(m.exif.image.Software, 'JsPeg 1.0');
  assert.equal(m.exif.image.Orientation, 1);
  assert.equal(m.exif.image.DateTime, '2026:06:29 12:00:00');
  assert.equal(m.exif.photo.FNumber, 2.8); // 28/10 RATIONAL
  assert.equal(m.exif.photo.ISOSpeedRatings, 200);
  assert.equal(m.exif.photo.LensModel, 'JsPeg 50mm');
  assert.deepEqual(m.exif.gps.GPSLatitude, [52, 13, 0]); // 3 RATIONALs
  assert.equal(m.exif.gps.GPSLatitudeRef, 'N');
});

test('embedded EXIF thumbnail (IFD1) is extracted as a JPEG', () => {
  assert.ok(m.thumbnail && m.thumbnail.length > 0);
  assert.equal(m.thumbnail[0], 0xff);
  assert.equal(m.thumbnail[1], 0xd8, 'thumbnail starts with SOI');
});

test('XMP packet is extracted', () => {
  assert.ok(m.xmp && m.xmp.includes('Hello XMP'));
});

test('IPTC datasets: caption, repeatable keywords, by-line', () => {
  assert.equal(m.iptc['Caption-Abstract'], 'A test caption');
  assert.deepEqual(m.iptc.Keywords, ['alpha', 'beta']); // dataset repeats -> array
  assert.equal(m.iptc['By-line'], 'Jane Doe');
});

test('decodeComponents().metadata exposes the same, parsed lazily on access', () => {
  const c = decodeComponents(jpg);
  assert.equal(c.metadata.exif.image.Make, 'JsPegCam');
  assert.equal(c.metadata.iptc['By-line'], 'Jane Doe');
});

test('a JPEG with no metadata yields all-null (no throw)', () => {
  const bare = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // SOI + EOI
  const r = readMetadata(bare);
  assert.equal(r.exif, null);
  assert.equal(r.thumbnail, null);
  assert.equal(r.xmp, null);
  assert.equal(r.iptc, null);
});
