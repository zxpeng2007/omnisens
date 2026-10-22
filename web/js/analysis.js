// analysis.js - turns recorded flicks into a directional gain profile.
// Pure functions, no DOM: unit-tested in web/test/analysis.test.mjs.
// The method and its sources are described in docs/ALGORITHM.md section 2.
import { gainAt, vecAngle } from './omni-core.js';

export const SEGMENT_DEFAULTS = {
  minRequiredCounts: 40,  // ignore targets needing less hand travel than this
  cutoffHz: 10,           // zero-phase 2nd-order Butterworth (Roberts et al. 2024)
  onsetFrac: 0.05,        // onset/stop threshold: 5% of peak speed (Fradet et al. 2008)
  vStartDegPerSec: 8,     // absolute onset floor when degPerCount is known (Boudaoud et al. 2022)
  primaryPeakFrac: 0.5,   // the primary submovement is the first speed peak above 50% of the max
  persistMs: 40,          // a submovement event must hold for 40 ms
  carryoverFrac: 0.2,     // reject if already moving at spawn
  minRtMs: 100,           // anticipation
  maxRtMs: 1000,          // lapse
  minPrimaryMs: 40,
  maxPrimaryMs: 600,
  minRatio: 0.5,          // primary extent outside 50-200% of the distance = failed parse
  maxRatio: 2.0,
  maxDirErrDeg: 30,       // initial direction, 100 ms after onset
  maxGapMs: 30,           // no input for this long mid-flick...
  liftSpeedFrac: 0.25,    // ...right after moving faster than this share of peak speed = mouse lifted
  rampMs: 8,              // counts in an event are spread over at most this long before it
};

export const FIT_DEFAULTS = {
  nPoints: 16,
  strength: 0.7,          // lambda: partial correction
  symmetric: false,       // even harmonics only: g(t) = g(t + 180), tracking-safe
  maxLogGain: 0.15,       // |ln g| <= 0.15 (about +-15%)
  bootstrap: 200,
  seed: 12345,
  force: false,           // apply even when the evidence gate fails
  alpha: 0.01,            // Wald test level for the direction terms
  minReliability: 0.5,    // split-half (Spearman-Brown) reliability
  minTrials: 60,
  priorTau: 0.03,         // Gaussian prior SD for a single harmonic (K = 1)
};

// ---------------------------------------------------------------- trials

/**
 * Segment one flick and measure its primary submovement.
 *
 * trial = {
 *   kind: 'out' | 'return',
 *   req: [rx, ry],           // output counts needed from aim-at-spawn to the target centre (HID axes)
 *   t: number[],             // ms since target spawn, increasing; t[0] = 0
 *   x: number[], y: number[], // cumulative output counts since spawn (x[0] = y[0] = 0)
 *   applied: null | { gains, linear, rotationCdeg }  // adapter profile while recording
 *   degPerCount?: number     // optional, enables the absolute onset floor
 * }
 */
