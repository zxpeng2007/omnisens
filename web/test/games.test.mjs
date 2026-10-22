// Run: node --test "web/test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { GAMES, gameById, degPerCount, cm360, degPerCountFromCm360, defaultFov, resolveSensitivity } from '../js/games.js';
import { sanitizeSettings, loadSettings, saveSettings, DEFAULT_SETTINGS } from '../js/settings.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

test('CS2 sens 1 at 800 DPI is 51.95 cm/360', () => {
  near(cm360(degPerCount('cs2', 1), 800), 51.95, 0.01);
});

test('cm/360 and deg/count are inverses', () => {
  for (const dpi of [400, 800, 1600, 3200]) {
    for (const cm of [20, 34.6, 51.95, 90]) near(cm360(degPerCountFromCm360(cm, dpi), dpi), cm, 1e-9);
  }
});

test('per-game yaw values', () => {
  near(degPerCount('valorant', 0.4), 0.028, 1e-12);
  near(degPerCount('ow2', 5), 0.033, 1e-12);
  near(degPerCount('apex', 2), 0.044, 1e-12);
  near(degPerCount('fortnite', 8), 0.04444, 1e-12, 'Fortnite slider 8%');
  near(degPerCount('custom', 2, 0.01), 0.02, 1e-12);
  assert.ok(Number.isNaN(degPerCount('custom', 2, 0)));
  assert.ok(Number.isNaN(degPerCount('cm360', 1)));
  assert.ok(Number.isNaN(degPerCount('nope', 1)));
  assert.ok(Number.isNaN(degPerCount('cs2', 0)));
});

test('Rainbow Six multiplier scales relative to the 0.02 default', () => {
  const base = degPerCount('r6', 50);
  near(base, 0.00572957795 * 50, 1e-12);
  near(degPerCount('r6', 50, null, 0.01), base / 2, 1e-12);
});

test('every game has a name and a FOV preset; uncertain values carry notes', () => {
  for (const g of GAMES) {
    assert.ok(g.name && g.id);
    assert.ok(g.fov > 40 && g.fov < 170);
  }
  near(defaultFov('cs2'), 106.26, 1e-9);
  near(defaultFov('valorant'), 103, 1e-9);
  near(defaultFov('apex'), 110, 1e-9);
  for (const id of ['marvel', 'deadlock', 'finals', 'apex']) assert.ok(gameById(id).note, id);
});

test('resolveSensitivity validates input', () => {
  const ok = resolveSensitivity({ ...DEFAULT_SETTINGS });
  assert.equal(ok.ok, true);
  near(ok.cm360, 51.95, 0.01);
  const cm = resolveSensitivity({ ...DEFAULT_SETTINGS, game: 'cm360', cm360: 40, dpi: 1600 });
  assert.equal(cm.ok, true);
  near(cm.cm360, 40, 1e-9);
  assert.equal(resolveSensitivity({ ...DEFAULT_SETTINGS, dpi: 0 }).ok, false);
  assert.equal(resolveSensitivity({ ...DEFAULT_SETTINGS, sens: 1000 }).ok, false, 'absurd cm/360 rejected');
});

test('settings sanitize, persist and survive broken storage', () => {
  const s = sanitizeSettings({ dpi: '1600', game: 'bogus', strength: 3, nPoints: 8, extra: 1 });
  assert.equal(s.dpi, 1600);
  assert.equal(s.game, DEFAULT_SETTINGS.game);
  assert.equal(s.strength, 1);
  assert.equal(s.nPoints, 8);
  assert.equal('extra' in s, false);

  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  assert.equal(saveSettings({ ...DEFAULT_SETTINGS, dpi: 3200 }, store), true);
  assert.equal(loadSettings(store).dpi, 3200);

  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadSettings(broken), sanitizeSettings({}));
  assert.equal(saveSettings(DEFAULT_SETTINGS, broken), false);
  mem.set('omnisens.settings.v1', '{not json');
  assert.deepEqual(loadSettings(store), sanitizeSettings({}));
});
