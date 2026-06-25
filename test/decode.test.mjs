import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decode } from '../src/index.js';

const manifest = JSON.parse(
  readFileSync(new URL('./fixtures/manifest.json', import.meta.url), 'utf8'),
);

function compare(rgba, ref, width, height) {
  let sum = 0;
  let max = 0;
  const count = width * height;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(rgba[i * 4 + c] - ref[i * 3 + c]);
      sum += d;
      if (d > max) max = d;
    }
  }
  return { mean: sum / (count * 3), max };
}

for (const fx of manifest) {
  test(`decode ${fx.name} (${fx.desc})`, () => {
    const data = readFileSync(new URL(`./fixtures/${fx.file}`, import.meta.url));
    const ref = readFileSync(new URL(`./fixtures/${fx.ref}`, import.meta.url));

    const img = decode(data);
    assert.equal(img.width, fx.width, 'width');
    assert.equal(img.height, fx.height, 'height');

    const { mean, max } = compare(img.data, ref, fx.width, fx.height);
    assert.ok(
      mean <= fx.meanTol,
      `${fx.name}: mean abs error ${mean.toFixed(3)} > tolerance ${fx.meanTol}`,
    );
    assert.ok(
      max <= fx.maxTol,
      `${fx.name}: max abs error ${max} > tolerance ${fx.maxTol}`,
    );
  });
}
