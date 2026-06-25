// 8x8 DCT used by the codec.
//
// Inverse DCT (decode): a faithful port of the integer IDCT from stb_image
// (`stbi__idct_block`) by Sean Barrett — released into the **public domain**
// (http://nothings.org/stb). This replaces the previous Apache-2.0 transform so
// JsPeg is single-license MIT. The math is identical to stb's (same fixed-point
// constants); the only adaptation is that we emit the centred spatial sample
// (without stb's +128 level shift / 0..255 clamp) so the existing pipeline's
// shiftDataLevel handles the level shift, exactly like the original library.
//
// Forward DCT (encode): an original, exact separable DCT-II (just the textbook
// cosine transform) — no third-party code. It produces standard JPEG-scaled
// coefficients (DC = 8 × mean), the inverse of stb's IDCT.
//
// Blocks are Float32Array(64) in natural (row-major) order.

// stb's fixed-point helpers: f2f rounds toward zero like the C `(int)` cast.
const f2f = (x) => Math.trunc(x * 4096 + 0.5);

const C_0_541196 = f2f(0.541196100);
const C_n1_847759 = f2f(-1.847759065);
const C_0_765367 = f2f(0.765366865);
const C_1_175876 = f2f(1.175875602);
const C_0_298631 = f2f(0.298631336);
const C_2_053120 = f2f(2.053119869);
const C_3_072711 = f2f(3.072711026);
const C_1_501321 = f2f(1.501321110);
const C_n0_899976 = f2f(-0.899976223);
const C_n2_562915 = f2f(-2.562915447);
const C_n1_961571 = f2f(-1.961570560);
const C_n0_390181 = f2f(-0.390180644);

// floor arithmetic shift (overflow-safe vs JS 32-bit `>>` for large products).
const sh10 = (x) => Math.floor(x / 1024);
const sh17 = (x) => Math.floor(x / 131072);

// Output of one 1-D IDCT: [x0, x1, x2, x3, t0, t1, t2, t3] (stb's STBI__IDCT_1D).
const O = new Float64Array(8);
function idct1d(s0, s1, s2, s3, s4, s5, s6, s7) {
  let p2 = s2;
  let p3 = s6;
  let p1 = (p2 + p3) * C_0_541196;
  let t2 = p1 + p3 * C_n1_847759;
  let t3 = p1 + p2 * C_0_765367;
  p2 = s0;
  p3 = s4;
  let t0 = (p2 + p3) * 4096; // fsh
  let t1 = (p2 - p3) * 4096;
  const x0 = t0 + t3;
  const x3 = t0 - t3;
  const x1 = t1 + t2;
  const x2 = t1 - t2;
  t0 = s7;
  t1 = s5;
  t2 = s3;
  t3 = s1;
  p3 = t0 + t2;
  let p4 = t1 + t3;
  p1 = t0 + t3;
  p2 = t1 + t2;
  const p5 = (p3 + p4) * C_1_175876;
  t0 = t0 * C_0_298631;
  t1 = t1 * C_2_053120;
  t2 = t2 * C_3_072711;
  t3 = t3 * C_1_501321;
  p1 = p5 + p1 * C_n0_899976;
  p2 = p5 + p2 * C_n2_562915;
  p3 = p3 * C_n1_961571;
  p4 = p4 * C_n0_390181;
  t3 += p1 + p4;
  t2 += p2 + p3;
  t1 += p2 + p4;
  t0 += p1 + p3;
  O[0] = x0; O[1] = x1; O[2] = x2; O[3] = x3;
  O[4] = t0; O[5] = t1; O[6] = t2; O[7] = t3;
}

// Intermediate column results (needs more than Float32 precision).
const VAL = new Float64Array(64);

/**
 * Inverse DCT of `src` (dequantized coefficients, natural order) into `dest`
 * (centred spatial samples).
 */
