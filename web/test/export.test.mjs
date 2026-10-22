// Run: node --test "web/test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeProfile, decodeProfile, profileJson, profileHeader, rawAccelSettings,
  smoothingForDpi, profileFromGains, headlineGains, headlineText,
} from '../js/export.js';
import { defaultConfig, configGains, sanitizeConfig, FLAG_ENABLED, FLAG_LINEAR, FLAG_CHORD_TOGGLE } from '../js/omni-core.js';

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

test('Raw Accel export uses the axis gains as output DPI and ratios', () => {
  const cfg = profileFromGains(PV8);
  const s = JSON.parse(rawAccelSettings(cfg));
  const p = s.profiles[0];
  near(p['Output DPI'], 1000 * PV8[0], 0.5);
  near(p['L/R output DPI ratio (left sens multiplier)'], PV8[4] / PV8[0], 1e-3);
  near(p['Y/X output DPI ratio (vertical sens multiplier)'], PV8[6] / PV8[0], 1e-3);
  near(p['U/D output DPI ratio (up sens multiplier)'], PV8[2] / PV8[6], 1e-3);
});

test('C header lists the Q12 gains', () => {
  const h = profileHeader(profileFromGains(PV8, { label: 'hdr' }));
  assert.match(h, /#define OMNI_DEFAULT_N_POINTS 8/);
  assert.match(h, /#define OMNI_DEFAULT_GAINS_Q12 \{3813, /);
  assert.match(h, /OMNI_DEFAULT_LABEL "hdr"/);
});