export function analyzeTrial(trial, opts = {}) {
  const o = { ...SEGMENT_DEFAULTS, ...opts };
  const fail = (reason) => ({ ok: false, reason, isReturn: trial?.kind === 'return' });
  const { t, x, y } = trial || {};
  if (!t || t.length < 6 || x.length !== t.length || y.length !== t.length) return fail('too-few-samples');
  const reqLen = Math.hypot(trial.req[0], trial.req[1]);
  if (!(reqLen >= o.minRequiredCounts)) return fail('target-too-close');

  const T = Math.floor(t[t.length - 1]);
  if (T < 100) return fail('too-short');
  const [px, py] = resample(t, x, y, T, o.rampMs);
  const fx = lowpass(px, o.cutoffHz, 1000), fy = lowpass(py, o.cutoffHz, 1000);
  const vx = deriv(fx), vy = deriv(fy);
  const sp = new Float64Array(T + 1);
  let vmax = 0;
  for (let i = 0; i <= T; i++) { sp[i] = Math.hypot(vx[i], vy[i]); if (sp[i] > vmax) vmax = sp[i]; }
  if (vmax <= 0) return fail('no-movement');

  // Primary peak: the first local speed maximum that reaches half the trial maximum.
  let iPeak = -1;
  for (let i = 1; i < T; i++) {
    if (sp[i] >= o.primaryPeakFrac * vmax && sp[i] >= sp[i - 1] && sp[i] >= sp[i + 1]) { iPeak = i; break; }
  }
  if (iPeak < 0) return fail('no-movement');
  const peak = sp[iPeak];
  const vStart = trial.degPerCount > 0 ? o.vStartDegPerSec / 1000 / trial.degPerCount : 0;
  if (vStart > 0 && peak < 3 * vStart) return fail('too-slow');
  if (sp[0] > o.carryoverFrac * peak) return fail('moving-at-spawn');

  const vOn = Math.max(o.onsetFrac * peak, vStart);
  let iOn = iPeak;
  while (iOn > 0 && sp[iOn - 1] >= vOn) iOn--;
  for (let i = iOn; i < Math.min(T, iOn + o.persistMs); i++) if (sp[i] < vOn) return fail('blip');
  if (iOn < o.minRtMs) return fail('anticipated');
  if (iOn > o.maxRtMs) return fail('late-start');

  // The remaining requirement at onset defines the movement axis.
  const ex = trial.req[0] - fx[iOn], ey = trial.req[1] - fy[iOn];
  const eLen = Math.hypot(ex, ey);
  if (eLen < o.minRequiredCounts) return fail('target-too-close');
  const ux = ex / eLen, uy = ey / eLen;
  const va = new Float64Array(T + 1);
  for (let i = 0; i <= T; i++) va[i] = vx[i] * ux + vy[i] * uy;
  const aa = deriv(va), ja = deriv(aa);

  // Peak deceleration between the speed peak and the first stop.
  const stopLevel = o.onsetFrac * peak;
  let iStop = iPeak;
  while (iStop < T && sp[iStop] >= stopLevel) iStop++;
  let iDec = iPeak;
  for (let i = iPeak; i <= iStop; i++) if (aa[i] < aa[iDec]) iDec = i;

  // End of the primary submovement: first event after peak deceleration that
  // persists (Meyer et al. 1988; Roberts et al. 2024): velocity reversal (type 1),
  // re-acceleration (type 2), braking discontinuity in jerk (type 3), or a stop.
  const holds = (from, pred) => {
    for (let k = from; k <= Math.min(T, from + o.persistMs - 1); k++) if (!pred(k)) return false;
    return true;
  };
  let iEnd = -1, endType = '';
  for (let i = iDec + 1; i <= T && iEnd < 0; i++) {
    if (va[i - 1] > 0 && va[i] <= 0 && holds(i, (k) => va[k] <= 0)) { iEnd = i; endType = 'reversal'; }
    else if (aa[i - 1] < 0 && aa[i] >= 0 && holds(i, (k) => aa[k] >= 0)) { iEnd = i; endType = 'reacceleration'; }
    else if (ja[i - 1] > 0 && ja[i] <= 0 && holds(i, (k) => ja[k] <= 0)) { iEnd = i; endType = 'jerk'; }
    else if (sp[i] < stopLevel && holds(i, (k) => sp[k] < stopLevel)) { iEnd = i; endType = 'stop'; }
  }
  if (iEnd < 0) return fail('no-clear-end');
  const dur = iEnd - iOn;
  if (dur < o.minPrimaryMs) return fail('too-brief');
  if (dur > o.maxPrimaryMs) return fail('no-clear-end');

  // Mouse lifted mid-flick: input stops for a while although the hand was
  // moving fast just before. (A mouse sends nothing while it is still, so
  // gaps alone are normal: before the flick and between submovements.)
  for (let k = 1; k < t.length; k++) {
    if (t[k] - t[k - 1] <= o.maxGapMs || t[k - 1] < iOn || t[k - 1] >= iEnd) continue;
    const a = Math.floor(t[k - 1]), b = Math.max(0, a - 10);
    const vBefore = Math.hypot(px[a] - px[b], py[a] - py[b]) / Math.max(1, a - b);
    if (vBefore > o.liftSpeedFrac * peak) return fail('mouse-lifted');
  }

  // Initial direction 100 ms after onset must point at the target.
  const j = Math.min(iOn + 100, iEnd);
  const dx0 = fx[j] - fx[iOn], dy0 = fy[j] - fy[iOn], d0 = Math.hypot(dx0, dy0);
  if (d0 > 2) {
    const cos = (dx0 * ux + dy0 * uy) / d0;
    if (cos < Math.cos((o.maxDirErrDeg * Math.PI) / 180)) return fail('misdirected');
  }

  const mx = fx[iEnd] - fx[iOn], my = fy[iEnd] - fy[iOn];
  const along = mx * ux + my * uy;
  const lateral = -mx * uy + my * ux;
  const ratio = along / eLen;
  if (!(ratio >= o.minRatio && ratio <= o.maxRatio)) return fail('implausible-ratio');

  // Hand-space direction: the adapter rotates its output by rotationCdeg.
  const rot = trial.applied ? (trial.applied.rotationCdeg || 0) / 100 : 0;
  const theta = wrap360(vecAngle(ex, ey) - rot);
  const appliedGain = trial.applied ? gainAt(trial.applied.gains, theta, !!trial.applied.linear) : 1;

  return {
    ok: true,
    isReturn: trial.kind === 'return',
    theta,              // hand movement direction, degrees CCW from right
    dist: eLen,         // output counts required
    ratio,              // primary-submovement extent / required (1 = perfect)
    appliedGain,
    appliedProfile: trial.applied || null,
    lateral: lateral / eLen,
    onsetMs: iOn,
    primaryMs: dur,
    peakSpeed: peak,    // counts/ms
    endType,
    ampDeg: trial.ampDeg,
  };
}

