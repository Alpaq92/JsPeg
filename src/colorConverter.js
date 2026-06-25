// Color conversion from decoded component planes to RGB(A). This is a convenience
// layer on top of the codec (the reference library itself only emits raw
// component samples). Conversion is chosen from component count + the optional
// Adobe APP14 transform, matching common decoder behaviour (libjpeg / pdf.js).
import { JpegMarker } from './JpegMarker.js';
import { findAppSegment } from './markerScan.js';

/**
 * Scan a JPEG byte stream for the Adobe APP14 color transform.
 * @returns {number|null} 0 (none/RGB/CMYK), 1 (YCbCr), 2 (YCCK), or null if absent
 */
export function readAdobeTransform(data) {
  // APP14 "Adobe", then version(2) flags0(2) flags1(2) transform(1).
  const seg = findAppSegment(data, JpegMarker.App14, [0x41, 0x64, 0x6f, 0x62, 0x65]);
  if (seg === null || seg.start + 6 >= seg.end) return null;
  return data[seg.start + 6];
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/**
 * Convert interleaved pixels to YCbCr component planes (full resolution).
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Uint8ClampedArray|number[]} data interleaved samples
 * @param {number} channels 3 (RGB) or 4 (RGBA)
 * @returns {{ y: Uint8ClampedArray, cb: Uint8ClampedArray, cr: Uint8ClampedArray }}
 */
export function rgbToYCbCrPlanes(width, height, data, channels) {
  const count = width * height;
  const y = new Uint8ClampedArray(count);
  const cb = new Uint8ClampedArray(count);
  const cr = new Uint8ClampedArray(count);
  for (let i = 0, p = 0; i < count; i++, p += channels) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  return { y, cb, cr };
}

/** Convert interleaved pixels to a single grayscale plane (full resolution). */
export function rgbToGrayPlane(width, height, data, channels) {
  const count = width * height;
  const g = new Uint8ClampedArray(count);
  for (let i = 0, p = 0; i < count; i++, p += channels) {
    g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return g;
}

/** A minimal JFIF APP0 segment (FFE0 ... ), for compatibility with strict readers. */
export function buildJfifApp0() {
  return Uint8Array.of(
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // version 1.1
    0x00, // units: none
    0x00, 0x01, 0x00, 0x01, // X/Y density 1
    0x00, 0x00, // no thumbnail
  );
}

/**
 * Convert decoded component planes to an interleaved RGBA buffer.
 * @param {object} params
 * @param {number} params.width
 * @param {number} params.height
 * @param {Int16Array[]} params.components full-resolution sample planes
 * @param {number[]} params.componentIds frame component identifiers
 * @param {number|null} params.adobeTransform
 * @returns {Uint8ClampedArray} RGBA, length width*height*4
 */
export function componentsToRGBA({ width, height, components, componentIds, adobeTransform }) {
  const n = components.length;
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);

  if (n === 1) {
    const g = components[0];
    for (let i = 0, j = 0; i < count; i++, j += 4) {
      const v = g[i];
      out[j] = v; out[j + 1] = v; out[j + 2] = v; out[j + 3] = 255;
    }
    return out;
  }

  if (n === 3) {
    // RGB if Adobe transform is 0, or component ids are R,G,B; otherwise YCbCr.
    const isRgb = adobeTransform === 0
      || (componentIds && componentIds[0] === 0x52 && componentIds[1] === 0x47 && componentIds[2] === 0x42);
    const c0 = components[0], c1 = components[1], c2 = components[2];
    if (isRgb) {
      for (let i = 0, j = 0; i < count; i++, j += 4) {
        out[j] = c0[i]; out[j + 1] = c1[i]; out[j + 2] = c2[i]; out[j + 3] = 255;
      }
    } else {
      for (let i = 0, j = 0; i < count; i++, j += 4) {
        const Y = c0[i];
        const Cb = c1[i] - 128;
        const Cr = c2[i] - 128;
        out[j] = clampByte(Y + 1.402 * Cr);
        out[j + 1] = clampByte(Y - 0.344136 * Cb - 0.714136 * Cr);
        out[j + 2] = clampByte(Y + 1.772 * Cb);
        out[j + 3] = 255;
      }
    }
    return out;
  }

  if (n === 4) {
    // CMYK or YCCK. Adobe stores CMYK inverted.
    const c0 = components[0], c1 = components[1], c2 = components[2], c3 = components[3];
    const isYcck = adobeTransform === 2;
    for (let i = 0, j = 0; i < count; i++, j += 4) {
      let c, m, y;
      const k = c3[i];
      if (isYcck) {
        const Y = c0[i];
        const Cb = c1[i] - 128;
        const Cr = c2[i] - 128;
        c = 255 - clampByte(Y + 1.402 * Cr);
        m = 255 - clampByte(Y - 0.344136 * Cb - 0.714136 * Cr);
        y = 255 - clampByte(Y + 1.772 * Cb);
      } else {
        c = c0[i]; m = c1[i]; y = c2[i];
      }
      // Adobe APP14 marks inverted CMYK; combine with K (also inverted).
      if (adobeTransform != null) {
        out[j] = clampByte((c * k) / 255);
        out[j + 1] = clampByte((m * k) / 255);
        out[j + 2] = clampByte((y * k) / 255);
      } else {
        out[j] = clampByte(255 - Math.min(255, c + (255 - k)));
        out[j + 1] = clampByte(255 - Math.min(255, m + (255 - k)));
        out[j + 2] = clampByte(255 - Math.min(255, y + (255 - k)));
      }
      out[j + 3] = 255;
    }
    return out;
  }

  throw new Error(`Unsupported component count: ${n}`);
}
