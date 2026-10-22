// report.js - session files and the results model. Pure, no DOM.
//
// Wraps analysis.js so the UI only deals with one result shape. fitProfile()
// is being extended (evidence gate, gains8, bins8 ...); every field it may not
// return yet is derived here from what it does return.
import { analyzeTrial, fitProfile } from './analysis.js';
import { gainAt, DIR8 } from './omni-core.js';
import { profileFromGains } from './export.js';

export const SESSION_FORMAT = 'omnisens-session';
export const SESSION_VERSION = 1;

const DIRS8 = DIR8.map((_, k) => k * 45);

const REASONS = {
  'too-few-samples': 'too few movement samples',
  'target-too-close': 'target needed almost no hand movement',
  'too-short': 'trial too short',
  'no-movement': 'no movement',
  'moving-at-spawn': 'still moving when the target appeared',
  anticipated: 'started before the target appeared (anticipation)',
  'late-start': 'started very late',
  'too-brief': 'flick too brief to measure',
  'no-clear-end': 'no clear end of the first flick',
  'implausible-ratio': 'first flick far too short or long (segmentation failed)',
  'off-axis': 'first flick went off to the side',
  'too-slow': 'movement too slow to be a flick',
  blip: 'twitch rather than a flick',
  'mouse-lifted': 'mouse lifted mid-flick',
  misdirected: 'first flick started in the wrong direction',
  'analysis-error': 'could not be analysed',
};

export function reasonLabel(code) {
  return REASONS[code] || String(code).replace(/-/g, ' ');
}

// ------------------------------------------------------------------ sessions

export function makeSession({ settings, degPerCount, cm360, adapter = 'none', current = null, seed, plan }) {
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    created: new Date().toISOString(),
    settings: { ...settings },
    degPerCount,
    cm360,
    hFov: settings.hFov,
    dpi: settings.dpi,
    adapter,              // 'none' | 'fresh' | 'refine'
    desktop: null,        // the omnisens app's correction on this PC: null | 'fresh' (paused) | 'refine' (kept on)
    current,              // profile active while recording (refine), else null
    inputMode: null,      // 'raw' | 'accel' | 'mixed', filled in by the task
    seed,
    rounds: plan ? plan.map((r) => ({ index: r.index, warmup: !!r.warmup, targets: r.targets.length })) : [],
    trials: [],
  };
}

/** Parses and validates a session file. Throws an Error with a readable message. */
export function parseSession(text) {
  let j;
  try {
    j = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!j || j.format !== SESSION_FORMAT) throw new Error('Not an omnisens session file (format field missing).');
  if (!(j.version <= SESSION_VERSION)) throw new Error('Session file is from a newer version of omnisens.');
  if (!Array.isArray(j.trials) || !j.trials.length) throw new Error('Session file has no recorded flicks.');
  for (const [i, t] of j.trials.entries()) {
    const okArr = (a) => Array.isArray(a) && a.every((v) => typeof v === 'number' && Number.isFinite(v));
    if (!okArr(t.req) || t.req.length !== 2 || !okArr(t.t) || !okArr(t.x) || !okArr(t.y)
      || t.t.length !== t.x.length || t.t.length !== t.y.length) {
      throw new Error(`Session file is damaged (flick ${i + 1}).`);
    }
  }
  j.current = j.current && Array.isArray(j.current.gains) ? j.current : null;
  return j;
}

/** Trials that go into the analysis: everything except warm-up. */
export function analysedTrials(session) {
  return session.trials.filter((t) => !t.warmup);
}

/** degPerCount (optional) is filled into trials that lack it; analysis uses it for an absolute onset floor. */
export function analyzeTrials(trials, degPerCount = null) {
  return trials.map((t) => {
    try {
      return analyzeTrial(t.degPerCount || !(degPerCount > 0) ? t : { ...t, degPerCount });
    } catch {
      return { ok: false, reason: 'analysis-error' };
    }
  });
}

export function countReasons(results) {
  const out = {};
  for (const r of results) if (r && !r.ok) out[r.reason] = (out[r.reason] || 0) + 1;
  return out;
}

// ------------------------------------------------------------------ fitting

/** fitProfile + normalisation. opts: { nPoints, strength, symmetric, force, bootstrap, seed }. */
export function fitResults(results, opts, current) {
  let fit;
  try {
    fit = fitProfile(results, opts, current);
  } catch (e) {
    fit = { ok: false, error: `Analysis failed: ${e.message}` };
  }
  return normalizeFit(fit, results, current);
}

const curFn = (current) => (th) => (current ? gainAt(current.gains, th, current.linear) : 1);

function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((p, q) => p - q);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
}