/**
 * Cumulative position on a 1 ms grid. Mice only send events while moving, so
 * between events the position holds, and an event's counts are spread over
 * at most rampMs before it (one report interval at 125 Hz or faster).
 */
function resample(t, x, y, T, rampMs) {
  const px = new Float64Array(T + 1), py = new Float64Array(T + 1);
  let j = 0;
  for (let ms = 0; ms <= T; ms++) {
    while (j < t.length - 2 && t[j + 1] < ms) j++;
    const t1 = t[j + 1], ramp = Math.min(t1 - t[j], rampMs);
    const f = ramp > 0 ? Math.min(1, Math.max(0, (ms - (t1 - ramp)) / ramp)) : 1;
    px[ms] = x[j] + (x[j + 1] - x[j]) * f;
    py[ms] = y[j] + (y[j + 1] - y[j]) * f;
  }
  return [px, py];
}

/** Zero-phase (forward-backward) 2nd-order Butterworth low-pass, odd-reflection padded. */
export function lowpass(sig, fc, fs) {
  const n = sig.length;
  if (n < 3) return Float64Array.from(sig);
  const K = Math.tan((Math.PI * fc) / fs), K2 = K * K, norm = 1 / (1 + Math.SQRT2 * K + K2);
  const b0 = K2 * norm, b1 = 2 * b0, b2 = b0;
  const a1 = 2 * (K2 - 1) * norm, a2 = (1 - Math.SQRT2 * K + K2) * norm;
  const pad = Math.min(n - 1, 300);
  const ext = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) ext[i] = 2 * sig[0] - sig[pad - i];
  for (let i = 0; i < n; i++) ext[pad + i] = sig[i];
  for (let i = 0; i < pad; i++) ext[pad + n + i] = 2 * sig[n - 1] - sig[n - 2 - i];
  const run = () => {
    let x1 = ext[0], x2 = ext[0], y1 = ext[0], y2 = ext[0];
    for (let i = 0; i < ext.length; i++) {
      const v = b0 * ext[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = ext[i]; y2 = y1; y1 = v; ext[i] = v;
    }
  };
  run(); ext.reverse(); run(); ext.reverse();
  return ext.slice(pad, pad + n);
}

function deriv(p) {
  const n = p.length, v = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) v[i] = (p[i + 1] - p[i - 1]) / 2;
  if (n > 1) { v[0] = p[1] - p[0]; v[n - 1] = p[n - 1] - p[n - 2]; }
  return v;
}

const wrap360 = (a) => ((a % 360) + 360) % 360;

