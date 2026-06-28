// ICC colour-profile embedding/extraction for JPEG. Clean-room from the ICC.org
// specification ("Embedding ICC profiles in JFIF files", Annex B.4): the profile
// is split across one or more APP2 segments, each starting with the 12-byte
// "ICC_PROFILE\0" marker, then a 1-based chunk number and the total chunk count,
// then up to 65519 bytes of the profile. Chunks are concatenated in order.
import { findAppSegments } from './markerScan.js';

const APP2 = 0xe2;
// "ICC_PROFILE\0"
const ICC_MARKER = new Uint8Array([0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]);
const MAX_CHUNK = 65519; // 65535 - 2 (length) - 12 (marker) - 2 (seq + total)

/**
 * Read an embedded ICC profile from a JPEG byte stream.
 * @param {Uint8Array} data
 * @returns {Uint8Array|null} the assembled profile, or null if none is present
 */
export function readIccProfile(data) {
  // Each APP2 payload (after the ICC marker) is: chunk number, total, profile bytes.
  const chunks = findAppSegments(data, APP2, ICC_MARKER)
    .map((s) => ({ seq: data[s.start], payload: data.subarray(s.start + 2, s.end) }));
  if (chunks.length === 0) return null;

  chunks.sort((a, b) => a.seq - b.seq);
  const total = chunks.reduce((n, c) => n + c.payload.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c.payload, off);
    off += c.payload.length;
  }
  return out;
}

/**
 * Build the APP2 segment(s) that embed an ICC profile (full FF E2 … segments,
 * ready to splice in right after SOI).
 * @param {Uint8Array|ArrayBuffer} icc
 * @returns {Uint8Array[]}
 */
export function iccApp2Segments(icc) {
  const data = icc instanceof Uint8Array ? icc : new Uint8Array(icc);
  const n = Math.max(1, Math.ceil(data.length / MAX_CHUNK));
  if (n > 255) throw new Error('ICC profile too large to embed (would need > 255 APP2 chunks).');

  const segments = [];
  for (let i = 0; i < n; i++) {
    const part = data.subarray(i * MAX_CHUNK, (i + 1) * MAX_CHUNK);
    const len = 2 + ICC_MARKER.length + 2 + part.length; // the length field counts itself
    const seg = new Uint8Array(2 + len);
    seg[0] = 0xff;
    seg[1] = APP2;
    seg[2] = (len >> 8) & 0xff;
    seg[3] = len & 0xff;
    seg.set(ICC_MARKER, 4);
    seg[16] = i + 1; // chunk number (1-based)
    seg[17] = n; // total chunks
    seg.set(part, 18);
    segments.push(seg);
  }
  return segments;
}
