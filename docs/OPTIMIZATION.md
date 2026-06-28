# Optimization

`optimize()` re-encodes an existing JPEG to make it smaller. By default it is
**lossless** — a pure *entropy transcode* that re-codes the existing DCT
coefficients (better Huffman tables, or a progressive / arithmetic layout) and
never touches the image data (no inverse DCT, no requantization). The opt-in
`{ trellis }` mode is the one **lossy** exception — it re-quantizes for extra size
at a small, bounded quality cost.

```js
import { optimize, decode } from './src/index.js';

const smaller = optimize(jpegBytes);                          // optimal Huffman + strip metadata
const max     = optimize(jpegBytes, { mostOptimalCoding: true }); // package-merge (slower, smallest codes)
const keep    = optimize(jpegBytes, { strip: false });        // preserve APPn / COM segments
const prog    = optimize(jpegBytes, { progressive: true });   // baseline -> progressive (renders incrementally)
const ari     = optimize(jpegBytes, { arithmetic: true });    // baseline -> arithmetic SOF9 (smaller; not browser-viewable)
const ap      = optimize(jpegBytes, { arithmetic: true, progressive: true }); // -> arithmetic progressive SOF10 (smallest)
const lossy   = optimize(jpegBytes, { trellis: true });       // lossy: R-D thresholding (smaller, slight quality cost)
```

## Supported techniques

| Technique | Status | Lossless | Notes |
|---|---|---|---|
| Optimized Huffman tables | ✅ supported | yes | always — tables rebuilt from the image's own symbol counts |
| Most-optimal code lengths (package-merge) | ✅ supported | yes | opt-in `{ mostOptimalCoding: true }`; else the standard Annex-K build |
| Metadata stripping | ✅ supported | yes | on by default; `{ strip: false }` keeps APPn / COM |
| Progressive transcode | ✅ supported | yes | `{ progressive: true }`; renders incrementally; spectral selection **+ successive approximation** |
| ↳ successive approximation | ✅ supported | yes | the bit-plane refinement (DC + AC); makes progressive meaningfully **smaller** than baseline-optimal at real image sizes (tiny images pay scan-header overhead) |
| Arithmetic coding (SOF9) | ✅ supported | yes | `{ arithmetic: true }`; ~20–40% smaller, but ⚠️ **browsers can't display arithmetic JPEGs** (storage/interop only) |
| ↳ + progressive (SOF10) | ✅ supported | yes | `{ arithmetic: true, progressive: true }`; arithmetic **and** successive approximation — the smallest lossless transcode |
| Trellis quantization (R-D thresholding) | ✅ supported | **no (lossy)** | `{ trellis: true, lambda }`; zeros AC coefficients by rate-distortion to merge zero-runs; smaller at a small, bounded quality cost |

The progressive output is per-component, non-interleaved scans using 1-bit
successive approximation — for each component a DC-first and AC-first scan (both
point-transformed), then an AC-refinement and DC-refinement scan — each with its
own optimal Huffman table. The AC refinement uses the EOBn + correction-bit scheme
(T.81 G.1.2.3), the exact dual of our progressive decoder. The arithmetic output
is a SOF9 stream — or, with `progressive`, a SOF10 stream that combines the QM-coder
with successive approximation — from a clean-room encoder. All are verified lossless
against our decoder **and** libjpeg-turbo (which decodes our arithmetic output
identically). Trellis
re-quantizes losslessly-extracted coefficients by a *provably optimal*
(brute-force-verified) dynamic program — for each block it picks the subset of AC
coefficients to keep that minimizes `distortion + λ·rate` — then re-encodes
baseline; the result is a valid JPEG (verified against our decoder and libjpeg)
at a bounded quality cost (e.g. PSNR ≳ 50 dB at the default λ).

## Options

| Option | Default | Effect |
|---|---|---|
| `strip` | `true` | Drop non-essential metadata segments (APPn, COM). |
| `mostOptimalCoding` | `false` | Use the package-merge algorithm for provably optimal length-limited Huffman codes (slower) instead of the standard build. |
| `progressive` | `false` | Transcode to a progressive JPEG (renders incrementally; 1-bit successive approximation, so smaller than baseline-optimal on real-size images). Lossless; baseline input only. |
| `arithmetic` | `false` | Transcode to an arithmetic-coded JPEG — SOF9, or **SOF10** when combined with `progressive` — smaller, but **not displayable in browsers**. Lossless; baseline input only. |
| `trellis` | `false` | **Lossy.** Rate-distortion AC thresholding, then re-encode baseline. Smaller at a small quality cost; baseline input only. |
| `lambda` | `3` | Trellis R-D constant — higher is smaller/lossier. The size gain also grows with the source's quality. |

## JPEG frame types (SOFn)

What JsPeg does with each Start-of-Frame type, end to end (✅ supported · ◐ partial
· ✖ out of scope):

| Marker | Frame type | Decode | Encode / `optimize()` | Notes |
|---|---|---|---|---|
| **SOF0** | Baseline DCT (Huffman) | ✅ | ✅ all modes | the common case; the only accepted optimizer **input** |
| **SOF1** | Extended sequential DCT (Huffman) | ✅ | ✅ (as baseline) | 8-bit; handled like baseline |
| **SOF2** | Progressive DCT (Huffman) | ✅ | ✅ as **output** of `{ progressive }` | multi-scan, incremental |
| **SOF3** | Lossless (sequential) | ✅ verified | ✅ `encode({ lossless })` | predictors 1–7, **2–16-bit** (incl. 12-bit); cross-checked against an independent SOF3 decoder |
| **SOF5–7** | Differential sequential / progressive / lossless | ✖ | ✖ | rare; upstream lacks them too |
| **SOF9** | Extended sequential DCT, **arithmetic** | ✅ verified | ✅ as **output** of `{ arithmetic }` | clean-room QM-coder |
| **SOF10** | Progressive DCT, **arithmetic** | ✅ verified | ✅ as **output** of `{ arithmetic, progressive }` | QM-coder + successive approximation; our output round-trips through libjpeg-turbo |
| **SOF11** | Lossless, arithmetic | ✖ | ✖ | |
| **SOF13–15** | Differential …, arithmetic | ✖ | ✖ | |

(SOF4 = DHT, SOF8 = reserved, SOF12 = reserved — not frame types.) The optimizer
**input** must be SOF0/SOF1 (baseline Huffman); other inputs are rejected with a
clear error. Trellis is lossy; all other `optimize()` modes are lossless.
