// Small numeric helpers. Port of JpegMathHelper.cs.
//
// Note on rounding: the C# code uses MathF.Round / Math.Round with the default
// MidpointRounding.ToEven (banker's rounding). JS Math.round rounds halves toward
// +Infinity, which would diverge by 1 on exact .5 midpoints, so we implement
// round-half-to-even explicitly to stay faithful to the reference output.

/** Round to nearest integer, halves to even (matches C# MathF.Round). */
export function roundToInt32(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // exactly .5 -> round to even
  return (floor & 1) === 0 ? floor : floor + 1;
}

export const roundToInt16 = roundToInt32;

/** Clamp value into [min, max]. */
export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Floor(log2(value)); by convention log2(0) === 0. Matches BitOperations.Log2. */
export function log2(value) {
  value = value >>> 0;
  if (value === 0) return 0;
  return 31 - Math.clz32(value);
}
