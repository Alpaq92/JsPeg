// JsPeg browser demo. Everything runs locally — no network, no dependencies.
import { decode, decodeComponents, encode, optimize } from '../src/index.js';
import { SAMPLES } from './samples.js';

const $ = (id) => document.getElementById(id);

const dropzone = $('drop');
const fileInput = $('file');
const statusEl = $('status');
const panels = $('panels');
const decodePanel = $('decodePanel');
const optimizePanel = $('optimizePanel');

let currentRGBA = null; // { width, height, data } source pixels for encoding
let currentJpegBytes = null; // original bytes, when the input is a JPEG

function setStatus(msg, isError = false) {
  statusEl.hidden = !msg;
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', isError);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Object URL for a JPEG byte array (caller revokes when done). */
const jpegBlobUrl = (bytes) => URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));

function renderMeta(dl, rows) {
  dl.innerHTML = '';
  for (const [k, v, cls] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    if (cls) dd.className = cls;
    dl.append(dt, dd);
  }
}

function paint(canvas, rgba, w, h) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
}

const isJpeg = (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;

async function handleFile(file) {
  setStatus(`Reading ${file.name}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());

    if (isJpeg(bytes)) {
      await showJpeg(bytes);
    } else {
      currentJpegBytes = null;
      optimizePanel.hidden = true;
      decodePanel.hidden = true;
      clearOptimize();
      await loadAsSource(file);
      setStatus(`Loaded ${file.name} (${currentRGBA.width}×${currentRGBA.height}). Encode it as JPEG below.`);
    }
    panels.hidden = false;
    autoEncode();
  } catch (err) {
    console.error(err);
    setStatus(`Could not process this file: ${err.message}`, true);
  }
}

async function loadSample(sample) {
  setStatus(`Generating the “${sample.name}” sample…`);
  try {
    const w = 384;
    const h = 256;
    const rgba = sample.make(w, h);
    const jpg = encode(
      { width: w, height: h, data: rgba, channels: 4 },
      { quality: 92, subsampling: sample.gray ? '4:4:4' : '4:2:0', grayscale: sample.gray },
    );
    await showJpeg(jpg);
    panels.hidden = false;
    autoEncode();
  } catch (err) {
    console.error(err);
    setStatus(`Could not generate sample: ${err.message}`, true);
  }
}

async function showJpeg(bytes) {
  currentJpegBytes = bytes;
  clearOptimize(); // a new image invalidates the previous comparison

  const t0 = performance.now();
  const meta = decodeComponents(bytes);
  const img = decode(bytes);
  const ms = performance.now() - t0;

  paint($('decodeCanvas'), img.data, img.width, img.height);
  decodePanel.hidden = false;
  const rows = [
    ['Dimensions', `${img.width} × ${img.height}`],
    ['Components', String(meta.numberOfComponents)],
    ['Mode', meta.progressive ? 'progressive' : 'baseline'],
    ['Precision', `${meta.precision}-bit`],
    ['Est. quality', meta.quality != null ? `~${meta.quality.toFixed(1)}` : 'n/a'],
    ['Decoded in', `${ms.toFixed(1)} ms`],
    ['File size', fmtBytes(bytes.length)],
  ];
  if (img.orientation !== 1) {
    rows.splice(1, 0, ['EXIF orientation', `${img.orientation} (applied)`]);
  }
  renderMeta($('decodeMeta'), rows);

  // the decoded pixels become the source for re-encoding
  currentRGBA = { width: img.width, height: img.height, data: img.data };
  optimizePanel.hidden = meta.progressive; // optimizer handles baseline only
  setStatus('');
}

async function loadAsSource(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  currentRGBA = { width: bitmap.width, height: bitmap.height, data };
}

function autoEncode() {
  if (currentRGBA) doEncode();
}

function doEncode() {
  if (!currentRGBA) return;
  const opts = {
    quality: Number($('quality').value),
    subsampling: $('subsampling').value,
    optimizeCoding: $('optimize').checked,
  };
  const t0 = performance.now();
  const jpg = encode({ width: currentRGBA.width, height: currentRGBA.height, data: currentRGBA.data, channels: 4 }, opts);
  const encMs = performance.now() - t0;

  // decode our own output to preview it
  const back = decode(jpg);
  paint($('encodeCanvas'), back.data, back.width, back.height);

  const rows = [
    ['Output size', fmtBytes(jpg.length)],
    ['Quality', String(opts.quality)],
    ['Subsampling', opts.subsampling],
    ['Huffman', opts.optimizeCoding ? 'optimized' : 'standard'],
    ['Encoded in', `${encMs.toFixed(1)} ms`],
  ];
  if (currentJpegBytes) {
    const delta = ((1 - jpg.length / currentJpegBytes.length) * 100);
    rows.push(['vs. original', `${delta >= 0 ? '−' : '+'}${Math.abs(delta).toFixed(1)}%`]);
  }
  renderMeta($('encodeMeta'), rows);

  const a = $('encodeDownload');
  a.href = jpegBlobUrl(jpg);
  a.hidden = false;
}

// Every optimize() mode, shown side by side. The arithmetic streams are valid
// JPEGs our own decoder can read (so we can prove they're lossless) even though
// native browsers can't display them.
const OPT_MODES = [
  { label: 'Optimized Huffman', file: 'jspeg-huffman.jpg', opts: {}, lossless: true, native: true },
  { label: 'Progressive', file: 'jspeg-progressive.jpg', opts: { progressive: true }, lossless: true, native: true },
  { label: 'Arithmetic (SOF9)', file: 'jspeg-arith.jpg', opts: { arithmetic: true }, lossless: true, native: false },
  { label: 'Arithmetic progressive (SOF10)', file: 'jspeg-arith-prog.jpg', opts: { arithmetic: true, progressive: true }, lossless: true, native: false },
  { label: 'Trellis (lossy)', file: 'jspeg-trellis.jpg', opts: { trellis: true }, lossless: false, native: true },
];

const DOWNLOAD_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v10"/><path d="M8 9l4 4 4-4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>';

const INFO_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12" y2="8"/></svg>';

let optUrls = []; // blob URLs from the last comparison, revoked before the next

// Drop the comparison table + its blob URLs (e.g. when a new image is loaded).
function clearOptimize() {
  optUrls.forEach(URL.revokeObjectURL);
  optUrls = [];
  $('optimizeResults').innerHTML = '';
}

function psnr(a, b) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) { // RGB only, skip alpha
      const d = a[i + c] - b[i + c];
      sum += d * d;
      n++;
    }
  }
  const mse = sum / n;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

// Run every optimize() mode and produce render-ready rows; renderOptTable just
// maps the fields to cells.
function doOptimize() {
  if (!currentJpegBytes) return;
  optUrls.forEach(URL.revokeObjectURL);
  optUrls = [];

  const origLen = currentJpegBytes.length;
  const ref = decode(currentJpegBytes).data;

  const results = OPT_MODES.map((m) => {
    try {
      const out = optimize(currentJpegBytes, m.opts);
      const back = decode(out).data;
      let qualityText;
      let qualityPre; // lossy row: text before the info glyph
      let qualityPost; // lossy row: text after the info glyph
      let qClass = '';
      let psnrInfo;
      if (m.lossless) {
        let identical = back.length === ref.length;
        for (let i = 0; identical && i < ref.length; i++) identical = ref[i] === back[i];
        qualityText = identical ? 'lossless ✓' : 'MISMATCH ✗';
        qClass = identical ? 'good' : 'error';
        if (!m.native) qualityText += ' · ⚠ not browser-native';
      } else {
        const p = psnr(ref, back);
        qualityPre = 'lossy ⚠ · ';
        qualityPost = `PSNR ${isFinite(p) ? p.toFixed(1) + ' dB' : '∞'}`;
        qClass = 'lossy';
        psnrInfo = 'PSNR = Peak Signal-to-Noise Ratio vs the original. Higher is closer; ≳50 dB is visually lossless, ∞ = bit-identical.';
      }
      const saved = (1 - out.length / origLen) * 100;
      const url = jpegBlobUrl(out);
      optUrls.push(url);
      return {
        ok: true,
        label: m.label,
        file: m.file,
        sizeText: fmtBytes(out.length),
        savedText: `${saved.toFixed(1)}%`, // positive = smaller than the original
        savedClass: saved >= 0 ? 'good' : 'warn',
        qualityText,
        qualityPre,
        qualityPost,
        qClass,
        psnrInfo,
        url,
      };
    } catch (err) {
      return { ok: false, label: m.label, error: err.message };
    }
  });

  renderOptTable(origLen, results);
}

function td(content, cls) {
  const el = document.createElement('td');
  if (content instanceof Node) el.appendChild(content);
  else el.textContent = content;
  if (cls) el.className = cls;
  return el;
}

function downloadCell(r) {
  const a = document.createElement('a');
  a.href = r.url;
  a.download = r.file;
  a.className = 'dl-icon';
  a.innerHTML = DOWNLOAD_SVG;
  a.title = `Download ${r.file}`;
  return td(a);
}

// A small ⓘ that reveals `tip` on hover (native title tooltip).
function infoGlyph(tip) {
  const span = document.createElement('span');
  span.className = 'info-glyph';
  span.innerHTML = INFO_SVG;
  const t = document.createElement('span');
  t.className = 'tip';
  t.textContent = tip;
  span.appendChild(t);
  return span;
}

// Quality cell — plain text, except the lossy row gets an info glyph between its
// two text parts (so the glyph position is structural, not parsed from a string).
function qualityCell(r) {
  if (!r.psnrInfo) return td(r.qualityText, r.qClass);
  const cell = td('', r.qClass);
  cell.append(r.qualityPre, infoGlyph(r.psnrInfo), r.qualityPost);
  return cell;
}

function renderOptTable(origLen, results) {
  const wrap = $('optimizeResults');
  wrap.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'opt-table';

  const header = document.createElement('tr');
  for (const h of ['Mode', 'Size', 'Saved', 'Quality', '']) {
    const th = document.createElement('th');
    th.textContent = h;
    header.appendChild(th);
  }
  table.appendChild(header);

  const orig = document.createElement('tr');
  orig.className = 'orig';
  orig.append(td('Original (baseline)'), td(fmtBytes(origLen)), td('—'), td('—'), td(''));
  table.appendChild(orig);

  for (const r of results) {
    const tr = document.createElement('tr');
    if (!r.ok) {
      const err = td(r.error, 'error');
      err.colSpan = 4;
      tr.append(td(r.label), err);
    } else {
      tr.append(
        td(r.label),
        td(r.sizeText),
        td(r.savedText, r.savedClass),
        qualityCell(r),
        downloadCell(r),
      );
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);
}

// ---- wire up events --------------------------------------------------------

$('pick').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  }));
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
  }));
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

$('quality').addEventListener('input', () => { $('qVal').textContent = $('quality').value; });
$('encodeBtn').addEventListener('click', doEncode);
$('optimizeBtn').addEventListener('click', doOptimize);

// The icon itself, served as a real JsPeg-encoded JPG — decoding it here dogfoods
// the decoder (and shows it round-tripping the encoder's own output).
async function loadIconJpeg() {
  setStatus('Loading the icon.jpg sample…');
  try {
    const bytes = new Uint8Array(await (await fetch('assets/icon.jpg')).arrayBuffer());
    await showJpeg(bytes);
    panels.hidden = false;
    autoEncode();
  } catch (err) {
    console.error(err);
    setStatus(`Could not load the icon sample: ${err.message}`, true);
  }
}

// build the "try a sample" chips (procedural samples, plus the icon JPG)
function addChip(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  $('samples').append(btn);
}
for (const sample of SAMPLES) addChip(sample.name, () => loadSample(sample));
addChip('Icon', loadIconJpeg);
