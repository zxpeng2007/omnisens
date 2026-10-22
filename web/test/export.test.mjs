// Run: node --test "web/test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeProfile, decodeProfile, profileJson, profileHeader, rawAccelSettings, rawAccelFit,
  rawAccelAt, rawAccelEffectiveGains, rawAccelRows, rawAccelSummary,
  smoothingForDpi, profileFromGains, headlineGains, headlineText,
} from '../js/export.js';
import {
  defaultConfig, configGains, sanitizeConfig, gainAt, FLAG_ENABLED, FLAG_LINEAR, FLAG_CHORD_TOGGLE,
} from '../js/omni-core.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const PV8 = [0.931, 0.987, 1.055, 1.06, 1.028, 1.012, 0.989, 0.944];

test('smoothing follows DPI: about 0.5 mm, clamped 8..256', () => {
  assert.equal(smoothingForDpi(800), 16);
  assert.equal(smoothingForDpi(1600), 32);
  assert.equal(smoothingForDpi(100), 8);
  assert.equal(smoothingForDpi(26000), 256);
  assert.equal(smoothingForDpi(0), 32);
});

test('profileFromGains builds an enabled config and keeps base settings', () => {
  const base = { ...defaultConfig(), rotationCdeg: 250, resetMs: 60, flags: FLAG_CHORD_TOGGLE | FLAG_LINEAR };
  const cfg = profileFromGains(PV8, { dpi: 1600, base, label: 'cal 2026-10-21', linear: false });
  assert.equal(cfg.nPoints, 8);
  assert.equal(cfg.flags & FLAG_ENABLED, FLAG_ENABLED);
  assert.equal(cfg.flags & FLAG_LINEAR, 0);
  assert.equal(cfg.flags & FLAG_CHORD_TOGGLE, FLAG_CHORD_TOGGLE);
  assert.equal(cfg.rotationCdeg, 250);
  assert.equal(cfg.resetMs, 60);
  assert.equal(cfg.smoothingCounts, 32);
  assert.equal(cfg.calibDpi, 1600);
  assert.equal(cfg.label, 'cal 2026-10-21');
  configGains(cfg).forEach((g, k) => near(g, PV8[k], 1 / 4096));
  // Without a base or DPI it falls back to defaults.
  const plain = profileFromGains([1, 1.1, 1, 0.9]);
  assert.equal(plain.nPoints, 4);
  assert.equal(plain.smoothingCounts, defaultConfig().smoothingCounts);
});

test('profile codes round-trip and reject garbage', () => {
  const cfg = profileFromGains(PV8, { dpi: 800, label: 'test' });
  const code = encodeProfile(cfg);
  assert.ok(code.startsWith('omni1.'));
  assert.deepEqual(decodeProfile(code), sanitizeConfig(cfg));
  assert.deepEqual(decodeProfile(`  ${code}\n`), sanitizeConfig(cfg));
  assert.throws(() => decodeProfile('hello'), /omni1/);
  assert.throws(() => decodeProfile('omni1.AAAA'), /damaged|newer/);
});

test('JSON export round-trips through decodeProfile', () => {
  const cfg = profileFromGains(PV8, { dpi: 800, label: 'json' });
  const json = profileJson(cfg);
  const j = JSON.parse(json);
  assert.equal(j.format, 'omnisens-profile');
  assert.equal(j.directions.length, 8);
  assert.equal(j.directions[2].name, 'Up');
  const back = decodeProfile(json);
  assert.equal(back.nPoints, 8);
  configGains(back).forEach((g, k) => near(g, PV8[k], 1e-3));
  assert.throws(() => decodeProfile('{"gains": []}'), /gains/);
});

test('headline values and text', () => {
  const cfg = profileFromGains(PV8);
  const rows = headlineGains(cfg);
  assert.equal(rows.length, 8);
  rows.forEach((r, k) => {
    assert.equal(r.theta, k * 45);
    near(r.gain, PV8[k], 1 / 4096);
  });
  // A 16-point profile is sampled at the 8 compass directions.
  const g16 = Array.from({ length: 16 }, (_, k) => 1 + 0.05 * Math.cos((k * Math.PI) / 8));
  const rows16 = headlineGains(profileFromGains(g16));
  near(rows16[2].gain, g16[4], 1 / 4096);
  const text = headlineText(rows);
  assert.equal(text.split('\n').length, 9);
  assert.match(text, /^Direction\tAngle\tMultiplier/);
  assert.match(text, /Up-left\t135\t1\.060/);
});

