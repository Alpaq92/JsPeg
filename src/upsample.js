// "Fancy" (bilinear) chroma upsampling — a clean-room centered-phase bilinear
// filter, the smooth alternative to the nearest-neighbour replication done while
// decoding. It reads straight from the already-decoded full-resolution plane: a
// subsampled component's native samples are preserved at the top-left of each
// hSub×vSub replication block (writeBlock guarantees plane[Y][X] = native[Y>>vShift][X>>hShift]),
// so native sample (i,j) is just plane[i·vSub][j·hSub].
//
// The centered phase places native sample i at full-res coordinate i·sub +
// (sub−1)/2 (the centre of its block). For sub = 2 this reproduces libjpeg's
// "fancy upsampling" 3:1 weights exactly, so a subsampled decode lands much
// closer to the libjpeg reference than replication does.

// Centered-bilinear tap for one output coordinate: the two native indices to
// blend and the weight of the second. Native sample i sits at i·sub + (sub−1)/2.
function tap(p, sub, half, n) {
  const f = (p - half) / sub;
  let i0 = Math.floor(f);
  let w = f - i0;
  if (i0 < 0) { i0 = 0; w = 0; } // clamp before the first native centre
  else if (i0 >= n - 1) { i0 = n - 1; w = 0; } // and after the last
  return { i0, i1: Math.min(i0 + 1, n - 1), w };
}

/**
 * Bilinearly upsample one subsampled component plane.
 * @param {Int16Array} plane full-resolution plane (chroma replicated by decode)
 * @param {number} fullW image width
 * @param {number} fullH image height
 * @param {number} hSub horizontal subsampling factor (maxH / componentH), ≥ 1
 * @param {number} vSub vertical subsampling factor (maxV / componentV), ≥ 1
 * @returns {Int16Array} a fresh upsampled plane
 */
export function fancyUpsample(plane, fullW, fullH, hSub, vSub) {
  const nativeW = Math.ceil(fullW / hSub);
  const nativeH = Math.ceil(fullH / vSub);

  // Horizontal taps are identical for every row, so resolve them once: each
  // output column maps to two source columns (native index · hSub = the
  // top-left of its replication block) and a blend weight.
  const hHalf = (hSub - 1) / 2;
  const sx0 = new Int32Array(fullW);
  const sx1 = new Int32Array(fullW);
  const wx = new Float64Array(fullW);
  for (let x = 0; x < fullW; x++) {
    const t = tap(x, hSub, hHalf, nativeW);
    sx0[x] = Math.min(t.i0 * hSub, fullW - 1);
    sx1[x] = Math.min(t.i1 * hSub, fullW - 1);
    wx[x] = t.w;
  }

  const vHalf = (vSub - 1) / 2;
  const out = new Int16Array(fullW * fullH);
  for (let y = 0; y < fullH; y++) {
    const ty = tap(y, vSub, vHalf, nativeH);
    const row0 = Math.min(ty.i0 * vSub, fullH - 1) * fullW; // the two source rows
    const row1 = Math.min(ty.i1 * vSub, fullH - 1) * fullW; // in the replicated plane
    const wy = ty.w;
    const dst = y * fullW;
    for (let x = 0; x < fullW; x++) {
      const a = plane[row0 + sx0[x]];
      const b = plane[row0 + sx1[x]];
      const c = plane[row1 + sx0[x]];
      const d = plane[row1 + sx1[x]];
      const top = a + (b - a) * wx[x];
      const bot = c + (d - c) * wx[x];
      out[dst + x] = Math.round(top + (bot - top) * wy);
    }
  }
  return out;
}
