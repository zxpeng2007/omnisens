// Recovers a known directional bias from simulated flicks.
// Run: node --test "web/test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrial, fitProfile, mulberry32, chi2SurvivalEven, fSurvival, lowpass } from '../js/analysis.js';
import { gainAt } from '../js/omni-core.js';

const DEG_PER_COUNT = 0.022;  // CS2 at sensitivity 1

// Minimum-jerk position profile, 0..1 over tau in [0, 1].
const mj = (tau) => (tau <= 0 ? 0 : tau >= 1 ? 1 : tau ** 3 * (10 - 15 * tau + 6 * tau * tau));

const BIAS = (deg) => {
  const a = (deg * Math.PI) / 180;
  return 1 + 0.07 * Math.cos(a) - 0.04 * Math.sin(a) + 0.03 * Math.cos(2 * a);
};
const FLAT = () => 1;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const geoMean = (g) => Math.exp(mean(g.map(Math.log)));

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * One simulated flick, recorded like the app: an event only when the reported
 * position changed (one report per pollMs at most), and a sample with the
 * position held until the click. The hand plans for the distance it sees but
 * its primary submovement covers bias(theta) times that (or `ratio`); the
 * adapter (if any) scales the hand movement. A corrective submovement starts
 * `gap` ms after the primary ends (negative: it overlaps the primary), unless
 * the primary already landed inside the target (radiusFrac * dist), in which
 * case the player just clicks. record: 'end' = current recorder (endMs and the
 * held sample), 'hit' = older sessions (hitMs only).
 */
function simulateFlick(rng, {
  theta, dist, bias = BIAS, applied = null, noise = 0.06, kind = 'out', liftAt = null, ratio = null,
  pollMs = 1, gap = [20, 60], d2 = [120, 170], radiusFrac = null, record = 'end',
}) {
  const a = (theta * Math.PI) / 180;
  const ux = Math.cos(a), uy = -Math.sin(a);
  const outGain = applied ? gainAt(applied.gains, theta, applied.linear) : 1;
  const hand = ratio ?? bias(theta) * (1 + noise * gauss(rng));
  const primaryOut = hand * dist * outGain;
  const rt = 170 + 90 * rng();
  const d1 = 150 + 0.06 * dist + 40 * rng();
  const g = gap[0] + (gap[1] - gap[0]) * rng();
  const dur2 = d2[0] + (d2[1] - d2[0]) * rng();
  const lat = 0.03 * dist * gauss(rng);
  const corrects = radiusFrac === null || Math.abs(primaryOut - dist) > radiusFrac * dist;
  const endMs = Math.round(rt + (corrects ? Math.max(d1, d1 + g + dur2) : d1) + 60 + 100 * rng());
  const phase = pollMs > 1 ? Math.floor(pollMs * rng()) : 0;
  const t = [0], x = [0], y = [0];
  let cx = 0, cy = 0, lost = [0, 0];
  for (let ms = 1; ms <= endMs; ms++) {
    const p1 = mj((ms - rt) / d1), p2 = corrects ? mj((ms - rt - d1 - g) / dur2) : 0;
    const along = primaryOut * p1 + (dist - primaryOut) * p2;
    const side = lat * p1 * (1 - p2);
    // Like a real mouse: an event only when the position changed, nothing while
    // still. During a lift the sensor reports nothing and that motion is lost.
    if (liftAt !== null && ms >= rt + liftAt * d1 && ms < rt + liftAt * d1 + 60) { lost = [ux * along - cx, uy * along - cy]; continue; }
    if ((ms + phase) % pollMs) continue;
    const nx = Math.round(ux * along - uy * side - lost[0]), ny = Math.round(uy * along + ux * side - lost[1]);
    if (nx !== cx || ny !== cy) { t.push(ms); x.push(nx); y.push(ny); cx = nx; cy = ny; }
  }
  const trial = { kind, req: [ux * dist, uy * dist], t, x, y, applied, degPerCount: DEG_PER_COUNT, hitMs: endMs, hand, corrected: corrects };
  if (record === 'end') {
    trial.endMs = endMs;
    if (endMs > t[t.length - 1]) { t.push(endMs); x.push(cx); y.push(cy); }
  }
  return trial;
}