function angDist(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** Median primary-extent ratio of flicks within +-22.5 deg of each 45 deg direction. */
export function binResults(results) {
  const ok = results.filter((r) => r && r.ok);
  return DIRS8.map((theta) => {
    const ratios = ok.filter((r) => angDist(r.theta, theta) <= 22.5).map((r) => r.ratio);
    return { theta, n: ratios.length, medianRatio: ratios.length ? median(ratios) : null };
  });
}

/** Bias in percent of each bin relative to the geometric mean of all bins (+ = overshoot). */
export function biasFromBins(bins) {
  const v = bins.map((b) => b.medianRatio).filter((x) => x > 0);
  if (!v.length) return bins.map(() => null);
  const gm = Math.exp(v.reduce((s, x) => s + Math.log(x), 0) / v.length);
  return bins.map((b) => (b.medianRatio > 0 ? (b.medianRatio / gm - 1) * 100 : null));
}

export function normalizeFit(fit, results, current) {
  const cur = curFn(current);
  const okCount = results.filter((r) => r && r.ok).length;
  const error = fit.error || (fit.ok === false && !Array.isArray(fit.gains) ? 'Analysis failed.' : null);
  const rejected = fit.rejected && typeof fit.rejected === 'object' ? fit.rejected : countReasons(results);
  const nRejected = Object.values(rejected).reduce((s, v) => s + v, 0);
  const directions = Array.isArray(fit.directions) ? fit.directions : [];
  const gains = Array.isArray(fit.gains) ? fit.gains : directions.map(cur);
  const ci = Array.isArray(fit.ci) ? fit.ci : gains.map((g) => [g, g]);
  const gains8 = fit.gains8 || DIRS8.map((d) => (gains.length ? gainAt(gains, d, false) : cur(d)));
  const ci8 = fit.ci8 || DIRS8.map((d) => {
    const k = directions.findIndex((x) => Math.abs(x - d) < 1e-6);
    return k >= 0 && ci[k] && ci[k][0] !== null ? ci[k] : null;
  });
  const bins8 = fit.bins8 || (Array.isArray(fit.bins) && fit.bins.length === 8 ? fit.bins : binResults(results));
  const bias8 = fit.bias8 || biasFromBins(bins8);
  const curve = (fit.curve || []).map((c) => ({
    theta: c.theta,
    ratio: c.ratio ?? (c.demand > 0 && c.current > 0 ? c.current / c.demand : null),
    current: c.current ?? cur(c.theta),
    recommended: c.recommended ?? (gains.length ? gainAt(gains, c.theta, false) : cur(c.theta)),
  }));
  const trialsUsed = typeof fit.trials === 'number' ? fit.trials : Array.isArray(fit.trials) ? fit.trials.length : okCount;
  return {
    raw: fit,
    error,
    ok: !error && (fit.ok ?? true),
    total: results.length,
    used: trialsUsed,
    rejected,
    rejectedFrac: fit.rejectedFrac ?? (results.length ? nRejected / results.length : 0),
    K: fit.K ?? fit.harmonics ?? null,
    evidence: fit.evidence || null,
    applied: error ? false : (fit.applied ?? true),
    overallRatio: Number.isFinite(fit.overallRatio) ? fit.overallRatio : null,
    rangeSlope: fit.rangeSlope ?? null,
    nPoints: gains.length,
    directions,
    gains,
    ci,
    gains8,
    ci8,
    bins8,
    bias8,
    curve,
    warnings: Array.isArray(fit.warnings) ? fit.warnings : [],
  };
}

// ------------------------------------------------------------------ presentation

/** The 8 headline rows: multiplier, change vs current, CI and measured bias. */
export function headlineRows(nf, current) {
  const cur = curFn(current);
  const cur8 = Array.isArray(nf.raw?.currentGains8) && !current ? nf.raw.currentGains8 : null;
  return DIR8.map((name, k) => {
    const theta = k * 45;
    const gain = nf.gains8[k];
    const c = cur8 ? cur8[k] : cur(theta);
    return {
      name, theta, gain, current: c,
      changePct: (gain / c - 1) * 100,
      ci: nf.ci8[k] || null,
      biasPct: nf.bias8[k] ?? null,
      n: nf.bins8[k]?.n ?? null,
    };
  });
}

export function fmtP(p) {
  if (!Number.isFinite(p)) return 'n/a';
  if (p < 0.001) return '< 0.001';
  return p < 0.01 ? p.toFixed(3) : p.toFixed(2);
}

/** "p < 0.001" or "p = 0.04". */
export function pText(p) {
  const f = fmtP(p);
  return f.startsWith('<') ? `p ${f}` : `p = ${f}`;
}

/** Headline verdict for the results card: { kind: 'pass'|'flat'|'error'|'info', title, text }. */
export function verdict(nf, refine = false) {
  if (nf.error) return { kind: 'error', title: 'Not enough usable flicks', text: nf.error };
  const ev = nf.evidence;
  if (!ev) {
    return { kind: 'info', title: 'Profile computed', text: 'This analysis version does not report an evidence test. Use the uncertainty ranges below to judge it.' };
  }
  // evidence.reliability is the cross-half replication ratio (needs > 0.5).
  const rel = Number.isFinite(ev.reliability)
    ? `, replication ${ev.reliability.toFixed(2)} (needs > ${ev.replicationThreshold ?? 0.5})`
    : '';
  if (ev.passed) {
    return { kind: 'pass', title: 'Directional bias detected', text: `${pText(ev.p)}${rel}. Your aim is measurably different by direction.` };
  }
  return {
    kind: 'flat',
    title: 'No reliable directional bias found',
    text: `${pText(ev.p)}${rel}. Your profile stays ${refine ? 'as it is' : 'flat'} unless you choose Apply anyway.`,
  };
}

/** Overall over/undershoot sentence; never applied to the profile. */
export function overallText(ratio) {
  if (!Number.isFinite(ratio)) return '';
  const pct = (ratio - 1) * 100;
  if (Math.abs(pct) < 1) return 'On average your first flick lands right on distance. Nice.';
  const word = pct > 0 ? 'overshoot' : 'undershoot';
  return `On average you ${word} by ${Math.abs(pct).toFixed(0)}%. That is a general sensitivity matter, so omnisens leaves it alone and only evens out the differences between directions.`;
}

/**
 * Adapter config for a fit. baseCfg (the adapter's current config, if any)
 * keeps rotation, reset time and the chord toggle; DPI sets direction smoothing.
 */
export function profileFromFit(nf, session, baseCfg = null, date = new Date()) {
  const base = baseCfg || (session?.current ? { rotationCdeg: session.current.rotationCdeg || 0 } : null);
  const p = (n) => String(n).padStart(2, '0');
  const label = `cal ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  return profileFromGains(nf.gains, { dpi: session?.dpi || session?.settings?.dpi || 0, base, label, linear: false });
}
