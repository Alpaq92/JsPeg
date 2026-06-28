# Contributing to JsPeg

Thanks for your interest! JsPeg is a **pure-JavaScript, zero-dependency,
single-license MIT** JPEG decoder, encoder & optimizer — contributions should
keep it that way.

## Workflow

1. **Fork** the repository and create a branch off `main`.
2. Make your change, with tests.
3. Run `npm test` — everything must pass.
4. Open a **pull request** against `main`.

`main` is protected: a PR and the passing `test` status check are required before
a change can merge.

## Ground rules

- **Pure JS, zero dependencies.** No native modules, no WebAssembly, no runtime or
  `package.json` dependencies. The suite runs on `node --test` alone.
- **ESM** modules; match the style, naming, and comment density of the surrounding
  code.
- **Tests required.** New behaviour needs coverage; a bug fix needs a regression
  test. See [docs/TESTS.md](docs/TESTS.md). External tools (e.g. Pillow/libjpeg)
  may be used to *generate or cross-check* frozen fixtures, but never to run the
  suite.
- **Faithful-port conventions.** Most of the codebase mirrors
  [yigolden/JpegLibrary](https://github.com/yigolden/JpegLibrary); keep ports
  structurally close to their source and note provenance in a header comment.

## Licensing

- The project is **MIT** and aims to stay **single-license MIT**.
- By contributing, you agree your contribution is licensed under MIT.
- **Do not paste code derived from non-MIT / non-public-domain sources** (BSD, IJG,
  Apache, GPL, …) without raising it first — it would change the project's
  single-license terms. Re-implementing a *documented algorithm* in your own words
  is fine; copying the source verbatim is not. Cite the spec or source for any
  ported logic.

## Where things live

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the module map and the
decode / encode / optimize pipelines. Start there.
