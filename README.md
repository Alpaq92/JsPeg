# JsPeg

A **pure-JavaScript JPEG decoder, encoder & optimizer** — no native modules, no
WebAssembly, and **zero dependencies**. Runs anywhere, in both Node and the browser.

What started as a faithful port of the C# library
**[yigolden/JpegLibrary](https://github.com/yigolden/JpegLibrary)** (MIT) grew into
a comprehensive JPEG toolset, imbued with DNA from
**[stb_image](https://github.com/nothings/stb)** (public-domain inverse DCT),
**[exifr](https://github.com/MikeKovarik/exifr)** (EXIF orientation), the
**ITU-T T.81** specification (a clean-room arithmetic coder), and
**[Loren Merritt's x264 trellis notes](http://akuvian.org/src/x264/trellis.txt)**
(rate-distortion trellis quantization). Every code- and spec-donor was chosen so
JsPeg stays **single-license MIT** — see [the Notes](#notes).

### ▶ [Live demo](https://alpaq92.github.io/JsPeg/)

## What it does

- **Decode** baseline, extended-sequential, progressive, lossless, and
  **arithmetic-coded** (SOF9/10) JPEG; 4:4:4 / 4:2:2 / 4:2:0 subsampling;
  grayscale / YCbCr / RGB / CMYK; applies EXIF orientation.
- **Encode** baseline JPEG (standard or optimized Huffman tables), or truly **lossless**
  (SOF3 — 7 spatial predictors, 8–16-bit precision, exact bit-for-bit round-trip).
- **Optimize** an existing JPEG — losslessly re-code its Huffman tables, or
  transcode to **progressive** (successive approximation: renders incrementally
  *and* smaller) or **arithmetic** (SOF9, or SOF10 with `progressive`); or
  **trellis**-quantize for extra savings (lossy). Lossless modes leave pixels unchanged.

## Usage

```js
import { decode, encode, optimize } from './src/index.js';

// decode -> RGBA (canvas-ready)
const { width, height, data } = decode(jpegBytes);

// encode RGBA -> JPEG
const jpg = encode({ width, height, data, channels: 4 }, { quality: 85, subsampling: '4:2:0' });

// encode RGBA -> lossless JPEG (SOF3, exact round-trip)
const exact = encode({ width, height, data, channels: 4 }, { lossless: true });

// shrink an existing JPEG, pixels unchanged
const smaller = optimize(jpegBytes);
```

In the browser, decode straight onto a canvas:

```js
const { width, height, data } = decode(new Uint8Array(await (await fetch('photo.jpg')).arrayBuffer()));
canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
```

The full class-level API (`JpegDecoder`, `JpegEncoder`, `JpegOptimizer`, tables,
custom output writers, …) is exported from `src/index.js` too, for building your
own pipelines.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules and the decode / encode /
  optimize pipelines.
- [docs/OPTIMIZATION.md](docs/OPTIMIZATION.md) — what `optimize()` supports (and
  what's planned), with options.
- [docs/TESTS.md](docs/TESTS.md) — test layout, how to run, and the conformance
  fixtures.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute (fork → PR), and the
  pure-JS / single-license-MIT ground rules.

## Develop

```sh
npm test                 # pure-JS test suite (node --test), no external tooling
node tools/serve.mjs     # serve the demo at http://localhost:8080
```

Tests cover decode against frozen libjpeg conformance vectors (including SOF9 and
SOF10 **arithmetic** vectors), dependency-free encode→decode round-trips over a set
of sample images (baseline **and exact lossless SOF3**, all 7 predictors), CMYK/YCCK
and EXIF-orientation handling, and codec unit tests.
The optimizer is checked across all its lossless modes — Huffman re-coding,
baseline→**progressive**, and baseline→**arithmetic** (SOF9) transcodes, each
pixel-identical — plus the lossy **trellis** mode (valid, smaller, high-PSNR),
idempotence, and clear errors on non-baseline input.

## Notes

**Provenance & licensing.** JsPeg is **single-license MIT**, and every donor was
chosen to keep it that way:

- **[yigolden/JpegLibrary](https://github.com/yigolden/JpegLibrary)** (MIT) — the
  bulk: every decoder (baseline, progressive, lossless, arithmetic), the baseline
  encoder, and the optimizer. MIT → MIT.
- **[stb_image](https://github.com/nothings/stb)** (public domain) — the inverse
  DCT in `dct.js` (it tracks libjpeg's accurate IDCT closely). Public domain → no
  obligation. The forward DCT is our own exact transform.
- **[exifr](https://github.com/MikeKovarik/exifr)** (MIT) — the EXIF-orientation
  reader in `exif.js`.
- **ITU-T T.81** (the JPEG standard) — the **arithmetic encoder** (QM-coder, Annex D)
  and the **lossless encoder** (predictors + residual coding, Annex H), both written
  clean-room from the spec because no MIT implementation exists. A specification is
  free to implement.
- **[Loren Merritt's x264 trellis notes](http://akuvian.org/src/x264/trellis.txt)**
  — the **trellis** rate-distortion algorithm, re-implemented from the described
  method (algorithms/ideas aren't copyrightable, only their expression).

BSD/IJG/Apache/GPL implementations (mozjpeg, libjpeg-turbo, libjpeg.NET, …) were
deliberately **not** ported — doing so would add a second license, breaking the
single-license guarantee.

**Codec details.** Subsampled chroma is upsampled by replication, like the
original. CMYK and YCCK (Adobe APP14) 4-component images decode to RGB, and EXIF
orientation is read from the APP1 segment and applied by `decode()` (pass
`applyOrientation: false` to opt out). **Arithmetic coding** is fully supported by
the clean-room QM-coder: SOF9 + SOF10 decode is validated against conformance
vectors, and `optimize()` can also *encode* arithmetic — SOF9, and SOF10 with
`progressive` (our output round-trips through libjpeg-turbo). **Lossless (SOF3)**
is supported both ways — `encode({ lossless: true })` (predictors 1–7, **2–16-bit
precision**) and decode, cross-checked against an independent lossless decoder
(including a 12-bit round-trip). 12-bit *DCT* decode is not yet supported. The
differential / hierarchical frame types (SOF5–7 / SOF13–15) are out of scope:
they exist only inside hierarchical mode (T.81 Annex J), which even libjpeg never
implemented — so there is no reference decoder to verify an implementation against.

## License

MIT — see [LICENSE](LICENSE). Ported from
[yigolden/JpegLibrary](https://github.com/yigolden/JpegLibrary); the inverse DCT
is from [stb_image](https://github.com/nothings/stb) (public domain) and the EXIF
orientation reader is adapted from [exifr](https://github.com/MikeKovarik/exifr)
(MIT).