// ---------------------------------------------------------------- fitting

const HARMONIC_SETS = { full: [[], [1], [1, 2], [1, 2, 3]], symmetric: [[], [2]] };
const fitCache = new WeakMap();

/**
 * Fit a smooth periodic bias curve to analysed flicks and turn it into gains.
 * results: analyzeTrial() outputs (failed ones are counted, then skipped).
 * current: { gains, linear } the profile the user runs now, for comparison (null = flat).
 * The correction is applied on top of the profile that was active while recording.
 */
export function fitProfile(results, opts = {}, current = null) {
  const o = { ...FIT_DEFAULTS, ...opts };
  const all = results.filter(Boolean);
  const ok = all.filter((r) => r.ok);
  const out = {
    ok: false,
    trials: ok.length,
    rejected: rejectionSummary(all),
    rejectedFrac: all.length ? (all.length - ok.length) / all.length : 0,
    warnings: [],
  };
  if (ok.length < o.minTrials) {
    out.error = `Need at least ${o.minTrials} usable flicks, have ${ok.length}. Run more rounds.`;
    return out;
  }
  if (out.rejectedFrac > 0.25) {
    out.warnings.push(`${Math.round(out.rejectedFrac * 100)}% of flicks could not be measured. Flick at each target in one motion and avoid lifting the mouse mid-flick.`);
  }

  const data = prepare(ok);
  const base = data.base;
  const baseLog = (th) => {
    const g = (a) => (base ? Math.log(gainAt(base.gains, a, !!base.linear)) : 0);
    return o.symmetric ? 0.5 * (g(th) + g(th + 180)) : g(th);
  };
  const curGain = (th) => (current ? gainAt(current.gains, th, !!current.linear) : base ? gainAt(base.gains, th, !!base.linear) : 1);

  // Fits depend only on the data and the harmonic family; cache them so
  // strength / resolution / force changes in the UI are instant.
  let cache = fitCache.get(results);
  if (!cache) { cache = new Map(); fitCache.set(results, cache); }
  const key = `${o.symmetric ? 's' : 'f'}|${o.bootstrap}|${o.seed}|${o.alpha}|${o.priorTau}`;
  let fits = cache.get(key);
  if (!fits) {
    const sets = o.symmetric ? HARMONIC_SETS.symmetric : HARMONIC_SETS.full;
    const main = selectModel(data, sets, o);
    main.reliability = main.harmonics.length ? splitHalf(data, main.harmonics) : 0;
    const boots = [];
    const rng = mulberry32(o.seed);
    for (let b = 0; b < o.bootstrap; b++) {
      const idx = stratifiedResample(data, rng);
      boots.push(selectModel(subset(data, idx), sets, o));
    }
    fits = { main, boots };
    cache.set(key, fits);
  }
  const { main, boots } = fits;

  const passed = main.harmonics.length > 0 && main.p < o.alpha && main.reliability >= o.minReliability;
  const apply = passed || o.force;
  out.ok = true;
  out.K = main.harmonics.length ? Math.max(...main.harmonics) : 0;
  out.harmonics = main.harmonics;
  out.evidence = { wald: main.wald, df: main.df, p: main.p, reliability: main.reliability, passed };
  out.shrink = main.shrink;
  out.applied = apply;
  out.sigma = main.sigma;
  out.rangeSlope = main.beta[1];
  out.returnOffset = data.hasReturn ? main.beta[2] : null;
  out.overallRatio = Math.exp(median(ok.map((r) => Math.log(r.ratio))));

  const gainsFor = (fit, dirs) => {
    // Bootstrap refits use the Wald gate only (the split-half check is too costly per resample).
    const doApply = fit === main ? apply : o.force || (fit.harmonics.length > 0 && fit.p < o.alpha);
    let lg = dirs.map((d) => baseLog(d) - (doApply ? o.strength * curveValue(fit, d, true) : 0));
    // Keep the overall sensitivity: mean log gain over the circle equals the base's.
    const target = mean(dirs.map(baseLog));
    for (let pass = 0; pass < 2; pass++) {
      const shift = target - mean(lg);
      lg = lg.map((v) => Math.max(-o.maxLogGain, Math.min(o.maxLogGain, v + shift)));
    }
    return lg.map(Math.exp);
  };

  const dirs = Array.from({ length: o.nPoints }, (_, k) => (k * 360) / o.nPoints);
  const dirs8 = Array.from({ length: 8 }, (_, k) => k * 45);
  out.nPoints = o.nPoints;
  out.directions = dirs;
  out.gains = gainsFor(main, dirs);
  out.gains8 = gainsFor(main, dirs8);
  out.baseGains8 = dirs8.map((d) => curGainBase(base, d));
  out.currentGains8 = dirs8.map(curGain);
  out.bias8 = dirs8.map((d) => 100 * (Math.exp(curveValue(main, d, false)) - 1));

  const bootGains = boots.map((f) => gainsFor(f, dirs));
  const bootGains8 = boots.map((f) => gainsFor(f, dirs8));
  const ciOf = (samples, k) => (samples.length ? [quantile(samples.map((g) => g[k]), 0.05), quantile(samples.map((g) => g[k]), 0.95)] : [null, null]);
  out.ci = dirs.map((_, k) => ciOf(bootGains, k));
  out.ci8 = dirs8.map((_, k) => ciOf(bootGains8, k));

  out.bins8 = dirs8.map((d) => {
    const inBin = ok.filter((r) => angDist(r.theta, d) <= 22.5);
    return { theta: d, n: inBin.length, medianRatio: inBin.length ? median(inBin.map((r) => r.ratio)) : null };
  });

  out.curve = [];
  const recCurve = gainsFor(main, Array.from({ length: 121 }, (_, i) => i * 3));
  for (let i = 0; i <= 120; i++) {
    const th = i * 3;
    out.curve.push({
      theta: th,
      ratio: Math.exp(main.beta[0] + curveValue(main, th, false)),
      current: curGain(th),
      recommended: recCurve[i],
    });
  }

  if (!passed) {
    out.warnings.push(main.harmonics.length === 0
      ? 'No directional pattern stood out from normal flick-to-flick variation.'
      : `The directional pattern is not reliable enough yet (p = ${fmtP(main.p)}, split-half reliability ${main.reliability.toFixed(2)}; needs p < ${o.alpha} and >= ${o.minReliability}).`);
  }
  out.bins8.forEach((b) => {
    if (b.n < 12) out.warnings.push(`Only ${b.n} usable flicks near ${b.theta}°.`);
  });
  const maxWidth = Math.max(...out.ci8.map(([lo, hi]) => (lo === null ? 0 : hi - lo)));
  if (apply && maxWidth > 0.08) out.warnings.push(`Some values are still uncertain (90% range up to ${(maxWidth * 100).toFixed(0)}%). More rounds will tighten them.`);
  return out;
}

