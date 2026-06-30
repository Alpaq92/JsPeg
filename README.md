# JsPeg

A **pure-JavaScript JPEG decoder, encoder & optimizer** — no native modules, no
WebAssembly, and **zero dependencies**. Runs anywhere, in both Node and the browser.

What started as a faithful port of the C# library
**[yigolden/JpegLibrary](https://github.com/yigolden/JpegLibrary)** (MIT) grew into
a comprehensive JPEG toolset — part borrowed DNA, part our own invention. The borrowed
strands come from **[stb_image](https://github.com/nothings/stb)** (public-domain
inverse DCT), **[exifr](https://github.com/MikeKovarik/exifr)** (EXIF orientation), the
**ITU-T T.81** specification (a clean-room arithmetic coder), and
**[Loren Merritt's x264 trellis notes](http://akuvian.org/src/x264/trellis.txt)**
(rate-distortion trellis quantization). The rest — [roughly a quarter of the
code](docs/ARCHITECTURE.md#code-provenance) — is ours: the tightening and verification,
the extra `optimize()` modes, the metadata, ICC and chroma-upsampling utilities, and the
entire test suite. Every code- and spec-donor was chosen so JsPeg stays
**single-license MIT** — see [the Notes](#notes).

The project icon (`assets/icon.svg`, `assets/icon.png`) is a
[Tabler](https://tabler.io/icons) photo glyph (MIT) recoloured in
[Open Color](https://yeun.github.io/open-color/) **Yellow** — the same palette
that fills the [provenance chart](docs/ARCHITECTURE.md#code-provenance).

### ▶ [Live demo](https://alpaq92.github.io/JsPeg/)

Drop a JPEG to decode it, re-encode it at any quality, and **compare every optimize
mode side by side** — Huffman, progressive, arithmetic (SOF9/SOF10) and trellis —
with the exact byte size and percentage each one saves. Everything runs locally, on
your own device.

## What it does

- **Decode** baseline, extended-sequential, progressive, lossless, and
  **arithmetic-coded** (SOF9/10) JPEG, at **8 or 12-bit** precision; 4:4:4 / 4:2:2 /
  4:2:0 chroma subsampling; grayscale / YCbCr / RGB / CMYK; and reads **EXIF**
  (tags + thumbnail), **XMP**, **IPTC** and **ICC** metadata.
- **Encode** straight from raw RGBA pixels — baseline JPEG (with standard or optimized
  Huffman tables), **progressive** or **arithmetic** (SOF2 / SOF9 / SOF10), **12-bit DCT**
  (SOF1), or truly **lossless** (SOF3 — 7 spatial predictors, 8–16-bit precision, an exact
  bit-for-bit round-trip).
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

// encode RGBA -> progressive (or arithmetic) JPEG, straight from pixels
const prog = encode({ width, height, data, channels: 4 }, { quality: 85, progressive: true });

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

Tests cover decode against frozen libjpeg conformance vectors (including both the
SOF9 and SOF10 **arithmetic** vectors), dependency-free encode→decode round-trips
over a broad set of sample images (baseline, **12-bit DCT**, **and exact lossless
SOF3** across all 7 predictors), CMYK/YCCK, EXIF-orientation and **EXIF / XMP /
IPTC + thumbnail** metadata handling, and codec unit tests.
The optimizer is checked across all of its lossless modes — Huffman re-coding,
baseline→**progressive**, and baseline→**arithmetic** (SOF9) transcodes, each one
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
- **[ITU-T T.81](https://www.w3.org/Graphics/JPEG/itu-t81.pdf)** (the JPEG standard)
  — the **arithmetic encoder** (QM-coder, Annex D) and the **lossless encoder**
  (predictors + residual coding, Annex H), both written clean-room from the spec
  because no MIT implementation exists. A specification is free to implement.
- **[Loren Merritt's x264 trellis notes](http://akuvian.org/src/x264/trellis.txt)**
  — the **trellis** rate-distortion algorithm, re-implemented from the described
  method (algorithms/ideas aren't copyrightable, only their expression).

BSD/IJG/Apache/GPL implementations (mozjpeg, libjpeg-turbo, libjpeg.NET, …) were
deliberately **not** ported — doing so would add a second license, breaking the
single-license guarantee.

**Codec details.** Subsampled chroma is upsampled with a **fancy (bilinear)**
filter by default — a centered-phase interpolation matching libjpeg's, so a
subsampled decode lands within a couple of levels of the libjpeg reference (pass
`{ fancyUpsampling: false }` for plain nearest-neighbour replication). CMYK and
YCCK (Adobe APP14) 4-component images decode to RGB, and EXIF
orientation is read from the APP1 segment and applied by `decode()` (pass
`applyOrientation: false` to opt out). **Arithmetic coding** is fully supported by
the clean-room QM-coder: SOF9 + SOF10 decode is validated against conformance
vectors, and both `encode()` (from pixels) and `optimize()` (transcoding) *emit*
arithmetic — SOF9, or SOF10 with `progressive` (our output round-trips through
libjpeg-turbo). Progressive (SOF2) is likewise available straight from `encode()`. **Lossless (SOF3)**
is supported both ways — `encode({ lossless: true })` (predictors 1–7, **2–16-bit
precision**) and decode, cross-checked against an independent lossless decoder
(including a 12-bit round-trip). **12-bit DCT** decodes (extended-sequential /
progressive) **and encodes** (`encode({ precision: 12 })` → SOF1, grayscale) — both
cross-checked against libjpeg-turbo. Rich **metadata** is read on decode — **EXIF**
tags + the embedded thumbnail, **XMP** and **IPTC** via `decodeComponents().metadata`
(or the standalone `readMetadata()`), plus **ICC** profiles via `.icc` — and ICC can
be embedded on encode (`encode(image, { icc })`). A **height-via-DNL** frame
(`numberOfLines = 0`, with the real height deferred to a `DNL` marker) resolves its
height automatically, and a **JFIF APP0** thumbnail is read when present. The
differential / hierarchical frame types (SOF5–7 / SOF13–15) are out of scope:
they exist only inside hierarchical mode (T.81 Annex J), which even libjpeg never
implemented — so there is no reference decoder to verify an implementation against.

## License

MIT — see [LICENSE](LICENSE). Ported from
[yigolden/JpegLibrary](https://github.com/yigolden/JpegLibrary); the inverse DCT
is from [stb_image](https://github.com/nothings/stb) (public domain) and the EXIF
orientation reader is adapted from [exifr](https://github.com/MikeKovarik/exifr)
(MIT).
