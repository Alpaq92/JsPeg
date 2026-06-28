# Test fixtures (frozen conformance vectors)

These `*.jpg` files are **frozen, independently-produced JPEG conformance
vectors**, and each `*.ref` is the matching raw RGB decode (`width*height*3`
bytes) produced by the same reference codec. `manifest.json` lists every fixture
with its dimensions and the comparison tolerances used by `decode.test.mjs`.

They were originally generated with **libjpeg** (via Python Pillow) so that
JsPeg's decoder is validated against a fully independent implementation —
including cases no pure-JS encoder can produce here (progressive scans, and
libjpeg's "fancy" bilinear chroma upsampling). The generator is intentionally
**not** part of this repository: the project and its test suite are pure
JavaScript and require no Python or native tooling to run (`npm test`).

The fixtures cover:

- grayscale baseline (q50/q90) and progressive (q88), plus an odd-sized image
- RGB 4:4:4 baseline (q75/q92) and progressive (q88), plus an odd-sized image
- RGB 4:2:0 and 4:2:2 baseline, and 4:2:0 progressive
- `arith_seq.jpg` — SOF9 **sequential arithmetic-coded**. This is libjpeg-turbo's
  canonical `testimages/testimgari.jpg`, redistributed under its permissive
  IJG/BSD licenses; its `.ref` was produced by the same libjpeg decoder via Pillow.
- `arith_prog.jpg` — SOF10 **progressive arithmetic-coded**, minted by JsPeg's own
  arithmetic encoder and **validated by libjpeg (Pillow), which decodes it
  identically**; its `.ref` is that libjpeg decode. It exists because no
  third-party SOF10 vector was available — the independent libjpeg agreement is
  what makes it a valid conformance test for the decoder.

Because these are frozen vectors, they should be treated as read-only. The
encoder is validated separately and dependency-free by the in-memory
encode→decode round-trip tests in `test/roundtrip.test.mjs`.