function curGainBase(base, d) { return base ? gainAt(base.gains, d, !!base.linear) : 1; }

function fmtP(p) { return p < 0.001 ? '< 0.001' : p.toFixed(3); }

/** Direction-dependent part of a fit at angle th (deg); shrunk = with shrinkage applied. */
function curveValue(fit, th, shrunk) {
  const coefs = shrunk ? fit.dirShrunk : fit.dirBeta;
  const a = (th * Math.PI) / 180;
  let s = 0;
  fit.harmonics.forEach((h, i) => { s += coefs[2 * i] * Math.cos(h * a) + coefs[2 * i + 1] * Math.sin(h * a); });
  return s;
}

/** Flattens analysed flicks into regression inputs. y = ln(ratio) relative to the base profile. */
function prepare(ok) {
  // The base is the profile that was active while recording (normally one per session).
  const withProfile = ok.filter((r) => r.appliedProfile);
  const base = withProfile.length * 2 > ok.length ? withProfile[0].appliedProfile : null;
  const n = ok.length;
  const theta = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n), ret = new Float64Array(n);
  const medD = median(ok.map((r) => r.dist));
  let nRet = 0;
  ok.forEach((r, i) => {
    theta[i] = r.theta;
    // ln ratio measured with the applied gain, re-expressed on top of the base profile.
    const baseG = base ? gainAt(base.gains, r.theta, !!base.linear) : 1;
    y[i] = Math.log(r.ratio) - Math.log(r.appliedGain || 1) + Math.log(baseG);
    z[i] = Math.log(r.dist / medD);
    ret[i] = r.isReturn ? 1 : 0;
    nRet += ret[i];
  });
  const hasReturn = nRet >= 10 && n - nRet >= 10;
  // Distance terciles: extent noise grows with distance, so scale is estimated per stratum.
  const zs = [...z].sort((a, b) => a - b);
  const c1 = zs[Math.floor(n / 3)], c2 = zs[Math.floor((2 * n) / 3)];
  const stratum = Int32Array.from(z, (v) => (v < c1 ? 0 : v < c2 ? 1 : 2));
  const dirBin = Int32Array.from(theta, (v) => Math.floor(wrap360(v + 11.25) / 22.5) % 16);
  return { n, theta, y, z, ret, hasReturn, stratum, dirBin, base };
}

