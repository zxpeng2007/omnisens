// Recovers a known directional bias from simulated flicks.
// Run: node --test "web/test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrial, fitProfile, mulberry32, chi2SurvivalEven, lowpass } from '../js/analysis.js';
import { gainAt } from '../js/omni-core.js';

const DEG_PER_COUNT = 0.022;  // CS2 at sensitivity 1

// Minimum-jerk position profile, 0..1 over tau in [0, 1].
const mj = (tau) => (tau <= 0 ? 0 : tau >= 1 ? 1 : tau ** 3 * (10 - 15 * tau + 6 * tau * tau));

const BIAS = (deg) => {
  const a = (deg * Math.PI) / 180;
  return 1 + 0.07 * Math.cos(a) - 0.04 * Math.sin(a) + 0.03 * Math.cos(2 * a);
};
const FLAT = () => 1;

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * One simulated flick. The hand plans for the distance it sees but its
 * primary submovement covers bias(theta) times that; the adapter (if any)
 * scales the hand movement; a corrective submovement then lands on target.
 */
function simulateFlick(rng, { theta, dist, bias = BIAS, applied = null, noise = 0.06, kind = 'out', liftAt = null }) {
  const a = (theta * Math.PI) / 180;
  const ux = Math.cos(a), uy = -Math.sin(a);
  const outGain = applied ? gainAt(applied.gains, theta, applied.linear) : 1;
  const primaryOut = bias(theta) * dist * (1 + noise * gauss(rng)) * outGain;
  const rt = 170 + 90 * rng();
  const d1 = 150 + 0.06 * dist + 40 * rng();
  const gap = 20 + 40 * rng();
  const d2 = 120 + 50 * rng();
  const lat = 0.03 * dist * gauss(rng);
  const t = [0], x = [0], y = [0];
  let ms = 0, cx = 0, cy = 0, lost = [0, 0];
  while (ms < rt + d1 + gap + d2 + 60) {
    ms += 1;
    const p1 = mj((ms - rt) / d1), p2 = mj((ms - rt - d1 - gap) / d2);
    const along = primaryOut * p1 + (dist - primaryOut) * p2;
    const side = lat * p1 * (1 - p2);
    // Like a real mouse: an event only when the position changed, nothing while
    // still. During a lift the sensor reports nothing and that motion is lost.
    if (liftAt !== null && ms >= rt + liftAt * d1 && ms < rt + liftAt * d1 + 60) { lost = [ux * along - cx, uy * along - cy]; continue; }
    const nx = Math.round(ux * along - uy * side - lost[0]), ny = Math.round(uy * along + ux * side - lost[1]);
    if (nx !== cx || ny !== cy) { t.push(ms); x.push(nx); y.push(ny); cx = nx; cy = ny; }
  }
  return { kind, req: [ux * dist, uy * dist], t, x, y, applied, degPerCount: DEG_PER_COUNT };
}

function session(seed, { rounds = 8, bias = BIAS, applied = null, noise = 0.06, returns = true } = {}) {
  const rng = mulberry32(seed);
  const trials = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < 48; i++) {
      const theta = (((i % 16) * 22.5 + (rng() - 0.5) * 22.5) + 360) % 360;
      const amp = [8, 16, 28][Math.floor(i / 16)];
      const dist = amp / DEG_PER_COUNT;
      trials.push(simulateFlick(rng, { theta, dist, bias, applied, noise }));
      if (returns) trials.push(simulateFlick(rng, { theta: (theta + 180) % 360, dist, bias, applied, noise, kind: 'return' }));
    }
  }
  return trials;
}

const analyze = (trials) => trials.map((t) => analyzeTrial(t));

/** The full correction for BIAS, mean-normalised in log space. */
function idealGains(dirs, bias = BIAS) {
  const lg = dirs.map((d) => -Math.log(bias(d)));
  const m = lg.reduce((s, v) => s + v, 0) / lg.length;
  return lg.map((v) => Math.exp(v - m));
}