function session(seed, { rounds = 8, returns = true, ...flick } = {}) {
  const rng = mulberry32(seed);
  const trials = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < 48; i++) {
      const theta = (((i % 16) * 22.5 + (rng() - 0.5) * 22.5) + 360) % 360;
      const amp = [8, 16, 28][Math.floor(i / 16)];
      const dist = amp / DEG_PER_COUNT;
      trials.push(simulateFlick(rng, { ...flick, theta, dist }));
      if (returns) trials.push(simulateFlick(rng, { ...flick, theta: (theta + 180) % 360, dist, kind: 'return' }));
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

test('F survival matches closed forms and table quantiles', () => {
  // d1 = 2 and d2 = 2 have closed forms.
  for (const d2 of [3, 10, 57]) for (const f of [0.2, 1, 3, 9]) {
    assert.ok(Math.abs(fSurvival(f, 2, d2) - (1 + (2 * f) / d2) ** (-d2 / 2)) < 1e-12);
  }
  for (const d1 of [1, 3, 6]) for (const f of [0.5, 2, 10]) {
    assert.ok(Math.abs(fSurvival(f, d1, 2) - (1 - ((d1 * f) / (d1 * f + 2)) ** (d1 / 2))) < 1e-12);
  }
  // Upper quantiles from F tables (F(1, 10) via t(10)^2).
  for (const [f, d1, d2, p] of [[4.9646, 1, 10, 0.05], [7.5594, 2, 10, 0.01], [2.8661, 4, 20, 0.05],
    [3.4735, 6, 30, 0.01], [2.1906, 6, 100, 0.05], [161.45, 1, 1, 0.05]]) {
    assert.ok(Math.abs(fSurvival(f, d1, d2) - p) < 2e-5, `F(${d1}, ${d2}) > ${f}: ${fSurvival(f, d1, d2)}`);
  }
  // Large d2: d1 * F tends to chi-square(d1).
  for (const q of [2, 4, 6]) for (const x of [3, 9, 20]) assert.ok(Math.abs(fSurvival(x / q, q, 1e8) - chi2SurvivalEven(x, q)) < 1e-6);
  assert.equal(fSurvival(0, 6, 100), 1);
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

// A flick that lands inside the target needs no correction: the player clicks
// and the mouse sends nothing more. Rejecting those would keep only the misses
// and inflate the measured bias, so they must be measured as well as the rest.
for (const pollMs of [1, 8]) {
  for (const record of ['end', 'hit']) {
    test(`flicks that land on target in one movement are measured (${1000 / pollMs} Hz, ${record === 'end' ? 'current recorder' : 'older sessions without the end sample'})`, () => {
      const rng = mulberry32(31 + pollMs);
      const all = [], single = [];
      for (let i = 0; i < 240; i++) {
        const tr = simulateFlick(rng, { theta: 360 * rng(), dist: [8, 16, 28][i % 3] / DEG_PER_COUNT, bias: () => 1.05, radiusFrac: 1 / 14, pollMs, record });
        const r = analyzeTrial(tr);
        all.push({ r, hand: tr.hand });
        if (!tr.corrected) single.push(r);
      }
      const ok = all.filter((e) => e.r.ok);
      assert.ok(single.length > 100, `${single.length} single-movement flicks`);
      assert.ok(single.filter((r) => r.ok).length >= 0.98 * single.length, JSON.stringify(single.filter((r) => !r.ok).map((r) => r.reason)));
      assert.ok(ok.length >= 0.98 * all.length, `${ok.length}/${all.length} measured`);
      // No selection: the mean measured ratio is the mean of every flick's true ratio.
      const bias = mean(ok.map((e) => e.r.ratio)) - mean(all.map((e) => e.hand));
      assert.ok(Math.abs(bias) < 0.006, `mean measured - true = ${bias.toFixed(4)}`);
    });
  }
  test(`a pause before the correction is not a lift, a lift mid-primary is (${1000 / pollMs} Hz)`, () => {
    const rng = mulberry32(41 + pollMs);
    const paused = Array.from({ length: 90 }, (_, i) => analyzeTrial(simulateFlick(rng, { theta: 4 * i, dist: [8, 16, 28][i % 3] / DEG_PER_COUNT, gap: [20, 60], pollMs })));
    assert.ok(paused.filter((r) => r.ok).length >= 88, JSON.stringify(paused.filter((r) => !r.ok).map((r) => r.reason)));
    let flagged = 0;
    for (let i = 0; i < 20; i++) {
      const r = analyzeTrial(simulateFlick(rng, { theta: i * 18, dist: 900, noise: 0, liftAt: 0.35, pollMs }));
      if (r.reason === 'mouse-lifted') flagged++;
    }
    assert.ok(flagged >= 18, `only ${flagged}/20 lifted flicks rejected`);
  });
}

/** Mean measured ratio for flicks with a fixed true primary ratio. */
function measuredAt(ratio, flick, seg = {}, n = 45) {
  const rng = mulberry32(Math.round(ratio * 1000));
  const m = [];
  for (let i = 0; i < n; i++) {
    const r = analyzeTrial(simulateFlick(rng, { theta: 360 * rng(), dist: [8, 16, 28][i % 3] / DEG_PER_COUNT, ratio, d2: [80, 140], ...flick }), seg);
    if (r.ok) m.push(r.ratio);
  }
  assert.ok(m.length >= n - 1, `${n - m.length} rejected at ratio ${ratio}`);
  return mean(m);
}

test('a correction that overlaps the primary: under- and overshoots stay visible', () => {
  // Slope of measured vs true extent on each side of 1 (1 = measured exactly).
  const slopes = (flick, seg) => {
    const [u15, u8, one, o8, o15] = [0.85, 0.92, 1, 1.08, 1.15].map((r) => measuredAt(r, flick, seg));
    return { u8: (one - u8) / 0.08, o8: (o8 - one) / 0.08, u15: (one - u15) / 0.15, o15: (o15 - one) / 0.15 };
  };
  for (const lag of [20, 40]) {
    const s = slopes({ gap: [-lag, -lag] });
    assert.ok(Math.abs(s.u15 - s.o15) < 0.1, `${lag} ms overlap, +-15%: ${JSON.stringify(s)}`);
    assert.ok(s.u15 > 0.75 && s.o15 > 0.75, `${lag} ms: ${JSON.stringify(s)}`);
    assert.ok(s.u8 > 0.5 && s.u8 > 0.65 * s.o8, `${lag} ms overlap, +-8%: ${JSON.stringify(s)}`);
  }
  // The 40 ms persistence used for reversals and stops hid most undershoots here.
  const old = slopes({ gap: [-40, -40] }, { persistAccelMs: 40 });
  assert.ok(slopes({ gap: [-40, -40] }).u8 > old.u8 + 0.15, `old ${JSON.stringify(old)}`);
  // 60 ms of overlap merges the two into one movement: undershoots are
  // compressed more than overshoots, but both still show in the right direction.
  const deep = slopes({ gap: [-60, -60] });
  assert.ok(deep.u15 > 0.3 && deep.o15 > 0.5, `60 ms: ${JSON.stringify(deep)}`);
});

test('refining converges when corrections often overlap the primary', () => {
  // Undershoots overall (0.92) with the BIAS shape; corrections start from 60 ms
  // before to 20 ms after the primary ends.
  const bias = (d) => 0.92 * BIAS(d);
  const dirs = Array.from({ length: 72 }, (_, k) => k * 5);
  const residual = (gains) => {
    const r = dirs.map((d) => Math.log(bias(d)) + Math.log(gains ? gainAt(gains, d) : 1));
    const m = mean(r);
    return Math.max(...r.map((v) => Math.abs(v - m)));
  };
  let applied = null;
  const hist = [residual(null)];
  for (let it = 0; it < 4; it++) {
    const res = analyze(session(500 + it, { rounds: 6, bias, applied, gap: [-60, 20], d2: [80, 140] }));
    const fit = fitProfile(res, { bootstrap: 0 }, applied);
    applied = { gains: fit.gains, linear: false, rotationCdeg: 0 };
    hist.push(residual(fit.gains));
  }
  // Strength 0.7 removes a bit over half of what is left each round.
  assert.ok(hist[1] < 0.6 * hist[0] && hist[2] < 0.6 * hist[1], `residual by round ${hist.map((v) => v.toFixed(3))}`);
  assert.ok(hist[4] < 0.02, `residual by round ${hist.map((v) => v.toFixed(3))}`);
});

test('fresh calibration at full strength recovers the mean-normalised 1/bias', () => {
  const res = analyze(session(42));
  const fit = fitProfile(res, { strength: 1, bootstrap: 40 });
  assert.ok(fit.ok, fit.error);
  assert.ok(fit.rejectedFrac < 0.1, `rejected ${fit.rejectedFrac}: ${JSON.stringify(fit.rejected)}`);
  assert.ok(fit.evidence.passed, JSON.stringify(fit.evidence));
  assert.ok(fit.evidence.reliability > fit.evidence.replicationThreshold);
  assert.ok(fit.K >= 2, `K = ${fit.K}`);
  const want = idealGains(fit.directions);
  fit.gains.forEach((g, k) => assert.ok(Math.abs(g / want[k] - 1) < 0.025, `dir ${fit.directions[k]}: ${g.toFixed(3)} vs ${want[k].toFixed(3)}`));
  const want8 = idealGains([0, 45, 90, 135, 180, 225, 270, 315]);
  fit.gains8.forEach((g, k) => assert.ok(Math.abs(g / want8[k] - 1) < 0.025));
  fit.ci8.forEach(([lo, hi], k) => assert.ok(lo <= fit.gains8[k] + 0.01 && hi >= fit.gains8[k] - 0.01, `ci ${k}`));
  // Overall sensitivity is preserved: geometric mean of the table is 1.
  assert.ok(Math.abs(geoMean(fit.gains) - 1) < 1e-9);
  // The end-type mix is reported, overall and per direction.
  const types = Object.values(fit.endTypes).reduce((s, v) => s + v, 0);
  assert.equal(types, fit.trials);
  fit.bins8.forEach((b) => assert.equal(Object.values(b.endTypes).reduce((s, v) => s + v, 0), b.n));
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

// Slow (about 7 s): the false-pass rate of the gate can only be checked over
// many sessions. 400 unbiased 3-round sessions go through the whole pipeline
// (recording, segmentation, fit) with the bootstrap off.
test('null calibration: the gate rarely passes without a bias and p is uniform (slow)', (t) => {
  const N = 400;
  let passed = 0, below05 = 0, below50 = 0;
  for (let s = 0; s < N; s++) {
    const fit = fitProfile(analyze(session(100000 + s, { rounds: 3, bias: FLAT })), { bootstrap: 0 });
    assert.ok(fit.ok, fit.error);
    if (fit.evidence.passed) passed++;
    if (fit.evidence.p < 0.05) below05++;
    if (fit.evidence.p < 0.5) below50++;
  }
  t.diagnostic(`gate passed ${passed}/${N}, p < 0.05 in ${below05}/${N}, p < 0.5 in ${below50}/${N}`);
  // alpha = 0.01: Binomial(400, 0.01) exceeds 9 with probability 0.008.
  assert.ok(passed <= 9, `gate passed ${passed}/${N}`);
  // Uniform p: Binomial(400, 0.05) has mean 20, sd 4.4; Binomial(400, 0.5) mean 200, sd 10.
  assert.ok(below05 >= 9 && below05 <= 32, `P(p < 0.05) = ${below05}/${N}`);
  assert.ok(below50 >= 170 && below50 <= 230, `P(p < 0.5) = ${below50}/${N}`);
});

test('power: a standard session with the BIAS pattern passes the gate', (t) => {
  let passed = 0;
  for (let seed = 200; seed < 220; seed++) {
    if (fitProfile(analyze(session(seed, { rounds: 6 })), { bootstrap: 0 }).evidence.passed) passed++;
  }
  t.diagnostic(`gate passed ${passed}/20`);
  assert.ok(passed >= 18, `passed ${passed}/20`);
});

test('tracking-safe mode is symmetric', () => {
  const fit = fitProfile(analyze(session(44)), { symmetric: true, strength: 1, bootstrap: 0, nPoints: 16 });
  assert.ok(fit.ok);
  for (let k = 0; k < 8; k++) assert.ok(Math.abs(fit.gains[k] - fit.gains[k + 8]) < 1e-9);
  // Only the even (cos 2 theta) part of BIAS should remain.
  const want = idealGains(fit.directions, (d) => Math.exp(Math.log(1 + 0.03 * Math.cos((2 * d * Math.PI) / 180))));
  fit.gains.forEach((g, k) => assert.ok(Math.abs(g / want[k] - 1) < 0.02, `dir ${k}: ${g} vs ${want[k]}`));
});

test('tracking-safe mode keeps an asymmetric base and only adds a symmetric correction', () => {
  const base = { gains: [0.93, 0.95, 1.0, 1.04, 1.07, 1.05, 1.0, 0.96], linear: false, rotationCdeg: 0 };
  const at = (d) => gainAt(base.gains, d);
  // The base exactly cancels this player's bias, so the data are flat.
  const flat = fitProfile(analyze(session(46, { rounds: 6, bias: (d) => 1 / at(d), applied: base })), { symmetric: true, bootstrap: 0 }, base);
  assert.ok(flat.ok && !flat.evidence.passed, JSON.stringify(flat.evidence));
  assert.deepEqual(flat.gains8, base.gains);
  assert.deepEqual(flat.gains, flat.directions.map(at));
  // With a real even bias on top, the base's left/right difference survives.
  const even = (d) => 1 + 0.05 * Math.cos((2 * d * Math.PI) / 180);
  const fit = fitProfile(analyze(session(47, { rounds: 6, bias: (d) => even(d) / at(d), applied: base })), { symmetric: true, bootstrap: 0 }, base);
  assert.ok(fit.evidence.passed, JSON.stringify(fit.evidence));
  for (let k = 0; k < 8; k++) {
    const d = fit.directions[k];
    assert.ok(Math.abs(fit.gains[k] / fit.gains[k + 8] - at(d) / at(d + 180)) < 1e-9, `dir ${d}`);
  }
});

test('gains are clamped to +-15% by default', () => {
  const big = (d) => 1 + 0.35 * Math.cos((d * Math.PI) / 180);
  const fit = fitProfile(analyze(session(45, { bias: big, rounds: 4 })), { strength: 1, bootstrap: 0 });
  assert.ok(fit.ok, fit.error);
  fit.gains.forEach((g) => assert.ok(Math.abs(Math.log(g)) <= 0.15 + 1e-9, `gain ${g}`));
  assert.ok(Math.abs(geoMean(fit.gains) - 1) < 1e-9);
});

test('refine keeps a base outside +-15%: the cap limits the change, not the gain', () => {
  const base = { gains: Array(16).fill(1.3), linear: false, rotationCdeg: 0 };
  const flat = fitProfile(analyze(session(48, { rounds: 6, bias: FLAT, applied: base })), { bootstrap: 0 }, base);
  assert.ok(flat.ok && !flat.evidence.passed, JSON.stringify(flat.evidence));
  assert.deepEqual(flat.gains, base.gains);
  assert.ok(flat.gains8.every((g) => g === 1.3));
  // A real bias is corrected on top of the 1.30x base, keeping its overall level.
  const biased = fitProfile(analyze(session(49, { rounds: 6, applied: base })), { bootstrap: 0 }, base);
  assert.ok(biased.evidence.passed);
  assert.ok(Math.abs(geoMean(biased.gains) - 1.3) < 1e-9, `geometric mean ${geoMean(biased.gains)}`);
  assert.ok(Math.max(...biased.gains) / Math.min(...biased.gains) > 1.08);
  // Even a large bias moves each gain at most 15% from the base.
  const big = (d) => 1 + 0.35 * Math.cos((d * Math.PI) / 180);
  const capped = fitProfile(analyze(session(50, { rounds: 4, bias: big, applied: base })), { strength: 1, bootstrap: 0 }, base);
  capped.gains.forEach((g) => assert.ok(Math.abs(Math.log(g / 1.3)) <= 0.15 + 1e-9, `gain ${g}`));
  assert.ok(Math.abs(geoMean(capped.gains) - 1.3) < 1e-9);
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
  assert.equal(analyzeTrial({ req: [500, 0], t: [0, 1], x: [0], y: [0] }).reason, 'too-few-samples');
  // Moving the wrong way first.
  const rng = mulberry32(3);
  const wrong = simulateFlick(rng, { theta: 0, dist: 700, noise: 0 });
  wrong.req = [-700, 0];
  assert.equal(analyzeTrial(wrong).ok, false);
});