function subset(d, idx) {
  const pick = (arr, Ctor) => Ctor.from(idx, (i) => arr[i]);
  const ret = pick(d.ret, Float64Array);
  const nRet = ret.reduce((s, v) => s + v, 0);
  return {
    n: idx.length,
    theta: pick(d.theta, Float64Array), y: pick(d.y, Float64Array), z: pick(d.z, Float64Array),
    ret, hasReturn: d.hasReturn && nRet >= 10 && idx.length - nRet >= 10,
    stratum: pick(d.stratum, Int32Array), dirBin: pick(d.dirBin, Int32Array), base: d.base,
  };
}

/** Trial indices grouped by (direction bin x distance stratum) cell. */
function cells(d) {
  const map = new Map();
  for (let i = 0; i < d.n; i++) {
    const k = d.dirBin[i] * 3 + d.stratum[i];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }
  return map;
}

/** Bootstrap indices resampled within (direction bin x distance stratum) cells. */
function stratifiedResample(d, rng) {
  const idx = [];
  for (const members of cells(d).values()) {
    for (let j = 0; j < members.length; j++) idx.push(members[Math.floor(rng() * members.length)]);
  }
  return idx;
}

function designMatrix(d, harmonics) {
  const p = 2 + (d.hasReturn ? 1 : 0) + 2 * harmonics.length;
  const X = new Float64Array(d.n * p);
  for (let i = 0; i < d.n; i++) {
    const row = i * p, a = (d.theta[i] * Math.PI) / 180;
    let c = 0;
    X[row + c++] = 1;
    X[row + c++] = d.z[i];
    if (d.hasReturn) X[row + c++] = d.ret[i];
    for (const h of harmonics) { X[row + c++] = Math.cos(h * a); X[row + c++] = Math.sin(h * a); }
  }
  return { X, p, dirStart: 2 + (d.hasReturn ? 1 : 0) };
}

/** Chooses the harmonic set by BIC, then computes the Wald test and shrinkage for it. */
function selectModel(d, sets, o) {
  let best = null;
  for (const harmonics of sets) {
    const { X, p, dirStart } = designMatrix(d, harmonics);
    const f = robustFit(X, d.y, d.n, p, d.stratum);
    if (!f) continue;
    // Raw (not standardised) residual variance: each model re-estimates its own scale.
    const bic = d.n * Math.log(f.rawSigma2) + p * Math.log(d.n);
    if (!best || bic < best.bic) best = { harmonics, bic, p, dirStart, ...f };
  }
  if (!best) return { harmonics: [], beta: [0, 0, 0], dirBeta: [], dirShrunk: [], wald: 0, df: 0, p: 1, shrink: 0, sigma: NaN };

  const nd = 2 * best.harmonics.length;
  const dirBeta = best.beta.slice(best.dirStart, best.dirStart + nd);
  let wald = 0, pval = 1, shrink = 0, dirShrunk = dirBeta.map(() => 0);
  if (nd > 0) {
    const V = submatrix(best.cov, best.p, best.dirStart, nd);
    const Vinv = invert(V, nd);
    if (Vinv) {
      for (let a = 0; a < nd; a++) for (let b = 0; b < nd; b++) wald += dirBeta[a] * Vinv[a * nd + b] * dirBeta[b];
      pval = chi2SurvivalEven(wald, nd);
    }
    if (nd > 2) {
      // Positive-part James-Stein toward "no directional effect".
      shrink = wald > 0 ? Math.max(0, 1 - (nd - 2) / wald) : 0;
      dirShrunk = dirBeta.map((v) => v * shrink);
    } else {
      // One harmonic: Gaussian prior with SD priorTau on each coefficient.
      const t2 = o.priorTau * o.priorTau;
      const f = dirBeta.map((_, j) => t2 / (t2 + V[j * nd + j]));
      dirShrunk = dirBeta.map((v, j) => v * f[j]);
      shrink = (f[0] + f[1]) / 2;
    }
  }
  return {
    harmonics: best.harmonics, beta: best.beta, dirBeta, dirShrunk,
    wald, df: nd, p: pval, shrink, sigma: Math.sqrt(best.rawSigma2),
  };
}

