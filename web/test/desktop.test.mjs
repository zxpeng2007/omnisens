// Run: node --test "web/test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureToken, desktopToken, desktopStatus, isDesktop, detectDesktop, desktopApi, desktopCorrection,
  rawAccelSteps, engineSteps, linuxSetupCommand, TOKEN_KEY, _resetDesktopForTests,
} from '../js/desktop.js';
import { encodeProfile, profileFromGains, rawAccelAt, rawAccelEffectiveGains } from '../js/export.js';
import { FLAG_ENABLED, gainAt } from '../js/omni-core.js';

const TOKEN = '0123456789abcdef0123456789abcdef';

function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

function fakeEnv(url, store = fakeStore()) {
  const u = new URL(url);
  const calls = [];
  return {
    calls,
    location: { pathname: u.pathname, search: u.search, hash: u.hash },
    history: { state: null, replaceState: (state, title, next) => calls.push(next) },
    sessionStorage: store,
  };
}

/** Replaces global fetch for one test; returns the recorded requests. */
function stubFetch(t, respond) {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    seen.push({ path, init });
    return respond(path, init);
  };
  t.after(() => { globalThis.fetch = orig; });
  return seen;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('captureToken stores the token and removes it from the URL, keeping the rest', () => {
  _resetDesktopForTests();
  const env = fakeEnv(`http://127.0.0.1:8731/?t=${TOKEN}&debug#/pc`);
  assert.equal(captureToken(env), TOKEN);
  assert.equal(desktopToken(), TOKEN);
  assert.equal(env.sessionStorage.map.get(TOKEN_KEY), TOKEN);
  assert.deepEqual(env.calls, ['/?debug#/pc']);
  assert.equal(desktopStatus(), 'checking');
  assert.equal(isDesktop(), false, 'not before the ping');
});

test('captureToken without a URL token reuses the one saved in this tab', () => {
  _resetDesktopForTests();
  const env = fakeEnv('http://127.0.0.1:8731/#/results', fakeStore({ [TOKEN_KEY]: TOKEN }));
  assert.equal(captureToken(env), TOKEN);
  assert.deepEqual(env.calls, [], 'URL untouched');
});

test('captureToken on the website finds nothing and touches nothing', () => {
  _resetDesktopForTests();
  const env = fakeEnv('https://zxpeng2007.github.io/omnisens/#/calibrate');
  assert.equal(captureToken(env), null);
  assert.equal(desktopStatus(), 'none');
  assert.deepEqual(env.calls, []);
  assert.equal(env.sessionStorage.map.size, 0);
});

test('captureToken drops a malformed token from the URL but does not use it', () => {
  _resetDesktopForTests();
  const env = fakeEnv('http://127.0.0.1:8731/?t=%3Cscript%3E#/pc');
  assert.equal(captureToken(env), null);
  assert.deepEqual(env.calls, ['/#/pc']);
  assert.equal(env.sessionStorage.map.size, 0);
});

test('captureToken survives blocked storage and history', () => {
  _resetDesktopForTests();
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const env = fakeEnv(`http://localhost:8731/?t=${TOKEN}`, throwing);
  env.history.replaceState = () => { throw new Error('nope'); };
  assert.equal(captureToken(env), TOKEN);
  const env2 = {
    location: { pathname: '/', search: '', hash: '' },
    history: null,
    get sessionStorage() { throw new Error('SecurityError'); },
  };
  assert.equal(captureToken(env2), null);
});

test('desktopApi sends the token, JSON in and out', async (t) => {
  _resetDesktopForTests();
  captureToken(fakeEnv(`http://127.0.0.1:8731/?t=${TOKEN}`));
  const seen = stubFetch(t, (path) => json(200, path === '/api/info' ? { app: 'omnisens', method: 'rawaccel' } : { ok: true }));
  assert.deepEqual(await desktopApi('/api/info'), { app: 'omnisens', method: 'rawaccel' });
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].init.headers['X-Omnisens-Token'], TOKEN);
  assert.equal(seen[0].init.body, undefined);
  assert.equal(seen[0].init.headers['Content-Type'], undefined);

  assert.deepEqual(await desktopApi('/api/apply', { code: 'omni1.x' }, { keepalive: true }), { ok: true });
  const post = seen[1].init;
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.equal(post.headers['X-Omnisens-Token'], TOKEN);
  assert.equal(post.body, '{"code":"omni1.x"}');
  assert.equal(post.keepalive, true);
  assert.equal(post.cache, 'no-store');
});

