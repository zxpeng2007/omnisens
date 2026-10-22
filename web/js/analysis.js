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
  persistMs: 40,          // a velocity reversal or a stop must hold for 40 ms
  persistAccelMs: 12,     // re-acceleration and jerk events only 12 ms: a correction that
                          // overlaps the primary's tail flips their sign only briefly
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
  symmetric: false,       // even harmonics only: the correction is the same at t and t + 180 (tracking-safe)
  maxLogGain: 0.15,       // each refinement changes ln g by at most 0.15 (about +-15%)
  bootstrap: 200,
  seed: 12345,
  force: false,           // apply even when the evidence gate fails
  alpha: 0.01,            // level of the F test on all direction terms of the largest model
  minReplication: 0.5,    // two-fold replication: b_A.b_B / max(|b_A|^2, |b_B|^2) must exceed this
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
 *   endMs?: number,          // click or timeout time; the series must reach it (a held
 *                            // sample is added here when it does not, e.g. older sessions)
 *   hitMs?: number | null,   // click time, used when endMs is missing
 *   applied: null | { gains, linear, rotationCdeg }  // adapter profile while recording
 *   degPerCount?: number     // optional, enables the absolute onset floor
 * }
 */
export function analyzeTrial(trial, opts = {}) {
  const o = { ...SEGMENT_DEFAULTS, ...opts };
  const fail = (reason) => ({ ok: false, reason, isReturn: trial?.kind === 'return' });
  let { t, x, y } = trial || {};
  if (!t || !x || !y || x.length !== t.length || y.length !== t.length) return fail('too-few-samples');
  // A mouse sends nothing while still, so without a sample at the click the
  // series stops mid-deceleration and a flick that landed in one movement
  // would never seem to end. Hold the last position until the click.
  const endMs = trial.endMs ?? trial.hitMs;
  if (t.length && Number.isFinite(endMs) && endMs > t[t.length - 1]) {
    t = [...t, endMs];
    x = [...x, x[x.length - 1]];
    y = [...y, y[y.length - 1]];
  }
  if (t.length < 6) return fail('too-few-samples');
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
  const holds = (from, ms, pred) => {
    for (let k = from; k <= Math.min(T, from + ms - 1); k++) if (!pred(k)) return false;
    return true;
  };
  let iEnd = -1, endType = '';
  for (let i = iDec + 1; i <= T && iEnd < 0; i++) {
    if (va[i - 1] > 0 && va[i] <= 0 && holds(i, o.persistMs, (k) => va[k] <= 0)) { iEnd = i; endType = 'reversal'; }
    else if (aa[i - 1] < 0 && aa[i] >= 0 && holds(i, o.persistAccelMs, (k) => aa[k] >= 0)) { iEnd = i; endType = 'reacceleration'; }
    else if (ja[i - 1] > 0 && ja[i] <= 0 && holds(i, o.persistAccelMs, (k) => ja[k] <= 0)) { iEnd = i; endType = 'jerk'; }
    else if (sp[i] < stopLevel && holds(i, o.persistMs, (k) => sp[k] < stopLevel)) { iEnd = i; endType = 'stop'; }
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
    endType,            // 'reversal' | 'reacceleration' | 'jerk' | 'stop'
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
const END_TYPES = ['reversal', 'reacceleration', 'jerk', 'stop'];
const fitCache = new WeakMap();

/**
 * Fit a smooth periodic bias curve to analysed flicks and turn it into gains.
 * results: analyzeTrial() outputs (failed ones are counted, then skipped).
 * current: { gains, linear } the profile the user runs now, for comparison (null = flat).
 * The correction is applied on top of the profile that was active while recording;
 * when it is not applied the gains are that profile, unchanged.
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
  const baseAt = (th) => curGainBase(base, th);
  const curGain = (th) => (current ? gainAt(current.gains, th, !!current.linear) : baseAt(th));

  // Fits depend only on the data and the harmonic family; cache them so
  // strength / resolution / force changes in the UI are instant.
  let cache = fitCache.get(results);
  if (!cache) { cache = new Map(); fitCache.set(results, cache); }
  const key = `${o.symmetric ? 's' : 'f'}|${o.bootstrap}|${o.seed}|${o.alpha}|${o.priorTau}`;
  let fits = cache.get(key);
  if (!fits) {
    const sets = o.symmetric ? HARMONIC_SETS.symmetric : HARMONIC_SETS.full;
    const main = selectModel(data, sets, o);
    main.reliability = main.harmonics.length ? replication(data, main.harmonics, main.scale) : 0;
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

  const passed = main.harmonics.length > 0 && main.p < o.alpha && main.reliability > o.minReplication;
  const apply = passed || o.force;
  out.ok = true;
  out.K = main.harmonics.length ? Math.max(...main.harmonics) : 0;
  out.harmonics = main.harmonics;
  out.evidence = {
    wald: main.wald, df: main.df, df2: main.df2, p: main.p,
    reliability: main.reliability, replicationThreshold: o.minReplication, passed,
  };
  out.shrink = main.shrink;
  out.applied = apply;
  out.sigma = main.sigma;
  out.rangeSlope = main.beta[1];
  out.returnOffset = data.hasReturn ? main.beta[2] : null;
  out.overallRatio = Math.exp(median(ok.map((r) => Math.log(r.ratio))));
  out.endTypes = endTypeCounts(ok);

  const gainsFor = (fit, dirs) => {
    // Bootstrap refits use the F test only (the replication check is too costly per resample).
    const doApply = fit === main ? apply : o.force || (fit.harmonics.length > 0 && fit.p < o.alpha);
    if (!doApply || !fit.harmonics.length) return dirs.map(baseAt);
    // Only the change is limited, never the base: it averages zero in log
    // space (overall sensitivity stays the base's) and is capped per direction.
    const delta = dirs.map((d) => -o.strength * curveValue(fit, d, true));
    const shift = centringShift(delta, o.maxLogGain);
    return dirs.map((d, k) => baseAt(d) * Math.exp(clampAbs(delta[k] + shift, o.maxLogGain)));
  };

  const dirs = Array.from({ length: o.nPoints }, (_, k) => (k * 360) / o.nPoints);
  const dirs8 = Array.from({ length: 8 }, (_, k) => k * 45);
  out.nPoints = o.nPoints;
  out.directions = dirs;
  out.gains = gainsFor(main, dirs);
  out.gains8 = gainsFor(main, dirs8);
  out.baseGains8 = dirs8.map(baseAt);
  out.currentGains8 = dirs8.map(curGain);
  out.bias8 = dirs8.map((d) => 100 * (Math.exp(curveValue(main, d, false)) - 1));

  const bootGains = boots.map((f) => gainsFor(f, dirs));
  const bootGains8 = boots.map((f) => gainsFor(f, dirs8));
  const ciOf = (samples, k) => (samples.length ? [quantile(samples.map((g) => g[k]), 0.05), quantile(samples.map((g) => g[k]), 0.95)] : [null, null]);
  out.ci = dirs.map((_, k) => ciOf(bootGains, k));
  out.ci8 = dirs8.map((_, k) => ciOf(bootGains8, k));

  out.bins8 = dirs8.map((d) => {
    const inBin = ok.filter((r) => angDist(r.theta, d) <= 22.5);
    return {
      theta: d,
      n: inBin.length,
      medianRatio: inBin.length ? median(inBin.map((r) => r.ratio)) : null,
      endTypes: endTypeCounts(inBin),
    };
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
      : `The directional pattern is not reliable enough yet (p = ${fmtP(main.p)}, needs < ${o.alpha}; replication between two halves of your flicks ${main.reliability.toFixed(2)}, needs > ${o.minReplication}).`);
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

const clampAbs = (v, m) => Math.max(-m, Math.min(m, v));

/** Shift s so that mean(clamp(delta + s)) = 0: the clamp must not move the overall level. */
function centringShift(delta, m) {
  let s = -mean(delta);
  if (delta.every((v) => Math.abs(v + s) <= m)) return s;
  // mean(clamp(delta + s)) rises monotonically with s; bisect for its zero.
  let lo = -m - Math.max(...delta), hi = m - Math.min(...delta);
  for (let it = 0; it < 100; it++) {
    s = (lo + hi) / 2;
    if (mean(delta.map((v) => clampAbs(v + s, m))) < 0) lo = s; else hi = s;
  }
  return s;
}

function endTypeCounts(rs) {
  const c = Object.fromEntries(END_TYPES.map((k) => [k, 0]));
  for (const r of rs) if (r.endType in c) c[r.endType]++;
  return c;
}

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

// A fresh object each time: fitProfile adds fields to the main fit.
const noFit = () => ({ harmonics: [], beta: [0, 0, 0], dirBeta: [], dirShrunk: [], wald: 0, df: 0, df2: 0, p: 1, shrink: 0, sigma: NaN, scale: null });

/**
 * Evidence first, then shape. The evidence is an F test on every direction
 * term of the largest candidate model, so its level does not depend on the
 * model choice. The harmonic set is then chosen by a robust BIC; once the
 * test has rejected "no directional effect", the empty set is not a candidate.
 */
function selectModel(d, sets, o) {
  const largest = sets[sets.length - 1];
  // One noise scale per distance band, shared by every candidate: comparing
  // losses is only meaningful when they are measured on the same yardstick.
  const scale = pilotScale(d, largest);
  if (!scale) return noFit();
  const fits = [];
  for (const harmonics of sets) {
    const dm = designMatrix(d, harmonics);
    const f = robustFit(dm.X, d.y, d.n, dm.p, d.stratum, scale);
    if (f) fits.push({ harmonics, ...dm, ...f });
  }
  const top = fits.find((f) => f.harmonics === largest);
  const topCov = top && sandwich(top.X, top.resid, d.n, top.p, d.stratum, scale);
  if (!topCov) return noFit();

  // Robust BIC (Machado 1993): 2 * sum rho(r / s) + p ln n, with the loss scaled
  // by mean(psi') / mean(psi^2) so that loss differences are chi-square, as in
  // the robust likelihood-ratio test.
  const lr = topCov.lrScale;
  for (const f of fits) f.bic = 2 * lr * f.rho + f.p * Math.log(d.n);

  // The sandwich is itself noisy (its effective degrees of freedom are well
  // below n - p), and a noisy covariance inflates a multi-df Wald statistic.
  // Hotelling's T^2 scaling with the sandwich's effective df keeps the test at its level.
  const ndTop = 2 * largest.length;
  const test = waldTest(top.beta.slice(top.dirStart, top.dirStart + ndTop), topCov.cov, top.p, top.dirStart);
  // Floor at q: below it the Hotelling scaling is undefined (nu = 0 would give p = 0).
  const nu = Math.min(d.n - top.p, Math.max(ndTop, sandwichDf(top.X, top.resid, d.n, top.p, d.stratum, scale, top.dirStart, ndTop)));
  const df2 = Math.max(1, nu - ndTop + 1);
  const pval = test.ok ? fSurvival((test.wald * df2) / (nu * ndTop), ndTop, df2) : 1;
  const pool = pval < o.alpha ? fits.filter((f) => f.harmonics.length) : fits;
  const best = pool.reduce((a, b) => (b.bic < a.bic ? b : a));

  const nd = 2 * best.harmonics.length;
  const dirBeta = best.beta.slice(best.dirStart, best.dirStart + nd);
  let shrink = 0, dirShrunk = dirBeta.map(() => 0);
  if (nd > 0) {
    const cov = best === top ? topCov.cov : sandwich(best.X, best.resid, d.n, best.p, d.stratum, scale)?.cov;
    const own = cov ? waldTest(dirBeta, cov, best.p, best.dirStart) : { ok: false };
    if (own.ok && nd > 2) {
      // Positive-part James-Stein toward "no directional effect".
      shrink = own.wald > 0 ? Math.max(0, 1 - (nd - 2) / own.wald) : 0;
      dirShrunk = dirBeta.map((v) => v * shrink);
    } else if (own.ok) {
      // One harmonic: Gaussian prior with SD priorTau on each coefficient.
      const t2 = o.priorTau * o.priorTau;
      const f = dirBeta.map((_, j) => t2 / (t2 + own.V[j * nd + j]));
      dirShrunk = dirBeta.map((v, j) => v * f[j]);
      shrink = (f[0] + f[1]) / 2;
    }
  }
  return {
    harmonics: best.harmonics, beta: best.beta, dirBeta, dirShrunk,
    wald: test.ok ? test.wald : 0, df: ndTop, df2, p: pval, shrink,
    sigma: Math.sqrt(best.rawSigma2), scale,
  };
}

/** b' V^-1 b for the direction block of a covariance matrix. */
function waldTest(b, cov, p, start) {
  const nd = b.length;
  const V = submatrix(cov, p, start, nd);
  const Vinv = invert(V, nd);
  if (!Vinv) return { ok: false };
  let wald = 0;
  for (let a = 0; a < nd; a++) for (let c = 0; c < nd; c++) wald += b[a] * Vinv[a * nd + c] * b[c];
  return { ok: true, wald, V };
}

/**
 * Two-fold replication of the direction curve. The flicks are halved within
 * every (direction x distance) cell, out and return flicks separately, taking
 * every other one in recording order (in effect every other round). One joint
 * fit shares the mean, range and return terms and gives each half its own
 * direction coefficients b_A, b_B. Using one half's curve to correct the other
 * half only helps if b_A.b_B > |b_A|^2 / 2 (and vice versa), so this returns
 * b_A.b_B / max(|b_A|^2, |b_B|^2), which must exceed 0.5. Unlike a correlation
 * it also fails when the halves agree on the shape but not on the size.
 */
function replication(d, harmonics, scale) {
  const half = new Uint8Array(d.n), seen = new Map();
  for (let i = 0; i < d.n; i++) {
    const k = (d.dirBin[i] * 3 + d.stratum[i]) * 2 + d.ret[i];
    const j = seen.get(k) || 0;
    half[i] = j % 2;
    seen.set(k, j + 1);
  }
  const { X: X0, p: p0, dirStart } = designMatrix(d, harmonics);
  const nd = p0 - dirStart, p = p0 + nd;
  const X = new Float64Array(d.n * p);
  for (let i = 0; i < d.n; i++) {
    for (let c = 0; c < dirStart; c++) X[i * p + c] = X0[i * p0 + c];
    const at = i * p + dirStart + half[i] * nd;
    for (let c = 0; c < nd; c++) X[at + c] = X0[i * p0 + dirStart + c];
  }
  const f = robustFit(X, d.y, d.n, p, d.stratum, scale);
  if (!f) return 0;
  const a = f.beta.slice(dirStart, dirStart + nd), b = f.beta.slice(dirStart + nd, p);
  const m = Math.max(dot(a, a), dot(b, b));
  return m > 0 ? dot(a, b) / m : 0;
}

const HUBER_K = 1.345, BISQUARE_C = 4.685;
const huberWeight = (z) => (Math.abs(z) <= HUBER_K ? 1 : HUBER_K / Math.abs(z));
const bisquareWeight = (z) => { const u = z / BISQUARE_C; return Math.abs(u) < 1 ? (1 - u * u) ** 2 : 0; };
/** Bisquare loss, scaled so that rho(z) is about z^2 / 2 near 0. */
const bisquareRho = (z) => {
  const t = (z / BISQUARE_C) ** 2;
  return t < 1 ? ((BISQUARE_C * BISQUARE_C) / 6) * (1 - (1 - t) ** 3) : (BISQUARE_C * BISQUARE_C) / 6;
};

/** IRLS at a fixed per-stratum scale, starting from beta. Returns { beta, resid } or null. */
function irls(X, y, n, p, stratum, scale, weight, beta) {
  const w = new Float64Array(n);
  let resid = residuals(X, y, beta, n, p);
  for (let iter = 0; iter < 50; iter++) {
    for (let i = 0; i < n; i++) {
      const s = scale[stratum[i]];
      w[i] = weight(resid[i] / s) / (s * s);
    }
    const next = wls(X, y, w, n, p);
    if (!next) return null;
    let change = 0, size = 0;
    for (let k = 0; k < p; k++) { change = Math.max(change, Math.abs(next[k] - beta[k])); size = Math.max(size, Math.abs(next[k])); }
    beta = next;
    resid = residuals(X, y, beta, n, p);
    if (change <= 1e-6 * Math.max(1, size)) break;
  }
  return { beta, resid };
}

/** Per-stratum scale: MAD of the residuals of a Huber fit (OLS start, OLS-residual MAD). */
function pilotScale(d, harmonics) {
  const { X, p } = designMatrix(d, harmonics);
  const beta = wls(X, d.y, new Float64Array(d.n).fill(1), d.n, p);
  if (!beta) return null;
  const s0 = stratumScale(residuals(X, d.y, beta, d.n, p), d.stratum);
  const h = irls(X, d.y, d.n, p, d.stratum, s0, huberWeight, beta);
  return h ? stratumScale(h.resid, d.stratum) : null;
}

/**
 * M-estimate at a fixed per-stratum scale: OLS start, Huber (k = 1.345),
 * then Tukey bisquare (c = 4.685). Returns beta, residuals, the summed
 * bisquare loss (for the robust BIC) and a weighted residual variance in log
 * units (for display).
 */
function robustFit(X, y, n, p, stratum, scale) {
  const beta0 = wls(X, y, new Float64Array(n).fill(1), n, p);
  if (!beta0) return null;
  const h = irls(X, y, n, p, stratum, scale, huberWeight, beta0);
  const b = h && irls(X, y, n, p, stratum, scale, bisquareWeight, h.beta);
  if (!b) return null;
  let rho = 0, raw = 0, rawDen = 0;
  for (let i = 0; i < n; i++) {
    const u = b.resid[i] / scale[stratum[i]], rw = bisquareWeight(u);
    rho += bisquareRho(u);
    raw += rw * b.resid[i] ** 2; rawDen += rw;
  }
  return { beta: b.beta, resid: b.resid, rho, rawSigma2: raw / Math.max(1, rawDen) };
}

/**
 * Covariance of a bisquare M-estimate: the sandwich B^-1 M B^-1 n / (n - p)
 * with B = X' diag(psi'(u) / s^2) X and M = X' diag(psi(u)^2 / s^2) X
 * (Huber 1981). psi' < 0 for |u| > 2.1, so B can fail to be positive
 * definite with many outliers; then Huber's form K^2 [sum psi^2 / (n - p)] /
 * mean(psi')^2 (X' S^-2 X)^-1 is used. Also returns mean(psi') / mean(psi^2).
 */
function sandwich(X, resid, n, p, stratum, scale) {
  const wb = new Float64Array(n), wm = new Float64Array(n), ws = new Float64Array(n);
  let sd = 0, sd2 = 0, sp2 = 0;
  for (let i = 0; i < n; i++) {
    const s = scale[stratum[i]], u = resid[i] / s, t = (u / BISQUARE_C) ** 2;
    const psi = t < 1 ? u * (1 - t) ** 2 : 0, dpsi = t < 1 ? (1 - t) * (1 - 5 * t) : 0;
    wb[i] = dpsi / (s * s); wm[i] = (psi * psi) / (s * s); ws[i] = 1 / (s * s);
    sd += dpsi; sd2 += dpsi * dpsi; sp2 += psi * psi;
  }
  if (!(sd > 0 && sp2 > 0) || n <= p) return null;
  const lrScale = sd / sp2;
  const B = normalMatrix(X, wb, n, p);
  const Binv = positiveDefinite(B, p) ? invert(B, p) : null;
  if (Binv) {
    const M = normalMatrix(X, wm, n, p);
    const cov = matMul(matMul(Binv, M, p), Binv, p).map((v) => (v * n) / (n - p));
    return { cov, lrScale };
  }
  const md = sd / n, K = 1 + (p / n) * (sd2 / n - md * md) / (md * md);
  const inv = invert(normalMatrix(X, ws, n, p), p);
  if (!inv) return null;
  const f = (K * K * (sp2 / (n - p))) / (md * md);
  return { cov: inv.map((v) => v * f), lrScale };
}

/**
 * Effective degrees of freedom of the sandwich variance (Satterthwaite), by the
 * delta method on V_jj ~ sum(m_i) / sum(b_i)^2 with m_i = psi^2 x_ij^2 / s^2 and
 * b_i = psi' x_ij^2 / s^2 (the direction columns are nearly orthogonal), averaged
 * over the k columns from start: nu = 2 / CV^2(V_jj).
 */
function sandwichDf(X, resid, n, p, stratum, scale, start, k) {
  let sum = 0;
  for (let j = start; j < start + k; j++) {
    let sm = 0, sb = 0, smm = 0, sbb = 0, smb = 0;
    for (let i = 0; i < n; i++) {
      const s = scale[stratum[i]], u = resid[i] / s, t = (u / BISQUARE_C) ** 2;
      const x2 = (X[i * p + j] / s) ** 2;
      const m = t < 1 ? x2 * (u * (1 - t) ** 2) ** 2 : 0, b = t < 1 ? x2 * (1 - t) * (1 - 5 * t) : 0;
      sm += m; sb += b; smm += m * m; sbb += b * b; smb += m * b;
    }
    // Sums of n roughly independent terms: Var(sum) = n var(term).
    const vm = smm - (sm * sm) / n, vb = sbb - (sb * sb) / n, cmb = smb - (sm * sb) / n;
    const cv2 = vm / (sm * sm) + (4 * vb) / (sb * sb) - (4 * cmb) / (sm * sb);
    sum += cv2 > 0 ? 2 / cv2 : n;
  }
  return sum / k;
}

function stratumScale(resid, stratum) {
  const groups = [[], [], []];
  for (let i = 0; i < resid.length; i++) groups[stratum[i]].push(resid[i]);
  const fallback = Math.max(1e-3, mad([...resid]) / 0.6745);
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

function matMul(A, B, p) {
  const C = new Float64Array(p * p);
  for (let i = 0; i < p; i++) for (let k = 0; k < p; k++) {
    const a = A[i * p + k];
    if (a !== 0) for (let j = 0; j < p; j++) C[i * p + j] += a * B[k * p + j];
  }
  return C;
}

/** Cholesky test: true if the symmetric matrix is (numerically) positive definite. */
function positiveDefinite(A, p) {
  const L = new Float64Array(p * p);
  for (let j = 0; j < p; j++) {
    let s = A[j * p + j];
    for (let k = 0; k < j; k++) s -= L[j * p + k] ** 2;
    if (!(s > 1e-12 * Math.max(1, Math.abs(A[j * p + j])))) return false;
    L[j * p + j] = Math.sqrt(s);
    for (let i = j + 1; i < p; i++) {
      let v = A[i * p + j];
      for (let k = 0; k < j; k++) v -= L[i * p + k] * L[j * p + k];
      L[i * p + j] = v / L[j * p + j];
    }
  }
  return true;
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

/** P(F(d1, d2) > f), via the regularised incomplete beta function. */
export function fSurvival(f, d1, d2) {
  if (!(f > 0)) return 1;
  return betaRegularized(d2 / 2, d1 / 2, d2 / (d2 + d1 * f));
}

/** Regularised incomplete beta I_x(a, b), continued fraction evaluated with the modified Lentz method. */
function betaRegularized(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - betaRegularized(b, a, 1 - x);
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const TINY = 1e-300;
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    for (const num of [(m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m)), (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1))]) {
      d = 1 + num * d; if (Math.abs(d) < TINY) d = TINY;
      c = 1 + num / c; if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      h *= d * c;
    }
    if (Math.abs(d * c - 1) < 1e-15) break;
  }
  return (front * h) / a;
}

/** ln Gamma(z) for z > 0 (Lanczos, g = 7). */
function lnGamma(z) {
  const C = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let s = C[0];
  for (let i = 1; i < 9; i++) s += C[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(s);
}

// ---------------------------------------------------------------- helpers

export function median(a) { return quantile(a, 0.5); }

export function quantile(a, q) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort(), pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
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
