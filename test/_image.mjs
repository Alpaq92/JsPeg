// Shared procedural test image: a small stylized landscape (sky + sun + glow,
// rolling hills, a winding river, gentle texture). It is cheap to generate yet
// has real low- and high-frequency content and varied colour — far better DCT
// exercise than flat gradients, and it doesn't look like noise. Used by the
// round-trip tests; the frozen decode fixtures are encoded from the same scene.

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const lerp = (a, b, t) => a + (b - a) * t;

// Smooth 0..1 ramp as x moves from edge0 to edge1 (either direction).
function smoothstep(edge0, edge1, x) {
  let t = (x - edge0) / (edge1 - edge0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/**
 * @param {number} w
 * @param {number} h
 * @returns {Uint8Array} RGBA, length w*h*4
 */
export function makeScene(w, h) {
  const data = new Uint8Array(w * h * 4);
  const sunX = w * 0.72;
  const sunY = h * 0.26;
  const horizon = 0.62;

  for (let y = 0; y < h; y++) {
    const v = y / Math.max(h - 1, 1);
    for (let x = 0; x < w; x++) {
      const u = x / Math.max(w - 1, 1);
      let r;
      let g;
      let b;

      if (v < horizon) {
        // sky: deep blue at the top fading to a pale horizon
        const t = v / horizon;
        r = lerp(60, 205, t);
        g = lerp(110, 225, t);
        b = lerp(190, 235, t);
        // warm sun glow + a softly-blended disc (no hard cutoff -> looks
        // natural and avoids extreme JPEG ringing at the edge)
        const dist = Math.hypot(x - sunX, y - sunY);
        const glow = Math.max(0, 1 - dist / (0.5 * h));
        r += glow * glow * 185;
        g += glow * glow * 150;
        b += glow * glow * 45;
        const core = 1 - smoothstep(0.06 * h, 0.11 * h, dist);
        r = lerp(r, 255, core);
        g = lerp(g, 244, core);
        b = lerp(b, 188, core);
      } else {
        // ground: layered greens with a sine-shaped hillside and a feathered river
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
      const i = (y * w + x) * 4;
      data[i] = clamp(r + tex);
      data[i + 1] = clamp(g + tex);
      data[i + 2] = clamp(b + tex);
      data[i + 3] = 255;
    }
  }
  return data;
}
