// Walk a JPEG's marker segments to find APPn segments by marker byte and leading
// signature. Shared by the EXIF-orientation, Adobe-transform and ICC readers.
// Returns the payload span(s) *after* the signature.
import { JpegMarker, isRestartMarker } from './JpegMarker.js';

/**
 * Every APPn segment matching `markerByte` + `signature`, in file order — for
 * data that may span multiple segments (e.g. an ICC profile across APP2 chunks).
 * @param {Uint8Array} data
 * @param {number} markerByte e.g. 0xE1 for APP1, 0xE2 for APP2
 * @param {ArrayLike<number>} signature bytes that must immediately follow the length field
 * @returns {{ start: number, end: number }[]} payload ranges after the signature
 */
export function findAppSegments(data, markerByte, signature) {
  const segments = [];
  let offset = 2; // skip SOI
  const len = data.length;
  while (offset + 4 <= len) {
    if (data[offset] !== 0xff) {
      offset++;
      continue;
    }
    let marker = data[offset + 1];
    while (marker === 0xff && offset + 2 < len) {
      offset++;
      marker = data[offset + 1];
    }
    offset += 2;

    if (marker === JpegMarker.StartOfScan || marker === JpegMarker.EndOfImage) break; // no more metadata
    // standalone markers (RSTn, SOI, TEM, padding) carry no length field
    if (isRestartMarker(marker) || marker === JpegMarker.StartOfImage || marker === 0x01 || marker === 0) continue;

    if (offset + 2 > len) break;
    const segLen = (data[offset] << 8) | data[offset + 1];
    if (segLen < 2 || offset + segLen > len) break;

    if (marker === markerByte && segLen >= 2 + signature.length) {
      let match = true;
      for (let i = 0; i < signature.length; i++) {
        if (data[offset + 2 + i] !== signature[i]) {
          match = false;
          break;
        }
      }
      if (match) segments.push({ start: offset + 2 + signature.length, end: offset + segLen });
    }
    offset += segLen;
  }
  return segments;
}

/** The first matching APPn segment, or null. @returns {{ start: number, end: number } | null} */
export function findAppSegment(data, markerByte, signature) {
  const segments = findAppSegments(data, markerByte, signature);
  return segments.length ? segments[0] : null;
}
