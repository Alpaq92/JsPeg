// Procedural sample images, shared by the demo (the "try a sample" chips) and
// the round-trip tests. Each generator returns an RGBA Uint8Array of length
// w*h*4. They are cheap to compute, cover a range of content (smooth gradients,
// a full hue sweep, hard colour edges, a flat field, a photographic-style
// scene), and none of them look like noise.

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const lerp = (a, b, t) => a + (b - a) * t;

// Smooth 0..1 ramp as x moves from edge0 to edge1 (either direction).
function smoothstep(edge0, edge1, x) {
  let t = (x - edge0) / (edge1 - edge0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// HSV (h,s,v in 0..1) -> [r,g,b] in 0..255.
function hsv(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r;
  let g;
  let b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [r * 255, g * 255, b * 255];
}

function fill(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = fn(x, y);
      data[i] = clamp(c[0]);
      data[i + 1] = clamp(c[1]);
      data[i + 2] = clamp(c[2]);
      data[i + 3] = 255;
    }
  }
  return data;
}

/** A small stylized landscape: sky + soft sun & glow, hills, a feathered river. */
export function makeScene(w, h) {
  const sunX = w * 0.72;
  const sunY = h * 0.26;
  const horizon = 0.62;
  return fill(w, h, (x, y) => {
    const u = x / Math.max(w - 1, 1);
    const v = y / Math.max(h - 1, 1);
    let r;
    let g;
    let b;
    if (v < horizon) {
      const t = v / horizon;
      r = lerp(60, 205, t); g = lerp(110, 225, t); b = lerp(190, 235, t);
      const dist = Math.hypot(x - sunX, y - sunY);
      const glow = Math.max(0, 1 - dist / (0.5 * h));
      r += glow * glow * 185; g += glow * glow * 150; b += glow * glow * 45;
      const core = 1 - smoothstep(0.06 * h, 0.11 * h, dist);
      r = lerp(r, 255, core); g = lerp(g, 244, core); b = lerp(b, 188, core);
    } else {
      const t = (v - horizon) / (1 - horizon);
      const hill = 0.5 + 0.5 * Math.sin(u * Math.PI * 3 + 1);
      r = lerp(70, 140, t) - hill * 20;
      g = lerp(125, 95, t) + (1 - hill) * 40;
      b = lerp(60, 52, t);
      const river = Math.abs(u - (0.5 + 0.18 * Math.sin(v * 8)));
      const riverMix = 1 - smoothstep(0.025, 0.05, river);
      r = lerp(r, lerp(90, 150, t), riverMix);
      g = lerp(g, lerp(150, 185, t), riverMix);
      b = lerp(b, lerp(205, 230, t), riverMix);
    }
    const tex = Math.sin(x * 0.18) * Math.cos(y * 0.13) * 6;
    return [r + tex, g + tex, b + tex];
  });
}

/** A clean grayscale gradient (dark -> light) with gentle texture. */
export function makeGrayscale(w, h) {
  return fill(w, h, (x, y) => {
    const base = (x / Math.max(w - 1, 1)) * 255;
    const vert = 1 - 0.22 * (y / Math.max(h - 1, 1));
    const g = base * vert + Math.sin(x * 0.3) * 4 + Math.cos(y * 0.25) * 4;
    return [g, g, g];
  });
}

/** A full hue sweep across x, brightness fading downward. */
export function makeRainbow(w, h) {
  return fill(w, h, (x, y) => hsv(
    x / Math.max(w - 1, 1),
    0.92,
    lerp(1, 0.5, y / Math.max(h - 1, 1)),
  ));
}

/** SMPTE-style vertical colour bars (hard edges). */
export function makeColorBars(w, h) {
  const bars = [
    [235, 235, 235], [235, 235, 16], [16, 235, 235], [16, 235, 16],
    [235, 16, 235], [235, 16, 16], [16, 16, 235], [16, 16, 16],
  ];
  return fill(w, h, (x) => bars[Math.min(7, Math.floor((x / w) * 8))]);
}

/** A flat colour field (exercises DC-only blocks). Default: pure green. */
export function makeSolid(w, h, color = [0, 200, 0]) {
  return fill(w, h, () => color);
}

/** The samples offered in the demo and exercised by the tests. */
export const SAMPLES = [
  { name: 'Landscape', gray: false, make: makeScene },
  { name: 'Grayscale', gray: true, make: makeGrayscale },
  { name: 'Rainbow', gray: false, make: makeRainbow },
  { name: 'Colour bars', gray: false, make: makeColorBars },
  { name: 'Pure green', gray: false, make: (w, h) => makeSolid(w, h, [0, 200, 0]) },
];
