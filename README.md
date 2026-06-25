# JsPeg

A **pure-JavaScript JPEG decoder, encoder & optimizer** — no native modules, no
WebAssembly, **zero dependencies**. Runs in Node and the browser.

It is a faithful port of the C# library
**[yigolden/JpegLibrary](https://github.com/yigolden/JpegLibrary)** (MIT).

### ▶ [Live demo](https://alpaq92.github.io/JsPeg/)

Drop in any image to decode, re-encode, or losslessly optimize it — everything
runs locally in your browser, nothing is uploaded.

## What it does

- **Decode** baseline, extended-sequential, progressive, and lossless JPEG;
  4:4:4 / 4:2:2 / 4:2:0 subsampling; grayscale / YCbCr / RGB / CMYK.
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

The full class API (`JpegDecoder`, `JpegEncoder`, `JpegOptimizer`, tables, custom
output writers, …) is exported from `src/index.js` too.

## Develop

```sh
npm test                 # pure-JS test suite (node --test), no external tooling
node tools/serve.mjs     # serve the demo at http://localhost:8080
```

Tests cover decode against frozen libjpeg conformance vectors, dependency-free
encode→decode round-trips, codec unit tests, and optimizer losslessness.

## Notes

The DCT is the reference's fast floating-point transform (matches libjpeg to ±1
on virtually all pixels); subsampled chroma is upsampled by replication like the
original. Arithmetic-coded JPEG (SOF9/10) is not yet ported.

## License

MIT — see [LICENSE](LICENSE). Ported from
[yigolden/JpegLibrary](https://github.com/yigolden/JpegLibrary); the DCT is
derived from SixLabors.ImageSharp (Apache-2.0).
