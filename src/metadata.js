// Clean-room JPEG metadata readers, built from the public Exif 2.3 / TIFF 6.0,
// Adobe XMP, and IPTC IIM specifications. Read-only:
//   - EXIF  : APP1 "Exif\0\0" → TIFF IFD chain (image / photo / gps tags)
//   - thumb : the EXIF IFD1 embedded thumbnail (usually a small JPEG)
//   - XMP   : APP1 "http://ns.adobe.com/xap/1.0/\0" → the raw XMP packet
//   - IPTC  : APP13 "Photoshop 3.0" → 8BIM resource 0x0404 → IIM datasets
import { findAppSegment } from './markerScan.js';

const sig = (s) => Array.from(s, (c) => c.charCodeAt(0));
const EXIF_SIG = sig('Exif\0\0');
const XMP_SIG = sig('http://ns.adobe.com/xap/1.0/\0');
const PHOTOSHOP_SIG = sig('Photoshop 3.0\0');
const JFIF_SIG = sig('JFIF\0');

// TIFF field type → byte size (0 for unknown/reserved types).
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

// Common tag id → name, per IFD namespace. Unknown tags fall back to "0xXXXX".
const IMAGE_TAGS = {
  0x0100: 'ImageWidth', 0x0101: 'ImageLength', 0x010e: 'ImageDescription', 0x010f: 'Make',
  0x0110: 'Model', 0x0112: 'Orientation', 0x011a: 'XResolution', 0x011b: 'YResolution',
  0x0128: 'ResolutionUnit', 0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist',
  0x013e: 'WhitePoint', 0x0211: 'YCbCrCoefficients', 0x0213: 'YCbCrPositioning',
  0x0201: 'JPEGInterchangeFormat', 0x0202: 'JPEGInterchangeFormatLength', // IFD1 thumbnail
  0x8298: 'Copyright', 0x8769: 'ExifIFDPointer', 0x8825: 'GPSInfoIFDPointer',
};
const PHOTO_TAGS = {
  0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8822: 'ExposureProgram', 0x8827: 'ISOSpeedRatings',
  0x9000: 'ExifVersion', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized',
  0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue', 0x9204: 'ExposureBiasValue',
  0x9207: 'MeteringMode', 0x9209: 'Flash', 0x920a: 'FocalLength', 0x927c: 'MakerNote',
  0x9286: 'UserComment', 0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension',
  0xa402: 'ExposureMode', 0xa403: 'WhiteBalance', 0xa406: 'SceneCaptureType',
  0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber', 0xa432: 'LensSpecification',
  0xa433: 'LensMake', 0xa434: 'LensModel',
};
const GPS_TAGS = {
  0x0000: 'GPSVersionID', 0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude', 0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude', 0x0005: 'GPSAltitudeRef', 0x0006: 'GPSAltitude', 0x0007: 'GPSTimeStamp',
  0x0012: 'GPSMapDatum', 0x001d: 'GPSDateStamp',
};

// --- TIFF / Exif -------------------------------------------------------------

