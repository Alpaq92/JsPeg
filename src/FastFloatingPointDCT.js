// Fast, slightly inaccurate floating-point forward/inverse DCT.
// Port of FastFloatingPointDCT.cs (itself from SixLabors.ImageSharp / norishigefukushima).
//
// The reference packs each 8-wide row into two SIMD `Vector4`s (left/right) and
// runs the 8-point transform down 4 columns at a time. The arithmetic is purely
// column-wise, so here it is flattened to a Float32Array(64): `idct8Columns`
// reproduces the LeftPart (cols 0..3) and RightPart (cols 4..7) in one loop.
//
// Blocks are Float32Array(64) in natural (row-major) order.

const C_1_175876 = 1.175875602;
const C_1_961571 = -1.961570560;
const C_0_390181 = -0.390180644;
const C_0_899976 = -0.899976223;
const C_2_562915 = -2.562915447;
const C_0_298631 = 0.298631336;
const C_2_053120 = 2.053119869;
const C_3_072711 = 3.072711026;
const C_1_501321 = 1.501321110;
const C_0_541196 = 0.541196100;
const C_1_847759 = -1.847759065;
const C_0_765367 = 0.765366865;
const C_0_125 = 0.125;

/** d = transpose(s). Both Float32Array(64). */
function transpose(s, d) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      d[c * 8 + r] = s[r * 8 + c];
    }
  }
}

function multiplyInplace(block, value) {
  for (let i = 0; i < 64; i++) block[i] *= value;
}

function addToAllInplace(block, value) {
  for (let i = 0; i < 64; i++) block[i] += value;
}

/** Inverse 8-point DCT down each of the 8 columns of `s` into `d`. */
function idct8Columns(s, d) {
  for (let c = 0; c < 8; c++) {
    const my1 = s[8 + c];
    const my7 = s[56 + c];
    let mz0 = my1 + my7;

    const my3 = s[24 + c];
    let mz2 = my3 + my7;
    const my5 = s[40 + c];
    let mz1 = my3 + my5;
    let mz3 = my1 + my5;

    let mz4 = (mz0 + mz1) * C_1_175876;

    mz2 = mz2 * C_1_961571 + mz4;
    mz3 = mz3 * C_0_390181 + mz4;
    mz0 = mz0 * C_0_899976;
    mz1 = mz1 * C_2_562915;

    const mb3 = my7 * C_0_298631 + mz0 + mz2;
    const mb2 = my5 * C_2_053120 + mz1 + mz3;
    const mb1 = my3 * C_3_072711 + mz1 + mz2;
    const mb0 = my1 * C_1_501321 + mz0 + mz3;

    const my2 = s[16 + c];
    const my6 = s[48 + c];
    mz4 = (my2 + my6) * C_0_541196;
    const my0 = s[c];
    const my4 = s[32 + c];
    mz0 = my0 + my4;
    mz1 = my0 - my4;

    mz2 = mz4 + my6 * C_1_847759;
    mz3 = mz4 + my2 * C_0_765367;

    const a0 = mz0 + mz3;
    const a3 = mz0 - mz3;
    const a1 = mz1 + mz2;
    const a2 = mz1 - mz2;

    d[c] = a0 + mb0;
    d[56 + c] = a0 - mb0;
    d[8 + c] = a1 + mb1;
    d[48 + c] = a1 - mb1;
    d[16 + c] = a2 + mb2;
    d[40 + c] = a2 - mb2;
    d[24 + c] = a3 + mb3;
    d[32 + c] = a3 - mb3;
  }
}

/** Forward 8-point DCT down each of the 8 columns of `s` into `d`. */
function fdct8Columns(s, d) {
  for (let c = 0; c < 8; c++) {
    let c0 = s[c];
    let c1 = s[56 + c];
    const t0 = c0 + c1;
    const t7 = c0 - c1;

    c1 = s[48 + c];
    c0 = s[8 + c];
    const t1 = c0 + c1;
    const t6 = c0 - c1;

    c1 = s[40 + c];
    c0 = s[16 + c];
    const t2 = c0 + c1;
    const t5 = c0 - c1;

    c0 = s[24 + c];
    c1 = s[32 + c];
    const t3 = c0 + c1;
    const t4 = c0 - c1;

    c0 = t0 + t3;
    let c3 = t0 - t3;
    c1 = t1 + t2;
    let c2 = t1 - t2;

    d[c] = c0 + c1;
    d[32 + c] = c0 - c1;

    let w0 = 0.541196;
    let w1 = 1.306563;
    d[16 + c] = w0 * c2 + w1 * c3;
    d[48 + c] = w0 * c3 - w1 * c2;

    w0 = 1.175876;
    w1 = 0.785695;
    c3 = w0 * t4 + w1 * t7;
    c0 = w0 * t7 - w1 * t4;

    w0 = 1.387040;
    w1 = 0.275899;
    c2 = w0 * t5 + w1 * t6;
    c1 = w0 * t6 - w1 * t5;

    d[24 + c] = c0 - c2;
    d[40 + c] = c3 - c1;

    const invsqrt2 = 0.707107;
    c0 = (c0 + c2) * invsqrt2;
    c3 = (c3 + c1) * invsqrt2;

    d[8 + c] = c0 + c3;
    d[56 + c] = c0 - c3;
  }
}

/**
 * Apply the inverse DCT of `src` into `dest`, using caller-provided `temp`.
 * All three are Float32Array(64).
 */
export function transformIDCT(src, dest, temp) {
  transpose(src, temp);
  idct8Columns(temp, dest);
  transpose(dest, temp);
  idct8Columns(temp, dest);
  multiplyInplace(dest, C_0_125);
}

/**
 * Apply the forward DCT of `src` into `dest`, using caller-provided `temp`.
 * When `offsetSourceByNeg128` is true a constant -128 is applied before the
 * transform (level shift for 8-bit samples).
 */
export function transformFDCT(src, dest, temp, offsetSourceByNeg128 = false) {
  transpose(src, temp);
  if (offsetSourceByNeg128) {
    addToAllInplace(temp, -128);
  }
  fdct8Columns(temp, dest);
  transpose(dest, temp);
  fdct8Columns(temp, dest);
  multiplyInplace(dest, C_0_125);
}

export const FastFloatingPointDCT = { transformIDCT, transformFDCT };
