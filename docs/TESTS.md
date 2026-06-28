# Tests

The suite is **pure JavaScript** — `node --test`, no Python, native tooling, or
network. Committed fixtures let the tests run anywhere Node does.

```sh
npm test
```

92 tests across six files.

## Test files (`test/`)

| File | Covers |
|---|---|
| `decode.test.mjs` | Decode vs. frozen **libjpeg conformance vectors** — compares RGBA against a reference decode within per-fixture tolerances. Includes the SOF9 / SOF10 **arithmetic** and a **12-bit** (SOF1) vector. |
| `roundtrip.test.mjs` | Dependency-free **encode → decode** round-trips over procedural sample images (`demo/samples.js`); **native progressive / arithmetic** encode (SOF2/9/10) from pixels (pixel-identical to baseline, ICC preserved); **exact lossless (SOF3)** round-trips for all 7 predictors and **12-bit** precision (which also exercise the otherwise-unfixtured lossless decoder); and **ICC profile** embed/read round-trips. |
| `optimize.test.mjs` | Optimizer **losslessness** across Huffman / progressive (successive approximation) / arithmetic (SOF9) / arithmetic-progressive (SOF10) transcodes, the **lossy trellis** mode, **idempotence**, and clear errors on non-baseline input. |
| `cmyk.test.mjs` | CMYK / YCCK (Adobe APP14) 4-component decode to RGB. |
| `orientation.test.mjs` | All 8 **EXIF orientations** vs. the reference transform. |
| `unit.test.mjs` | Codec units — zig-zag, math helpers, table parsing, etc. |

## Fixtures (`test/fixtures/`)

Each `*.jpg` is a frozen JPEG; each `*.ref` is the matching **raw RGB** decode
(`width × height × 3` bytes) from the same reference codec; `manifest.json` lists
dimensions and the comparison tolerances.

- Generated once with **libjpeg (via Python Pillow)** so the decoder is validated
  against a fully independent implementation — including cases no pure-JS encoder
  here can produce. The generator is intentionally **not** in the repo; running the
  suite needs only Node.
- `arith_seq.jpg` is libjpeg-turbo's canonical `testimages/testimgari.jpg`
  (SOF9 + DAC), redistributed under its permissive IJG/BSD licenses — the only way
  to obtain an arithmetic vector (Pillow and imagecodecs can't *encode* arithmetic).
- `.gitattributes` marks `*.jpg` / `*.ref` **binary**, so line-ending conversion
  never corrupts them.

## Tolerance philosophy

Decode comparisons use a **strict mean** and a **loose max** absolute error — the
mean is the correctness signal, the max absorbs the occasional ringing spike at a
sharp edge. Because JsPeg now upsamples subsampled chroma with the same **fancy
(bilinear)** filter as libjpeg, even the 4:2:0 / 4:2:2 vectors decode to within a
few levels of the reference, so their tolerances are tight (mean ≤ 1.5, max ≤ 10).
The encoder is validated separately and dependency-free by the in-memory round-trips.

See [ARCHITECTURE.md](ARCHITECTURE.md) for what each pipeline does, and
`test/fixtures/README.md` for the fixture list.
