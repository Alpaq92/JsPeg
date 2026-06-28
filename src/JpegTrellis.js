// Trellis quantization for baseline JPEG — rate-distortion optimal coefficient
// thresholding. **Lossy.** For each block it chooses which AC coefficients to
// keep vs zero so as to minimize J = distortion + lambda * rate, exploiting the
// fact that zeroing a coefficient can merge zero-runs and shorten the entropy
// code. This is the VLC / run-level case described in Loren Merritt's x264
// trellis notes (http://akuvian.org/src/x264/trellis.txt) and the R-D optimal
// thresholding method he cites (Wen/Luttrell/Villasenor, H.263+, 2000);
// re-implemented from those descriptions.
//
// Operating on an already-quantized JPEG, "distortion" is the squared
// dequantized magnitude lost when a coefficient is zeroed; keeping a coefficient
// adds no distortion (its value is unchanged) but costs entropy bits.

/** Bit-cost of every AC run/size symbol (0..255) from a standard Huffman table. */
export function buildAcCostTable(encodingTable) {
  const cost = new Uint16Array(256);
  for (let s = 0; s < 256; s++) {
    encodingTable.getCode(s);
    cost[s] = encodingTable.codeLength || 16; // undefined symbols: treat as costly
  }
  return cost;
}

/** Magnitude category (number of bits) of a positive integer. */
function sizeOf(magnitude) {
  return 32 - Math.clz32(magnitude);
}

/**
 * R-D threshold one block's AC band in place: zero the coefficients whose rate
 * outweighs their distortion. DC (index 0) is never touched.
 * @param {Int16Array} block          coefficient buffer (zig-zag order)
 * @param {number} blockOffset
 * @param {Uint16Array} quant         quantization steps (zig-zag order)
 * @param {Uint16Array} acCost        AC symbol bit-costs (from buildAcCostTable)
 * @param {number} lambda             rate-distortion constant (>= 0)
 */
export function trellisBlock(block, blockOffset, quant, acCost, lambda) {
  if (lambda <= 0) return;

  // Originally-nonzero AC coefficients (candidates to keep).
  const pos = [];
  const size = [];
  const energy = []; // squared dequantized magnitude lost if zeroed
  for (let k = 1; k < 64; k++) {
    const q = block[blockOffset + k];
    if (q !== 0) {
      const a = q < 0 ? -q : q;
      pos.push(k);
      size.push(sizeOf(a));
      const e = a * quant[k];
      energy.push(e * e);
    }
  }
  const m = pos.length;
  if (m === 0) return;

  const ZRL = acCost[0xf0];
  const EOB = acCost[0x00];
  const rate = (run, sz) => (run >> 4) * ZRL + acCost[((run & 15) << 4) | sz] + sz;

  // prefixE[i] = total energy of nonzeros 0..i-1.
  const prefixE = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) prefixE[i + 1] = prefixE[i] + energy[i];
  const totalE = prefixE[m];

  // dp[i] = min cost with nonzero i KEPT as the last-so-far; prev[i] backtracks.
  const dp = new Float64Array(m);
  const prev = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    // i is the first kept coefficient (run counts the leading zeros 1..pos[i]-1).
    let best = prefixE[i] + lambda * rate(pos[i] - 1, size[i]);
    let bp = -1;
    for (let j = 0; j < i; j++) {
      const skipped = prefixE[i] - prefixE[j + 1]; // zeroed nonzeros between j and i
      const c = dp[j] + skipped + lambda * rate(pos[i] - pos[j] - 1, size[i]);
      if (c < best) {
        best = c;
        bp = j;
      }
    }
    dp[i] = best;
    prev[i] = bp;
  }

  // Choose the last kept coefficient (or keep nothing), adding the EOB and the
  // distortion of zeroing everything after it.
  let bestTotal = totalE + lambda * EOB; // keep nothing: all AC zeroed
  let bestLast = -1;
  for (let i = 0; i < m; i++) {
    const afterE = totalE - prefixE[i + 1];
    const eob = pos[i] === 63 ? 0 : lambda * EOB;
    const total = dp[i] + afterE + eob;
    if (total < bestTotal) {
      bestTotal = total;
      bestLast = i;
    }
  }

  // Backtrack the kept set; zero everything else.
  const keep = new Uint8Array(m);
  for (let i = bestLast; i >= 0; i = prev[i]) keep[i] = 1;
  for (let i = 0; i < m; i++) {
    if (!keep[i]) block[blockOffset + pos[i]] = 0;
  }
}
