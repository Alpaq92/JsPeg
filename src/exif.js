// EXIF orientation support.
//
// stb_image (which JsPeg's inverse DCT is ported from) does NOT handle EXIF
// orientation — it deliberately ignores it. So this is an original, spec-based
// implementation (EXIF/TIFF parsing + a pixel transform), which keeps the
// project single-license MIT with no added obligations.
import { JpegMarker } from './JpegMarker.js';
import { findAppSegment } from './markerScan.js';

// "Exif\0\0"
const EXIF_SIGNATURE = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

/**
 * Read the EXIF orientation (1–8) from a JPEG's APP1 segment.
 * @param {Uint8Array} data
 * @returns {number} the orientation, or 1 (normal) if absent/unreadable
 */
export function readExifOrientation(data) {
  try {
    const seg = findAppSegment(data, JpegMarker.App1, EXIF_SIGNATURE);
    if (seg === null) return 1;
    const value = parseTiffOrientation(data, seg.start, seg.end);
    return value >= 1 && value <= 8 ? value : 1;
  } catch {
    return 1; // malformed EXIF -> treat as normal
  }
}

function parseTiffOrientation(data, tiff, end) {
  if (tiff + 8 > end) return 0;
  const little = data[tiff] === 0x49 && data[tiff + 1] === 0x49; // "II"
  const big = data[tiff] === 0x4d && data[tiff + 1] === 0x4d; // "MM"
  if (!little && !big) return 0;

  const u16 = (o) => (little ? data[o] | (data[o + 1] << 8) : (data[o] << 8) | data[o + 1]);
  const u32 = (o) => (little
    ? (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24))
    : ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3])) >>> 0;

  if (u16(tiff + 2) !== 42) return 0; // TIFF magic

  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > end) return 0;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) {
      // SHORT value lives in the first 2 bytes of the 4-byte value field.
      return u16(entry + 8);
    }
  }
  return 0;
}

/**
 * Apply an EXIF orientation to an interleaved RGBA buffer, returning a new
 * buffer with the corrected pixels (and possibly swapped dimensions).
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} orientation 1–8
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
export function applyOrientation(rgba, width, height, orientation) {
  if (!orientation || orientation === 1) {
    return { data: rgba, width, height };
  }

  const swap = orientation >= 5; // 5–8 transpose the axes
  const outW = swap ? height : width;
  const outH = swap ? width : height;
  const out = new Uint8ClampedArray(outW * outH * 4);

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      let ix;
      let iy;
      switch (orientation) {
        case 2: ix = width - 1 - ox; iy = oy; break; // flip horizontal
        case 3: ix = width - 1 - ox; iy = height - 1 - oy; break; // 180°
        case 4: ix = ox; iy = height - 1 - oy; break; // flip vertical
        case 5: ix = oy; iy = ox; break; // transpose
        case 6: ix = oy; iy = height - 1 - ox; break; // rotate 90° CW
        case 7: ix = width - 1 - oy; iy = height - 1 - ox; break; // transverse
        case 8: ix = width - 1 - oy; iy = ox; break; // rotate 90° CCW
        default: ix = ox; iy = oy; break;
      }
      const s = (iy * width + ix) * 4;
      const d = (oy * outW + ox) * 4;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
      out[d + 3] = rgba[s + 3];
    }
  }
  return { data: out, width: outW, height: outH };
}