/** Split-half reliability of the direction curve, Spearman-Brown corrected. */
function splitHalf(d, harmonics) {
  // Alternate within each (direction x distance) cell so both halves cover every direction.
  const halves = [[], []];
  for (const members of cells(d).values()) members.forEach((i, j) => halves[j % 2].push(i));
  halves.forEach((h) => h.sort((a, b) => a - b));
  const curves = halves.map((idx) => {
    const s = subset(d, idx);
    const { X, p, dirStart } = designMatrix(s, harmonics);
    const f = robustFit(X, s.y, s.n, p, s.stratum);
    if (!f) return null;
    const coefs = f.beta.slice(dirStart);
    return Array.from({ length: 32 }, (_, k) => curveValue({ harmonics, dirBeta: coefs }, k * 11.25, false));
  });
  if (!curves[0] || !curves[1]) return 0;
  const r = pearson(curves[0], curves[1]);
  return r <= -0.999 ? -1 : (2 * r) / (1 + r);
}

/**
 * M-estimation by IRLS: OLS start, Huber (t = 1.345) with per-stratum MAD scale,
 * then Tukey bisquare (c = 4.685) with that scale held fixed.
 * Returns beta, an approximate covariance, and weighted residual variances.
 */
function robustFit(X, y, n, p, stratum) {
  const w = new Float64Array(n).fill(1);
  let beta = wls(X, y, w, n, p);
  if (!beta) return null;
  let resid = residuals(X, y, beta, n, p);
  let scale = stratumScale(resid, stratum, w);

  const irls = (psiWeight) => {
    for (let iter = 0; iter < 50; iter++) {
      for (let i = 0; i < n; i++) {
        const s = scale[stratum[i]];
        w[i] = psiWeight(resid[i] / s) / (s * s);
      }
      const next = wls(X, y, w, n, p);
      if (!next) return false;
      let change = 0, size = 0;
      for (let k = 0; k < p; k++) { change = Math.max(change, Math.abs(next[k] - beta[k])); size = Math.max(size, Math.abs(next[k])); }
      beta = next;
      resid = residuals(X, y, beta, n, p);
      if (change <= 1e-6 * Math.max(1, size)) break;
    }
    return true;
  };
  const huber = (z) => (Math.abs(z) <= 1.345 ? 1 : 1.345 / Math.abs(z));
  const bisquare = (z) => { const u = z / 4.685; return Math.abs(u) < 1 ? (1 - u * u) ** 2 : 0; };
  if (!irls(huber)) return null;
  scale = stratumScale(resid, stratum, null);
  if (!irls(bisquare)) return null;

  // Standardised weighted residual variance (about 1 for a good model) for BIC and covariance.
  let num = 0, den = 0, raw = 0, rawDen = 0;
  for (let i = 0; i < n; i++) {
    const s = scale[stratum[i]], rw = bisquare(resid[i] / s);
    num += rw * (resid[i] / s) ** 2; den += rw;
    raw += rw * resid[i] ** 2; rawDen += rw;
  }
  const sigma2 = Math.max(1e-12, num / Math.max(1, den));
  const A = normalMatrix(X, w, n, p);
  const Ainv = invert(A, p);
  if (!Ainv) return null;
  const phi = num / Math.max(1, den - p);
  return { beta, cov: Ainv.map((v) => v * phi), sigma2, rawSigma2: raw / Math.max(1, rawDen) };
}