test('butterworth low-pass keeps DC and removes high frequencies', () => {
  const n = 2000, sig = Array.from({ length: n }, (_, i) => 5 + Math.sin((2 * Math.PI * 100 * i) / 1000));
  const f = lowpass(sig, 10, 1000);
  for (let i = 300; i < n - 300; i++) assert.ok(Math.abs(f[i] - 5) < 0.02, `sample ${i}: ${f[i]}`);
});

test('chi-square survival (even df) matches known values', () => {
  assert.ok(Math.abs(chi2SurvivalEven(5.991, 2) - 0.05) < 1e-3);
  assert.ok(Math.abs(chi2SurvivalEven(9.488, 4) - 0.05) < 1e-3);
  assert.ok(Math.abs(chi2SurvivalEven(16.812, 6) - 0.01) < 1e-3);
});

test('a clean flick is measured accurately in every direction and distance', () => {
  const rng = mulberry32(1);
  for (const theta of [0, 45, 90, 135, 180, 225, 270, 315]) {
    for (const amp of [8, 16, 28]) {
      const r = analyzeTrial(simulateFlick(rng, { theta, dist: amp / DEG_PER_COUNT, noise: 0 }));
      assert.equal(r.ok, true, `${theta}/${amp}: ${r.reason}`);
      assert.ok(Math.abs(r.ratio / BIAS(theta) - 1) < 0.03, `${theta}/${amp}: ratio ${r.ratio.toFixed(3)} vs ${BIAS(theta).toFixed(3)} (${r.endType})`);
      const dTheta = Math.abs(((r.theta - theta + 540) % 360) - 180);
      assert.ok(dTheta < 1, `direction ${r.theta}`);
    }
  }
});

test('fresh calibration at full strength recovers the mean-normalised 1/bias', () => {
  const res = analyze(session(42));
  const fit = fitProfile(res, { strength: 1, bootstrap: 40 });
  assert.ok(fit.ok, fit.error);
  assert.ok(fit.rejectedFrac < 0.1, `rejected ${fit.rejectedFrac}: ${JSON.stringify(fit.rejected)}`);
  assert.ok(fit.evidence.passed, JSON.stringify(fit.evidence));
  assert.ok(fit.K >= 2, `K = ${fit.K}`);
  const want = idealGains(fit.directions);
  fit.gains.forEach((g, k) => assert.ok(Math.abs(g / want[k] - 1) < 0.025, `dir ${fit.directions[k]}: ${g.toFixed(3)} vs ${want[k].toFixed(3)}`));
  const want8 = idealGains([0, 45, 90, 135, 180, 225, 270, 315]);
  fit.gains8.forEach((g, k) => assert.ok(Math.abs(g / want8[k] - 1) < 0.025));
  fit.ci8.forEach(([lo, hi], k) => assert.ok(lo <= fit.gains8[k] + 0.01 && hi >= fit.gains8[k] - 0.01, `ci ${k}`));
  // Overall sensitivity is preserved: geometric mean of the table is 1.
  const gm = Math.exp(fit.gains.reduce((s, g) => s + Math.log(g), 0) / fit.gains.length);
  assert.ok(Math.abs(gm - 1) < 1e-9);
});

test('default strength applies a partial correction', () => {
  const res = analyze(session(43));
  const full = fitProfile(res, { strength: 1, bootstrap: 0 });
  const part = fitProfile(res, { bootstrap: 0 });
  full.gains.forEach((g, k) => {
    const expect = Math.exp(0.7 * Math.log(g));
    assert.ok(Math.abs(part.gains[k] / expect - 1) < 0.003, `dir ${k}`);
  });
});

test('no real bias: the evidence gate keeps the profile flat', () => {
  let passed = 0;
  for (const seed of [5, 6, 7]) {
    const fit = fitProfile(analyze(session(seed, { bias: FLAT })), { bootstrap: 0 });
    assert.ok(fit.ok);
    if (fit.evidence.passed) passed++;
    else fit.gains.forEach((g) => assert.equal(g, 1));
  }
  assert.ok(passed <= 1, `gate passed on ${passed}/3 unbiased sessions`);
  const forced = fitProfile(analyze(session(5, { bias: FLAT })), { bootstrap: 0, force: true });
  forced.gains.forEach((g) => assert.ok(Math.abs(g - 1) < 0.03));
});

