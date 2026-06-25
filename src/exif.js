// EXIF orientation support.
//
// stb_image (which JsPeg's inverse DCT is ported from) does not handle EXIF
// orientation, so the reader below is adapted from exifr by Mike Kovařík
// (https://github.com/MikeKovarik/exifr), used under the MIT License
// (Copyright (c) 2020 Mike Kovařík, Mutiny.cz) — see LICENSE. Specifically,
// `readOrientationTag` follows exifr's TIFF parseHeader/parseTags/parseTag flow
// (byte-order marker, IFD0 walk, the 12-byte entries, and the inline-vs-offset
// value rule), and `applyOrientation` follows its `rotations` table. Vendored as
// a minimal slice so JsPeg keeps its zero-dependency, single-license-MIT design.
import { JpegMarker } from './JpegMarker.js';
import { findAppSegment } from './markerScan.js';

const EXIF_SIGNATURE = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const TIFF_LITTLE_ENDIAN = 0x4949; // "II"
const TIFF_BIG_ENDIAN = 0x4d4d; // "MM"
const TAG_ORIENTATION = 0x0112;
// TIFF value type -> byte size (exifr's SIZE_LOOKUP).
const TIFF_TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

/**
 * Read the EXIF orientation (1–8) from a JPEG's APP1 segment.
 * @param {Uint8Array} data
 * @returns {number} the orientation, or 1 (normal) if absent/unreadable
 */
export function readExifOrientation(data) {
  try {
    const seg = findAppSegment(data, JpegMarker.App1, EXIF_SIGNATURE);
    if (seg === null) return 1;
    const value = readOrientationTag(data, seg.start, seg.end);
    return value >= 1 && value <= 8 ? value : 1;
  } catch {
    return 1; // malformed EXIF -> treat as normal
  }
}

// Port of exifr's TiffCore parseHeader/parseTags/parseTag, narrowed to the
// single Orientation tag in IFD0. Offsets are relative to the TIFF header start.
function readOrientationTag(data, tiff, end) {
  const length = end - tiff;
  if (length < 8) return 0;
  const view = new DataView(data.buffer, data.byteOffset + tiff, length);

  // parseHeader: the byte-order marker is palindromic, so it reads the same
  // regardless of endianness; use it to pick `le`.
  const byteOrder = view.getUint16(0);
  let le;
  if (byteOrder === TIFF_LITTLE_ENDIAN) le = true;
  else if (byteOrder === TIFF_BIG_ENDIAN) le = false;
  else return 0;

  const ifd0 = view.getUint32(4, le); // IFD0 offset (bytes 4..7)
  if (ifd0 + 2 > length) return 0;

  // parseTags: walk IFD0's 12-byte entries.
  const count = view.getUint16(ifd0, le);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > length) break;
    if (view.getUint16(entry, le) !== TAG_ORIENTATION) continue;

    // parseTag: the value is inline when it fits in 4 bytes, else at an offset.
    const type = view.getUint16(entry + 2, le);
    const valueCount = view.getUint32(entry + 4, le);
    const totalSize = (TIFF_TYPE_SIZE[type] || 0) * valueCount;
    const valueOffset = totalSize <= 4 ? entry + 8 : view.getUint32(entry + 8, le);
    if (valueOffset + 2 > length) return 0;
    return view.getUint16(valueOffset, le); // Orientation is a SHORT
  }
  return 0;
}

/**
 * Apply an EXIF orientation to an interleaved RGBA buffer, returning a new
 * buffer with the corrected pixels (and possibly swapped dimensions). The
 * per-orientation transforms correspond to exifr's `rotations` table.
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
