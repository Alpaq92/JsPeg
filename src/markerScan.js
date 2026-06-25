// Walk a JPEG's marker segments to find a specific APPn segment by marker byte
// and leading signature. Shared by the EXIF-orientation and Adobe-transform
// readers. Returns the payload span *after* the signature, or null.

/**
 * @param {Uint8Array} data
 * @param {number} markerByte e.g. 0xE1 for APP1, 0xEE for APP14
 * @param {number[]} signature bytes that must immediately follow the length field
 * @returns {{ start: number, end: number } | null} payload range after the signature
 */
export function findAppSegment(data, markerByte, signature) {
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

    if (marker === 0xda || marker === 0xd9) break; // SOS or EOI: no more metadata
    // standalone markers (RSTn, TEM, padding) carry no length field
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01 || marker === 0) continue;

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
      if (match) return { start: offset + 2 + signature.length, end: offset + segLen };
    }
    offset += segLen;
  }
  return null;
}