test('tracking-safe mode is symmetric', () => {
  const fit = fitProfile(analyze(session(44)), { symmetric: true, strength: 1, bootstrap: 0, nPoints: 16 });
  assert.ok(fit.ok);
  for (let k = 0; k < 8; k++) assert.ok(Math.abs(fit.gains[k] - fit.gains[k + 8]) < 1e-9);
  // Only the even (cos 2 theta) part of BIAS should remain.
  const want = idealGains(fit.directions, (d) => Math.exp(Math.log(1 + 0.03 * Math.cos((2 * d * Math.PI) / 180))));
  fit.gains.forEach((g, k) => assert.ok(Math.abs(g / want[k] - 1) < 0.02, `dir ${k}: ${g} vs ${want[k]}`));
});

test('gains are clamped to +-15% by default', () => {
  const big = (d) => 1 + 0.35 * Math.cos((d * Math.PI) / 180);
  const fit = fitProfile(analyze(session(45, { bias: big, rounds: 4 })), { strength: 1, bootstrap: 0 });
  assert.ok(fit.ok, fit.error);
  fit.gains.forEach((g) => assert.ok(Math.abs(Math.log(g)) <= 0.15 + 1e-9, `gain ${g}`));
});

test('refining with the profile active converges to the same correction', () => {
  const first = fitProfile(analyze(session(7)), { strength: 1, bootstrap: 0 });
  const applied = { gains: first.gains, linear: false, rotationCdeg: 0 };
  const second = fitProfile(analyze(session(8, { applied })), { strength: 1, bootstrap: 0 }, applied);
  const want = idealGains(second.directions);
  second.gains.forEach((g, k) => assert.ok(Math.abs(g / want[k] - 1) < 0.03, `dir ${k}: ${g.toFixed(3)} vs ${want[k].toFixed(3)}`));
  // With the first profile active, little directional bias should remain.
  const ratios = second.bins8.map((b) => b.medianRatio);
  assert.ok(Math.max(...ratios) - Math.min(...ratios) < 0.06, `residual spread ${ratios}`);
});

test('too little data is reported, not guessed', () => {
  const fit = fitProfile(analyze(session(10, { rounds: 1, returns: false })).slice(0, 20));
  assert.equal(fit.ok, false);
  assert.ok(fit.error);
});

test('real event timing: still periods are not mistaken for a lifted mouse', () => {
  const res = analyze(session(11, { rounds: 2 }));
  const lifted = res.filter((r) => r.reason === 'mouse-lifted').length;
  assert.ok(lifted === 0, `${lifted} flicks flagged as lifted`);
  assert.ok(res.filter((r) => r.ok).length / res.length > 0.9);
});

test('lifting the mouse mid-flick is rejected', () => {
  const rng = mulberry32(12);
  let flagged = 0;
  for (let i = 0; i < 10; i++) {
    const r = analyzeTrial(simulateFlick(rng, { theta: i * 36, dist: 900, noise: 0, liftAt: 0.35 }));
    if (r.reason === 'mouse-lifted') flagged++;
  }
  assert.ok(flagged >= 8, `only ${flagged}/10 lifted flicks rejected`);
});

test('garbage trials are rejected with a reason', () => {
  assert.equal(analyzeTrial({ req: [5, 0], t: [0, 1, 2, 3, 4, 5, 6], x: [0, 0, 0, 0, 0, 0, 0], y: [0, 0, 0, 0, 0, 0, 0] }).reason, 'target-too-close');
  const still = { req: [500, 0], t: [0, 100, 200, 300, 400, 500], x: [0, 0, 0, 0, 0, 0], y: [0, 0, 0, 0, 0, 0] };
  assert.equal(analyzeTrial(still).ok, false);
  // Moving the wrong way first.
  const rng = mulberry32(3);
  const wrong = simulateFlick(rng, { theta: 0, dist: 700, noise: 0 });
  wrong.req = [-700, 0];
  assert.equal(analyzeTrial(wrong).ok, false);
});