test('desktopApi turns {error}, HTTP errors and a dead app into readable errors', async (t) => {
  _resetDesktopForTests();
  captureToken(fakeEnv(`http://127.0.0.1:8731/?t=${TOKEN}`));
  let mode = 'error';
  stubFetch(t, () => {
    if (mode === 'error') return json(409, { error: "Raw Accel's driver is not running. Restart your PC." });
    if (mode === 'forbidden') return new Response('forbidden', { status: 403 });
    if (mode === 'html') return new Response('<html>', { status: 200 });
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(desktopApi('/api/apply', { code: 'x' }), /driver is not running/);
  mode = 'forbidden';
  await assert.rejects(desktopApi('/api/info'), /did not accept this page/);
  mode = 'html';
  await assert.rejects(desktopApi('/api/info'), /cannot read/);
  mode = 'down';
  await assert.rejects(desktopApi('/api/info'), /not responding/);
  await assert.rejects(desktopApi('/elsewhere'), /Not an API path/);
});

test('desktopApi refuses to run without a token', async () => {
  _resetDesktopForTests();
  await assert.rejects(desktopApi('/api/info'), /not opened by the omnisens app/);
});

test('detectDesktop pings once and caches the answer', async (t) => {
  _resetDesktopForTests();
  captureToken(fakeEnv(`http://127.0.0.1:8731/?t=${TOKEN}`));
  const seen = stubFetch(t, () => json(200, { ok: true }));
  assert.equal(await detectDesktop(), true);
  assert.equal(await detectDesktop(), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/api/ping');
  assert.equal(isDesktop(), true);
  assert.equal(desktopStatus(), 'ok');
});

test('detectDesktop: no token means website, a silent app means failed', async (t) => {
  _resetDesktopForTests();
  const seen = stubFetch(t, () => { throw new TypeError('Failed to fetch'); });
  captureToken(fakeEnv('http://example.test/'));
  assert.equal(await detectDesktop(), false);
  assert.equal(seen.length, 0, 'the website never calls the API');
  assert.equal(desktopStatus(), 'none');

  captureToken(fakeEnv(`http://127.0.0.1:8731/?t=${TOKEN}`));
  assert.equal(await detectDesktop(), false);
  assert.equal(desktopStatus(), 'failed');
  assert.equal(isDesktop(), false);
});

test('desktopCorrection: Raw Accel factors become the effective 16-point profile', () => {
  const applied = { code: 'omni1.abc', right: 0.95, left: 1.03, up: 1.04, down: 0.98, rotationDeg: 0, at: '2026-10-22T10:00:00Z' };
  const info = { method: 'rawaccel', rawAccel: { applied, paused: true } };
  const c = desktopCorrection(info);
  assert.equal(c.kind, 'rawaccel');
  assert.equal(c.paused, true);
  assert.equal(c.code, 'omni1.abc');
  assert.deepEqual(c.current, { gains: rawAccelEffectiveGains(applied), linear: false, rotationCdeg: 0 });
  assert.equal(desktopCorrection({ method: 'rawaccel', rawAccel: { applied: null } }), null);
  assert.equal(desktopCorrection({ method: 'rawaccel', rawAccel: { applied: { ...applied, up: 0 } } }), null);
  assert.equal(desktopCorrection(null), null);
  assert.equal(desktopCorrection({ method: 'none' }), null);
});

test('desktopCorrection: a Raw Accel rotation is recorded so the analysis can undo it', () => {
  const f = { right: 0.95, left: 1.03, up: 1.04, down: 0.98 };
  const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);
  const maxBend = Math.max(...Array.from({ length: 1440 }, (_, i) => Math.abs(rawAccelAt(f, i / 4).bendDeg)));
  for (const rotationDeg of [0, -3, 8]) {
    const c = desktopCorrection({ method: 'rawaccel', rawAccel: { applied: { code: 'omni1.x', ...f, rotationDeg } } });
    assert.equal(c.current.rotationCdeg, rotationDeg ? Math.round(-rotationDeg * 100) : 0);
    for (let phi = 0; phi < 360; phi += 7.5) {
      // Raw Accel: rotate the hand movement (clockwise positive), then scale each axis by its side's factor.
      const t = ((phi - rotationDeg) * Math.PI) / 180;
      const x = Math.cos(t), y = Math.sin(t);
      const ox = x * (x >= 0 ? f.right : f.left), oy = y * (y >= 0 ? f.up : f.down);
      // Analysis (analyzeTrial): hand direction = output direction minus the recorded rotation.
      const theta = ((((Math.atan2(oy, ox) * 180) / Math.PI - c.current.rotationCdeg / 100) % 360) + 360) % 360;
      const off = ((((theta - phi) % 360) + 540) % 360) - 180;
      assert.ok(Math.abs(off) <= maxBend + 1e-6, `rot ${rotationDeg}, ${phi} deg: attributed ${off.toFixed(2)} deg off`);
      // The axis-blend bend itself (not the rotation) costs a little gain accuracy.
      near(gainAt(c.current.gains, theta, false), Math.hypot(ox, oy), 5e-3, `rot ${rotationDeg}, ${phi} deg`);
    }
  }
});

test('desktopCorrection: the Linux engine runs the profile itself', () => {
  const cfg = profileFromGains([0.95, 1, 1.05, 1, 1.02, 1, 0.98, 1], { base: { rotationCdeg: 150 } });
  const code = encodeProfile(cfg);
  const c = desktopCorrection({ method: 'engine', engine: { running: true, paused: false, code } });
  assert.equal(c.kind, 'engine');
  assert.equal(c.current.gains.length, 8);
  assert.ok(Math.abs(c.current.gains[2] - 1.05) < 1e-3);
  assert.equal(c.current.linear, false);
  assert.equal(c.current.rotationCdeg, 150);
  assert.equal(desktopCorrection({ method: 'engine', engine: { running: false, code } }), null);
  assert.equal(desktopCorrection({ method: 'engine', engine: { running: true, code: 'garbage' } }), null);
  const off = encodeProfile({ ...cfg, flags: cfg.flags & ~FLAG_ENABLED });
  assert.equal(desktopCorrection({ method: 'engine', engine: { running: true, code: off } }), null, 'disabled profile passes through');
});

test('Raw Accel checklist marks the first open step', () => {
  const states = (ra) => rawAccelSteps(ra).map((s) => s.state).join(' ');
  assert.equal(states({}), 'current todo todo todo');
  assert.equal(states({ found: true, dir: 'C:\\RA' }), 'done current todo todo');
  assert.equal(states({ found: true, dir: 'C:\\RA', driverInstalled: true, restartNeeded: true }), 'done done current todo');
  assert.equal(states({ found: true, dir: 'C:\\RA', driverInstalled: true, driverRunning: true }), 'done done done done');
  // Driver installed earlier, but omnisens does not know the folder yet.
  assert.equal(states({ found: false, dir: '', driverInstalled: true, driverRunning: true }), 'current done done todo');
  assert.match(rawAccelSteps({ driverInstalled: true }).find((s) => s.id === 'restart').detail, /Restart your PC/);
});

test('Linux checklist and setup command', () => {
  const st = engineSteps({ canReadInput: true, canWriteUinput: false });
  assert.deepEqual(st.map((s) => s.state), ['done', 'current', 'todo']);
  const run = engineSteps({ canReadInput: true, canWriteUinput: true, running: true, devices: ['Mouse A'] });
  assert.deepEqual(run.map((s) => s.state), ['done', 'done', 'done']);
  assert.match(run[2].detail, /1 mouse device\b/);
  assert.equal(linuxSetupCommand('amd64'), 'sudo ./omnisens-linux-x64 linux-setup --install');
  assert.equal(linuxSetupCommand('arm64'), 'sudo ./omnisens-linux-arm64 linux-setup --install');
});
