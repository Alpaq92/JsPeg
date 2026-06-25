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
  a.href = URL.createObjectURL(new Blob([jpg], { type: 'image/jpeg' }));
  a.hidden = false;
}

function doOptimize() {
  if (!currentJpegBytes) return;
  try {
    const t0 = performance.now();
    const out = optimize(currentJpegBytes);
    const ms = performance.now() - t0;

    // prove losslessness in the browser
    const a = decode(currentJpegBytes).data;
    const b = decode(out).data;
    let identical = a.length === b.length;
    for (let i = 0; identical && i < a.length; i++) identical = a[i] === b[i];

    const saved = (1 - out.length / currentJpegBytes.length) * 100;
    renderMeta($('optimizeMeta'), [
      ['Original', fmtBytes(currentJpegBytes.length)],
      ['Optimized', fmtBytes(out.length)],
      ['Saved', `${saved.toFixed(1)}%`, saved > 0 ? 'good' : ''],
      ['Pixels identical', identical ? 'yes ✓' : 'NO', identical ? 'good' : 'error'],
      ['Took', `${ms.toFixed(1)} ms`],
    ]);
    const dl = $('optimizeDownload');
    dl.href = URL.createObjectURL(new Blob([out], { type: 'image/jpeg' }));
    dl.hidden = false;
  } catch (err) {
    setStatus(`Optimize failed: ${err.message}`, true);
  }
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

// build the "try a sample" chips
for (const sample of SAMPLES) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.textContent = sample.name;
  btn.addEventListener('click', () => loadSample(sample));
  $('samples').append(btn);
}
