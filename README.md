# JsPeg

A **pure-JavaScript JPEG decoder, encoder & optimizer** — no native modules, no
WebAssembly, and **zero dependencies**. Runs anywhere, in both Node and the browser.

It is a faithful port of the C# library
**[yigolden/JpegLibrary](https://github.com/yigolden/JpegLibrary)** (MIT) with a
bit of **[stb_image](https://github.com/nothings/stb) DNA** — its inverse DCT is
ported from there (public domain) — so JsPeg stays single-license MIT.

### ▶ [Live demo](https://alpaq92.github.io/JsPeg/)

## What it does

- **Decode** baseline, extended-sequential, progressive, and lossless JPEG;
  4:4:4 / 4:2:2 / 4:2:0 subsampling; grayscale / YCbCr / RGB / CMYK; applies EXIF
  orientation.
- **Encode** baseline JPEG with standard or optimized Huffman tables.
- **Optimize** an existing JPEG — re-codes the Huffman tables losslessly
  (identical pixels, smaller file).

## Usage

```js
import { decode, encode, optimize } from './src/index.js';

// decode -> RGBA (canvas-ready)
const { width, height, data } = decode(jpegBytes);

// encode RGBA -> JPEG
const jpg = encode({ width, height, data, channels: 4 }, { quality: 85, subsampling: '4:2:0' });

// shrink an existing JPEG, pixels unchanged
const smaller = optimize(jpegBytes);
```

In the browser, decode straight onto a canvas:

```js
const { width, height, data } = decode(new Uint8Array(await (await fetch('photo.jpg')).arrayBuffer()));
canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
```

The full class API (`JpegDecoder`, `JpegEncoder`, `JpegOptimizer`, tables, custom
output writers, …) is exported from `src/index.js` too.

## Develop

```sh
npm test                 # pure-JS test suite (node --test), no external tooling
node tools/serve.mjs     # serve the demo at http://localhost:8080
```

Tests cover decode against frozen libjpeg conformance vectors, dependency-free
encode→decode round-trips over a set of sample images, CMYK/YCCK and
EXIF-orientation handling, codec unit tests, and optimizer losslessness.

## Notes

The inverse DCT is **[stb_image](https://github.com/nothings/stb) DNA** — ported
from there (public domain) — so the whole project is single-license MIT; it
tracks libjpeg's accurate IDCT closely. The forward DCT is an original exact
transform. Subsampled chroma is upsampled by replication, like the original.
CMYK and YCCK (Adobe APP14) 4-component images decode to RGB, and EXIF
orientation is read from the APP1 segment and applied by `decode()` (pass
`applyOrientation: false` to opt out). 12-bit precision and arithmetic coding
(SOF9/10) are out of scope.

## License

MIT — see [LICENSE](LICENSE). Ported from
[yigolden/JpegLibrary](https://github.com/yigolden/JpegLibrary); the inverse DCT
is from [stb_image](https://github.com/nothings/stb) (public domain) and the EXIF
orientation reader is adapted from [exifr](https://github.com/MikeKovarik/exifr)
(MIT).
