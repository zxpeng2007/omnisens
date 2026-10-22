// JS side of the shared engine and config format (the C side is checked
// against the same vectors in firmware/test).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_SIZE, GAIN_ONE, GAIN_MIN, GAIN_MAX, FLAG_ENABLED, FLAG_LINEAR, FLAG_CHORD_TOGGLE,
  defaultConfig, sanitizeConfig, packConfig, unpackConfig, gainAt, gainsToQ12, configGains, Engine, vecAngle,
} from '../js/omni-core.js';

test('pack/unpack round-trips and uses the documented byte layout', () => {
  const cfg = sanitizeConfig({
    flags: FLAG_ENABLED | FLAG_LINEAR, nPoints: 12, smoothingCounts: 77, resetMs: 123,
    rotationCdeg: -321, calibDpi: 1600, gainsQ12: Array.from({ length: 12 }, (_, i) => 3500 + 100 * i), label: 'my profile',
  });
  const b = packConfig(cfg);
  assert.equal(b.length, CONFIG_SIZE);
  assert.deepEqual([b[0], b[1], b[2], b[3]], [1, FLAG_ENABLED | FLAG_LINEAR, 12, 0]);
  assert.deepEqual([b[4], b[5]], [77, 0]);
  assert.deepEqual([b[8], b[9]], [(-321) & 0xff, ((-321) >> 8) & 0xff]);
  assert.deepEqual([b[12], b[13]], [3500 & 0xff, 3500 >> 8]);
  assert.equal(String.fromCharCode(...b.slice(44, 54)), 'my profile');
  assert.deepEqual(unpackConfig(b), cfg);
  const bad = Uint8Array.from(b);
  bad[0] = 99;
  assert.equal(unpackConfig(bad), null);
});

test('defaults are a transparent 8-point profile', () => {
  const d = defaultConfig();
  assert.equal(d.flags, FLAG_ENABLED | FLAG_CHORD_TOGGLE);
  assert.equal(d.nPoints, 8);
  assert.deepEqual(configGains(d), new Array(8).fill(1));
  const e = new Engine(d);
  for (let i = 0; i < 200; i++) assert.deepEqual(e.process((i % 7) - 3, (i % 5) - 2, i * 1000), [(i % 7) - 3, (i % 5) - 2]);
});

test('sanitize clamps like the firmware and never lets NaN through', () => {
  const c = sanitizeConfig({ nPoints: 40, flags: 0xff, resetMs: 0, rotationCdeg: 9000, gainsQ12: [1, 65535, NaN, null, 'x'] });
  assert.equal(c.nPoints, 16);
  assert.equal(c.flags, 7);
  assert.equal(c.resetMs, 40);
  assert.equal(c.rotationCdeg, 4500);
  assert.deepEqual(c.gainsQ12.slice(0, 5), [GAIN_MIN, GAIN_MAX, GAIN_ONE, GAIN_ONE, GAIN_ONE]);
  assert.equal(sanitizeConfig({ smoothingCounts: undefined }).smoothingCounts, 32);
  assert.deepEqual(gainsToQ12([1, NaN, 0.01, 100]), [GAIN_ONE, GAIN_ONE, GAIN_MIN, GAIN_MAX]);
  const unused = sanitizeConfig({ nPoints: 4, gainsQ12: [4096, 4096, 4096, 4096, 1234] });
  assert.equal(unused.gainsQ12[4], GAIN_ONE);
});

test('interpolation hits the knots, stays in range and wraps around', () => {
  const g = [1, 1, 1.95, 1, 1, 0.49, 1, 1];
  for (let k = 0; k < 8; k++) {
    assert.ok(Math.abs(gainAt(g, k * 45) - g[k]) < 1e-12);
    assert.ok(Math.abs(gainAt(g, k * 45 + 360) - g[k]) < 1e-12);
    assert.ok(Math.abs(gainAt(g, k * 45 - 720) - g[k]) < 1e-12);
  }
  for (let a = 0; a < 360; a += 0.5) {
    const v = gainAt(g, a);
    assert.ok(v >= 0.49 - 1e-12 && v <= 1.95 + 1e-12, `cubic overshoot ${v} at ${a}`);
    const l = gainAt(g, a, true);
    assert.ok(l >= 0.49 && l <= 1.95);
  }
  assert.equal(gainAt([1.2], 123), 1.2);
});

test('engine: totals follow the gain with 1-count reports, and rotation is CCW', () => {
  const e = new Engine(sanitizeConfig({ nPoints: 2, flags: FLAG_ENABLED | FLAG_LINEAR, gainsQ12: [6144, 2048] }));
  let sx = 0;
  for (let i = 0; i < 1000; i++) sx += e.process(1, 0, i * 1000)[0];
  assert.ok(Math.abs(sx - 1500) <= 1);
  sx = 0;
  for (let i = 0; i < 1000; i++) sx += e.process(-1, 0, 2e6 + i * 1000)[0];
  assert.ok(Math.abs(sx + 500) <= 1);
  const r = new Engine(sanitizeConfig({ rotationCdeg: 4500 }));
  assert.deepEqual(r.process(100, 0, 1000), [71, -71]);
  assert.equal(vecAngle(1, 0), 0);
  assert.equal(vecAngle(0, -1), 90);
  assert.equal(vecAngle(-1, 0), 180);
  assert.equal(vecAngle(0, 1), 270);
});

test('a disabled engine is an exact passthrough', () => {
  const e = new Engine(sanitizeConfig({ flags: 0, gainsQ12: new Array(8).fill(8000) }));
  assert.deepEqual(e.process(37, -5, 1000), [37, -5]);
});
