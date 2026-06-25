// Dependency-free demo: synthesize an image, encode it, decode it back, and
// optimize an existing JPEG. Outputs are written as .ppm (P6) files, which most
// image viewers open directly.
//
//   node examples/demo.mjs
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encode, decode, optimize } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));

function writePPM(path, width, height, rgba) {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii');
  const body = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i++, j += 3) {
    body[j] = rgba[i * 4];
    body[j + 1] = rgba[i * 4 + 1];
    body[j + 2] = rgba[i * 4 + 2];
  }
  writeFileSync(path, Buffer.concat([header, body]));
}

// 1. Synthesize an RGBA gradient with a couple of solid blocks.
const W = 256;
const H = 192;
const rgba = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    rgba[i] = (x * 255 / W) | 0;
    rgba[i + 1] = (y * 255 / H) | 0;
    rgba[i + 2] = ((Math.sin(Math.hypot(x - W / 2, y - H / 2) / 10) * 0.5 + 0.5) * 255) | 0;
    rgba[i + 3] = 255;
  }
}

// 2. Encode at a couple of settings.
const big = encode({ width: W, height: H, data: rgba, channels: 4 }, { quality: 90, subsampling: '4:4:4' });
const small = encode({ width: W, height: H, data: rgba, channels: 4 }, { quality: 90, subsampling: '4:2:0', optimizeCoding: true });
writeFileSync(join(here, 'out-444.jpg'), big);
writeFileSync(join(here, 'out-420-opt.jpg'), small);
console.log(`encoded 4:4:4 q90       -> ${big.length} bytes`);
console.log(`encoded 4:2:0 q90 (opt) -> ${small.length} bytes`);

// 3. Decode one back and dump a PPM.
const decoded = decode(big);
writePPM(join(here, 'decoded.ppm'), decoded.width, decoded.height, decoded.data);
console.log(`decoded ${decoded.width}x${decoded.height}, estimated quality ~${decoded.quality?.toFixed(1)}`);

// 4. Optimize an existing baseline JPEG losslessly.
const opt = optimize(big);
const a = decode(big);
const b = decode(opt);
let identical = a.data.length === b.data.length;
for (let i = 0; identical && i < a.data.length; i++) identical = a.data[i] === b.data[i];
console.log(`optimized ${big.length} -> ${opt.length} bytes, pixels identical: ${identical}`);

// 5. Decode a committed fixture too, if present.
const fixture = join(here, '..', 'test', 'fixtures', 'rgb_444_q92.jpg');
if (existsSync(fixture)) {
  const f = decode(readFileSync(fixture));
  writePPM(join(here, 'fixture.ppm'), f.width, f.height, f.data);
  console.log(`decoded fixture ${f.width}x${f.height} -> examples/fixture.ppm`);
}