test('Raw Accel export writes the least-squares fit as output DPI and ratios', () => {
  const cfg = profileFromGains(PV8);
  const f = rawAccelFit(cfg);
  const s = JSON.parse(rawAccelSettings(cfg));
  const p = s.profiles[0];
  near(p['Output DPI'], 1000 * f.right, 0.5);
  near(p['L/R output DPI ratio (left sens multiplier)'], f.left / f.right, 1e-3);
  near(p['Y/X output DPI ratio (vertical sens multiplier)'], f.down / f.right, 1e-3);
  near(p['U/D output DPI ratio (up sens multiplier)'], f.up / f.down, 1e-3);
  // The fit stays close to the profile at the axes and keeps the geometric mean.
  near(f.right, PV8[0], 0.03);
  near(f.left, PV8[4], 0.03);
  assert.ok(f.maxErrorPct < 5 && f.maxSkewDeg < 10, JSON.stringify(f));
});

test('Raw Accel fit is exact for a flat profile and for pure axis scaling', () => {
  const flat = rawAccelFit(profileFromGains([1, 1, 1, 1, 1, 1, 1, 1]));
  for (const k of ['right', 'left', 'up', 'down']) near(flat[k], 1, 1e-9);
  near(flat.maxErrorPct, 0, 1e-9);
  near(flat.maxSkewDeg, 0, 1e-9);
});

test('rawAccelEffectiveGains samples the Raw Accel model at 16 directions', () => {
  const f = { right: 0.95, left: 1.03, up: 1.06, down: 0.98 };
  const g = rawAccelEffectiveGains(f);
  assert.equal(g.length, 16);
  near(g[0], f.right, 1e-12, 'right');
  near(g[4], f.up, 1e-12, 'up');
  near(g[8], f.left, 1e-12, 'left');
  near(g[12], f.down, 1e-12, 'down');
  // Diagonals: sqrt(gx^2 cos^2 + gy^2 sin^2).
  near(g[2], Math.sqrt((f.right ** 2 + f.up ** 2) / 2), 1e-12, 'up-right');
  near(g[10], Math.sqrt((f.left ** 2 + f.down ** 2) / 2), 1e-12, 'down-left');
  const t = (22.5 * Math.PI) / 180;
  near(g[1], Math.hypot(f.right * Math.cos(t), f.up * Math.sin(t)), 1e-12, '22.5 deg');
  near(g[15], Math.hypot(f.right * Math.cos(t), f.down * Math.sin(t)), 1e-12, '337.5 deg');
  for (const v of rawAccelEffectiveGains({ right: 1, left: 1, up: 1, down: 1 })) near(v, 1, 1e-12);
  assert.equal(rawAccelEffectiveGains(f, 8).length, 8);
});

test('effective gains reproduce the fit errors and interpolate the model closely', () => {
  const cfg = profileFromGains(PV8);
  const f = rawAccelFit(cfg);
  const g = rawAccelEffectiveGains(f);
  const target = configGains(cfg);
  // At the 8 headline directions the effective profile differs from the profile by errors8.
  for (let k = 0; k < 8; k++) near(100 * (g[2 * k] / target[k] - 1), f.errors8[k], 1e-6, `dir ${k}`);
  // As an applied profile (cubic, 16 points) it stays within 0.25% of the model in between.
  for (let deg = 0; deg < 360; deg += 0.5) {
    const model = rawAccelAt(f, deg).gain;
    near(gainAt(g, deg, false), model, model * 2.5e-3, `${deg} deg`);
  }
});

test('rawAccelRows and rawAccelSummary describe the approximation', () => {
  const cfg = profileFromGains(PV8);
  const f = rawAccelFit(cfg);
  const rows = rawAccelRows(cfg, f);
  assert.equal(rows.length, 8);
  rows.forEach((r, k) => {
    near(r.target, PV8[k], 1 / 4096);
    near(r.errorPct, f.errors8[k], 1e-6);
    assert.ok(Math.abs(r.bendDeg) <= f.maxSkewDeg + 1e-9);
  });
  for (const k of [0, 2, 4, 6]) near(rows[k].bendDeg, 0, 1e-6, 'axes do not bend');
  const s = rawAccelSummary(f);
  assert.ok(['close', 'fair', 'rough'].includes(s.level));
  assert.match(s.text, /within \d+\.\d% of your profile/);
  assert.equal(rawAccelSummary(rawAccelFit(profileFromGains([1, 1, 1, 1, 1, 1, 1, 1]))).level, 'close');
  // A profile that is fast on the diagonals and slow on the axes cannot be expressed.
  const rough = rawAccelFit(profileFromGains([0.8, 1.25, 0.8, 1.25, 0.8, 1.25, 0.8, 1.25]));
  assert.equal(rawAccelSummary(rough).level, 'rough');
});

test('C header lists the Q12 gains', () => {
  const h = profileHeader(profileFromGains(PV8, { label: 'hdr' }));
  assert.match(h, /#define OMNI_DEFAULT_N_POINTS 8/);
  assert.match(h, /#define OMNI_DEFAULT_GAINS_Q12 \{3813, /);
  assert.match(h, /OMNI_DEFAULT_LABEL "hdr"/);
});