/** Reader over the TIFF block with a fixed byte order. */
class Tiff {
  constructor(data, base, end, little) {
    this.d = data;
    this.base = base; // file offset of the TIFF header (byte-order mark)
    this.end = end; // end of the Exif APP1 payload — every offset must stay inside it
    this.le = little;
  }
  u16(p) {
    const d = this.d;
    return this.le ? d[p] | (d[p + 1] << 8) : (d[p] << 8) | d[p + 1];
  }
  u32(p) {
    const d = this.d;
    return (this.le
      ? d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)
      : (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
  }
  i32(p) {
    return this.u32(p) | 0;
  }
}

function decodeValue(t, type, count, p) {
  const out = [];
  for (let i = 0; i < count; i++) {
    switch (type) {
      case 1: case 6: case 7: out.push(t.d[p + i]); break; // BYTE / SBYTE / UNDEFINED
      case 3: case 8: out.push(t.u16(p + i * 2)); break; // SHORT / SSHORT
      case 4: out.push(t.u32(p + i * 4)); break; // LONG
      case 9: out.push(t.i32(p + i * 4)); break; // SLONG
      case 5: { const n = t.u32(p + i * 8); const den = t.u32(p + i * 8 + 4); out.push(den ? n / den : 0); break; } // RATIONAL
      case 10: { const n = t.i32(p + i * 8); const den = t.i32(p + i * 8 + 4); out.push(den ? n / den : 0); break; } // SRATIONAL
      default: out.push(t.d[p + i]); break;
    }
  }
  if (type === 2) {
    // ASCII — bytes up to the (optional) NUL terminator.
    let end = p + count;
    for (let i = p; i < p + count; i++) { if (t.d[i] === 0) { end = i; break; } }
    let s = '';
    for (let i = p; i < end; i++) s += String.fromCharCode(t.d[i]);
    return s;
  }
  return out.length === 1 ? out[0] : out;
}

function readIfd(t, ifdOffset, tagNames) {
  const p0 = t.base + ifdOffset;
  if (p0 < t.base || p0 + 2 > t.end) return { tags: {}, next: 0 };
  const count = t.u16(p0);
  const tags = {};
  let p = p0 + 2;
  for (let i = 0; i < count && p + 12 <= t.end; i++, p += 12) {
    const tag = t.u16(p);
    const type = t.u16(p + 2);
    const cnt = t.u32(p + 4);
    const size = (TYPE_SIZE[type] || 1) * cnt;
    const valuePos = size <= 4 ? p + 8 : t.base + t.u32(p + 8);
    if (valuePos < t.base || valuePos + size > t.end) continue; // stay within the APP1 segment
    tags[tagNames[tag] || `0x${tag.toString(16).padStart(4, '0')}`] = decodeValue(t, type, cnt, valuePos);
  }
  const next = p + 4 <= t.end ? t.u32(p) : 0;
  return { tags, next };
}

/** Locate + frame the TIFF block of the Exif APP1 segment. @returns {Tiff|null} */
function exifTiff(data) {
  const seg = findAppSegment(data, 0xe1, EXIF_SIG);
  if (!seg) return null;
  const base = seg.start; // first byte after "Exif\0\0" = the TIFF byte-order mark
  if (base + 8 > data.length) return null;
  const bom = (data[base] << 8) | data[base + 1];
  if (bom !== 0x4949 && bom !== 0x4d4d) return null; // "II" little / "MM" big
  return new Tiff(data, base, seg.end, bom === 0x4949);
}

// Parse the Exif TIFF header + IFD0 once; the photo/gps IFDs and the thumbnail
// all derive from this, so readMetadata() shares one context across them.
function exifContext(data) {
  const t = exifTiff(data);
  if (!t) return null;
  return { t, ifd0: readIfd(t, t.u32(t.base + 4), IMAGE_TAGS) };
}

function exifTags({ t, ifd0 }) {
  const result = { image: ifd0.tags };
  if (ifd0.tags.ExifIFDPointer) result.photo = readIfd(t, ifd0.tags.ExifIFDPointer, PHOTO_TAGS).tags;
  if (ifd0.tags.GPSInfoIFDPointer) result.gps = readIfd(t, ifd0.tags.GPSInfoIFDPointer, GPS_TAGS).tags;
  return result;
}

function exifThumbnail({ t, ifd0 }, data) {
  if (!ifd0.next) return null;
  const ifd1 = readIfd(t, ifd0.next, IMAGE_TAGS);
  const off = ifd1.tags.JPEGInterchangeFormat; // offset, from the TIFF base
  const len = ifd1.tags.JPEGInterchangeFormatLength;
  if (!off || !len) return null;
  const start = t.base + off;
  if (start < t.base || start + len > t.end) return null; // thumbnail lives inside the APP1 segment
  return data.subarray(start, start + len);
}

/** @returns {{image:object, photo?:object, gps?:object}|null} */
export function readExif(data) {
  const ctx = exifContext(data);
  return ctx ? exifTags(ctx) : null;
}

/** The embedded EXIF thumbnail (IFD1) as raw bytes, or null. @returns {Uint8Array|null} */
export function readThumbnail(data) {
  const ctx = exifContext(data);
  return ctx ? exifThumbnail(ctx, data) : null;
}

// --- XMP ---------------------------------------------------------------------

/** The raw XMP packet (an RDF/XML string), or null. @returns {string|null} */
export function readXmp(data) {
  const seg = findAppSegment(data, 0xe1, XMP_SIG);
  if (!seg) return null;
  return new TextDecoder().decode(data.subarray(seg.start, seg.end)); // XMP packets are UTF-8
}

// --- IPTC (APP13 Photoshop Image Resource Blocks) ----------------------------

const IPTC_TAGS = {
  5: 'ObjectName', 25: 'Keywords', 55: 'DateCreated', 80: 'By-line', 85: 'By-lineTitle',
  90: 'City', 95: 'Province-State', 101: 'Country-PrimaryLocationName', 105: 'Headline',
  110: 'Credit', 115: 'Source', 116: 'CopyrightNotice', 120: 'Caption-Abstract', 122: 'Writer-Editor',
};

/** Parsed IPTC datasets (record 2), or null. Repeated tags become arrays. */
export function readIptc(data) {
  const seg = findAppSegment(data, 0xed, PHOTOSHOP_SIG);
  if (!seg) return null;
  let p = seg.start;
  const end = seg.end;
  // Walk 8BIM image-resource blocks, looking for resource id 0x0404 (IPTC-NAA).
  while (p + 12 <= end) {
    if (!(data[p] === 0x38 && data[p + 1] === 0x42 && data[p + 2] === 0x49 && data[p + 3] === 0x4d)) break; // "8BIM"
    const id = (data[p + 4] << 8) | data[p + 5];
    p += 6;
    const nameLen = data[p];
    p += 1 + nameLen + ((nameLen + 1) % 2); // Pascal name, padded to even
    const size = ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
    p += 4;
    if (id === 0x0404) return parseIptcDatasets(data, p, Math.min(end, p + size));
    p += size + (size % 2); // block data padded to even
  }
  return null;
}

function parseIptcDatasets(data, start, end) {
  const out = {};
  let p = start;
  while (p + 5 <= end && data[p] === 0x1c) {
    const record = data[p + 1];
    const dataset = data[p + 2];
    const len = (data[p + 3] << 8) | data[p + 4];
    p += 5;
    if (p + len > end) break;
    if (record === 2) {
      let s = '';
      for (let i = p; i < p + len; i++) s += String.fromCharCode(data[i]);
      const key = IPTC_TAGS[dataset] || `0x02${dataset.toString(16).padStart(2, '0')}`;
      if (key in out) out[key] = [].concat(out[key], s); // repeatable (e.g. Keywords)
      else out[key] = s;
    }
    p += len;
  }
  return Object.keys(out).length ? out : null;
}

// --- JFIF APP0 thumbnail -----------------------------------------------------

/**
 * The optional uncompressed RGB thumbnail embedded in a JFIF APP0 segment, after
 * the density fields. Rare — most JFIF segments carry no thumbnail.
 * @returns {{ width: number, height: number, data: Uint8Array }|null} interleaved RGB
 */
export function readJfifThumbnail(data) {
  const seg = findAppSegment(data, 0xe0, JFIF_SIG);
  if (!seg) return null;
  // after "JFIF\0": version(2) units(1) Xdensity(2) Ydensity(2) Xthumbnail(1) Ythumbnail(1) RGB…
  const p = seg.start;
  if (p + 9 > seg.end) return null;
  const width = data[p + 7];
  const height = data[p + 8];
  const start = p + 9;
  const size = width * height * 3;
  if (width === 0 || height === 0 || start + size > seg.end) return null;
  return { width, height, data: data.subarray(start, start + size) };
}

// --- aggregate ---------------------------------------------------------------

/**
 * Read all supported metadata from a JPEG byte stream.
 * @param {Uint8Array} data
 * @returns {{ exif: object|null, thumbnail: Uint8Array|null, jfifThumbnail: object|null, xmp: string|null, iptc: object|null }}
 */
export function readMetadata(data) {
  const ctx = exifContext(data); // TIFF + IFD0 parsed once, shared by exif + thumbnail
  return {
    exif: ctx ? exifTags(ctx) : null,
    thumbnail: ctx ? exifThumbnail(ctx, data) : null,
    jfifThumbnail: readJfifThumbnail(data),
    xmp: readXmp(data),
    iptc: readIptc(data),
  };
}