function stratumScale(resid, stratum, w) {
  const groups = [[], [], []];
  for (let i = 0; i < resid.length; i++) if (!w || w[i] > 0) groups[stratum[i]].push(resid[i]);
  const all = [...resid];
  const fallback = Math.max(1e-3, mad(all) / 0.6745);
  return groups.map((g) => (g.length >= 8 ? Math.max(1e-3, mad(g) / 0.6745) : fallback));
}

function mad(a) {
  const m = median(a);
  return median(a.map((v) => Math.abs(v - m)));
}

function normalMatrix(X, w, n, p) {
  const A = new Float64Array(p * p);
  for (let i = 0; i < n; i++) {
    const row = i * p, wi = w[i];
    if (wi === 0) continue;
    for (let a = 0; a < p; a++) {
      const xa = X[row + a] * wi;
      for (let b = a; b < p; b++) A[a * p + b] += xa * X[row + b];
    }
  }
  for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) A[a * p + b] = A[b * p + a];
  return A;
}

function wls(X, y, w, n, p) {
  const A = normalMatrix(X, w, n, p);
  const rhs = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    const row = i * p, wy = w[i] * y[i];
    for (let a = 0; a < p; a++) rhs[a] += X[row + a] * wy;
  }
  return solve(A, rhs, p);
}

function residuals(X, y, beta, n, p) {
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let a = 0; a < p; a++) s += X[i * p + a] * beta[a];
    r[i] = y[i] - s;
  }
  return r;
}

function submatrix(M, p, start, k) {
  const S = new Float64Array(k * k);
  for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) S[a * k + b] = M[(start + a) * p + start + b];
  return S;
}

/** Gaussian elimination with partial pivoting on a p x p system; null if singular. */
function solve(A0, b0, p) {
  const A = Float64Array.from(A0), b = Float64Array.from(b0);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r * p + c]) > Math.abs(A[piv * p + c])) piv = r;
    if (Math.abs(A[piv * p + c]) < 1e-12) return null;
    if (piv !== c) {
      for (let k = 0; k < p; k++) { const tmp = A[c * p + k]; A[c * p + k] = A[piv * p + k]; A[piv * p + k] = tmp; }
      const tb = b[c]; b[c] = b[piv]; b[piv] = tb;
    }
    for (let r = c + 1; r < p; r++) {
      const f = A[r * p + c] / A[c * p + c];
      if (f === 0) continue;
      for (let k = c; k < p; k++) A[r * p + k] -= f * A[c * p + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(p).fill(0);
  for (let r = p - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < p; k++) s -= A[r * p + k] * x[k];
    x[r] = s / A[r * p + r];
  }
  return x;
}

function invert(M, p) {
  const inv = new Float64Array(p * p);
  for (let c = 0; c < p; c++) {
    const e = new Float64Array(p);
    e[c] = 1;
    const col = solve(M, e, p);
    if (!col) return null;
    for (let r = 0; r < p; r++) inv[r * p + c] = col[r];
  }
  return inv;
}

/** P(chi-square with an even number of degrees of freedom > x), closed form. */
export function chi2SurvivalEven(x, df) {
  if (x <= 0) return 1;
  let term = 1, sum = 1;
  for (let j = 1; j < df / 2; j++) { term *= x / 2 / j; sum += term; }
  return Math.min(1, Math.exp(-x / 2) * sum);
}

// ---------------------------------------------------------------- helpers

export function median(a) { return quantile(a, 0.5); }

export function quantile(a, q) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort(), pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function pearson(a, b) {
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const angDist = (a, b) => { const d = Math.abs(wrap360(a) - wrap360(b)); return d > 180 ? 360 - d : d; };

export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/** Why flicks were rejected, for the results screen: { reason: count }. */
export function rejectionSummary(results) {
  const counts = {};
  for (const r of results) if (r && !r.ok) counts[r.reason] = (counts[r.reason] || 0) + 1;
  return counts;
}
