// "Fancy" (bilinear) chroma upsampling — a clean-room centered-phase bilinear
// filter, the smooth alternative to the nearest-neighbour replication done while
// decoding. It runs as a post-pass on the already-decoded full-resolution plane:
// a subsampled component's native samples are preserved at the top-left of each
// hSub×vSub replication block (writeBlock guarantees plane[Y][X] = native[Y>>vShift][X>>hShift]),
// so we read that native grid back out and interpolate over it.
//
// The centered phase places native sample i at full-res coordinate i·sub +
// (sub−1)/2 (the centre of its block). For sub = 2 this reproduces libjpeg's
// "fancy upsampling" 3:1 weights exactly, so a subsampled decode lands much
// closer to the libjpeg reference than replication does.

/**
 * Bilinearly upsample one subsampled component plane in place.
 * @param {Int16Array} plane full-resolution plane (chroma replicated by decode)
 * @param {number} fullW image width
 * @param {number} fullH image height
 * @param {number} hSub horizontal subsampling factor (maxH / componentH), ≥ 1
 * @param {number} vSub vertical subsampling factor (maxV / componentV), ≥ 1
 * @returns {Int16Array} the same plane, upsampled
 */
export function fancyUpsample(plane, fullW, fullH, hSub, vSub) {
  if (hSub <= 1 && vSub <= 1) return plane;

  const nativeW = Math.ceil(fullW / hSub);
  const nativeH = Math.ceil(fullH / vSub);

  // Pull the native grid out of the replicated plane first, so the in-place
  // interpolation below never reads a sample it has already overwritten.
  const native = new Int16Array(nativeW * nativeH);
  for (let ny = 0; ny < nativeH; ny++) {
    const sy = Math.min(ny * vSub, fullH - 1);
    for (let nx = 0; nx < nativeW; nx++) {
      native[ny * nativeW + nx] = plane[sy * fullW + Math.min(nx * hSub, fullW - 1)];
    }
  }

  const hHalf = (hSub - 1) / 2;
  const vHalf = (vSub - 1) / 2;
  for (let y = 0; y < fullH; y++) {
    const fy = (y - vHalf) / vSub;
    let y0 = Math.floor(fy);
    let wy = fy - y0;
    if (y0 < 0) { y0 = 0; wy = 0; } // clamp above the first native centre
    else if (y0 >= nativeH - 1) { y0 = nativeH - 1; wy = 0; } // and below the last
    const y1 = y0 + 1 < nativeH ? y0 + 1 : y0;
    const row0 = y0 * nativeW;
    const row1 = y1 * nativeW;

    for (let x = 0; x < fullW; x++) {
      const fx = (x - hHalf) / hSub;
      let x0 = Math.floor(fx);
      let wx = fx - x0;
      if (x0 < 0) { x0 = 0; wx = 0; }
      else if (x0 >= nativeW - 1) { x0 = nativeW - 1; wx = 0; }
      const x1 = x0 + 1 < nativeW ? x0 + 1 : x0;

      const a = native[row0 + x0];
      const b = native[row0 + x1];
      const c = native[row1 + x0];
      const d = native[row1 + x1];
      const top = a + (b - a) * wx;
      const bot = c + (d - c) * wx;
      plane[y * fullW + x] = Math.round(top + (bot - top) * wy);
    }
  }
  return plane;
}