export function transformIDCT(src, dest) {
  // pass 1: columns
  for (let i = 0; i < 8; i++) {
    const d0 = src[i], d1 = src[8 + i], d2 = src[16 + i], d3 = src[24 + i];
    const d4 = src[32 + i], d5 = src[40 + i], d6 = src[48 + i], d7 = src[56 + i];

    if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0 && d5 === 0 && d6 === 0 && d7 === 0) {
      // DC-only shortcut (keeps 2 extra bits of precision, like stb).
      const dc = d0 * 4;
      VAL[i] = VAL[8 + i] = VAL[16 + i] = VAL[24 + i] = VAL[32 + i] = VAL[40 + i] = VAL[48 + i] = VAL[56 + i] = dc;
      continue;
    }

    idct1d(d0, d1, d2, d3, d4, d5, d6, d7);
    const x0 = O[0] + 512, x1 = O[1] + 512, x2 = O[2] + 512, x3 = O[3] + 512;
    const t0 = O[4], t1 = O[5], t2 = O[6], t3 = O[7];
    VAL[i] = sh10(x0 + t3);
    VAL[56 + i] = sh10(x0 - t3);
    VAL[8 + i] = sh10(x1 + t2);
    VAL[48 + i] = sh10(x1 - t2);
    VAL[16 + i] = sh10(x2 + t1);
    VAL[40 + i] = sh10(x2 - t1);
    VAL[24 + i] = sh10(x3 + t0);
    VAL[32 + i] = sh10(x3 - t0);
  }

  // pass 2: rows. Emit centred samples (no +128, no clamp; 65536 = 0.5<<17 rounding).
  for (let i = 0; i < 8; i++) {
    const o = i * 8;
    idct1d(VAL[o], VAL[o + 1], VAL[o + 2], VAL[o + 3], VAL[o + 4], VAL[o + 5], VAL[o + 6], VAL[o + 7]);
    const x0 = O[0], x1 = O[1], x2 = O[2], x3 = O[3];
    const t0 = O[4], t1 = O[5], t2 = O[6], t3 = O[7];
    dest[o] = sh17(x0 + t3 + 65536);
    dest[o + 7] = sh17(x0 - t3 + 65536);
    dest[o + 1] = sh17(x1 + t2 + 65536);
    dest[o + 6] = sh17(x1 - t2 + 65536);
    dest[o + 2] = sh17(x2 + t1 + 65536);
    dest[o + 5] = sh17(x2 - t1 + 65536);
    dest[o + 3] = sh17(x3 + t0 + 65536);
    dest[o + 4] = sh17(x3 - t0 + 65536);
  }
}

// ---- Forward DCT (exact separable DCT-II) ---------------------------------

// COS[u*8 + x] = cos((2x+1)·u·π/16)
const COS = new Float64Array(64);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) {
    COS[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}
const ROW = new Float64Array(64);
const SQRT1_2 = Math.SQRT1_2;

// SCALE[v*8+u] = 1/4 · C(u) · C(v), where C(0) = 1/√2 and C(k) = 1 otherwise.
const SCALE = new Float64Array(64);
for (let v = 0; v < 8; v++) {
  const cv = v === 0 ? SQRT1_2 : 1;
  for (let u = 0; u < 8; u++) {
    SCALE[v * 8 + u] = 0.25 * (u === 0 ? SQRT1_2 : 1) * cv;
  }
}

/**
 * Forward DCT of `src` (centred spatial samples) into `dest` (coefficients,
 * natural order), using the standard JPEG scaling (DC = 8 × mean).
 */
export function transformFDCT(src, dest) {
  // rows: ROW[y*8 + u] = Σ_x src[y*8+x] · cos((2x+1)uπ/16)
  for (let y = 0; y < 8; y++) {
    const yo = y * 8;
    for (let u = 0; u < 8; u++) {
      const uo = u * 8;
      let s = 0;
      for (let x = 0; x < 8; x++) s += src[yo + x] * COS[uo + x];
      ROW[yo + u] = s;
    }
  }
  // cols: dest[v*8+u] = SCALE[v*8+u] · Σ_y ROW[y*8+u] · cos((2y+1)vπ/16)
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      const vo = v * 8;
      let s = 0;
      for (let y = 0; y < 8; y++) s += ROW[y * 8 + u] * COS[vo + y];
      dest[v * 8 + u] = SCALE[v * 8 + u] * s;
    }
  }
}
