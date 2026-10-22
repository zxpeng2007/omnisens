// ab-test.js - blind A/B verification: block order, metrics and a permutation test.
// Pure functions; the view (view-verify.js) runs the task and switches the adapter.
import { mulberry32 } from './schedule.js';

export const ON = 'on';
export const OFF = 'off';

/**
 * Balanced random block order (half ON, half OFF) with no condition more than
 * twice in a row, so warm-up and fatigue do not line up with one condition.
 */
export function makeAbPlan(seed = 1, blocks = 6) {
  const rand = mulberry32(seed);
  const half = Math.floor(blocks / 2);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const plan = [...new Array(half).fill(ON), ...new Array(blocks - half).fill(OFF)];
    for (let i = plan.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [plan[i], plan[j]] = [plan[j], plan[i]];
    }
    if (maxRun(plan) <= 2 || blocks < 4) return plan;
  }
  return Array.from({ length: blocks }, (_, i) => (i % 2 ? OFF : ON));
}

function maxRun(a) {
  let best = 0, run = 0;
  for (let i = 0; i < a.length; i++) {
    run = i > 0 && a[i] === a[i - 1] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((p, q) => p - q);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
}

/**
 * Two-sided permutation test of statFn(a) - statFn(b). Items can be anything
 * statFn understands. Returns { observed, p, iters }.
 */
export function permutationTest(a, b, statFn, iters = 2000, seed = 1) {
  const observed = statFn(a) - statFn(b);
  if (!Number.isFinite(observed) || !a.length || !b.length) return { observed, p: NaN, iters: 0 };
  const rand = mulberry32(seed);
  const pool = [...a, ...b];
  const na = a.length;
  let extreme = 0;
  for (let it = 0; it < iters; it++) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const d = statFn(pool.slice(0, na)) - statFn(pool.slice(na));
    if (Math.abs(d) >= Math.abs(observed) - 1e-12) extreme++;
  }
  return { observed, p: (extreme + 1) / (iters + 1), iters };
}

/**
 * Did the primary submovement end inside the target? Uses the along-axis error
 * of the primary endpoint: |ratio - 1| * distance(deg) <= target radius(deg).
 * Returns null when the flick could not be segmented.
 */
export function primaryHit(trial, analysis) {
  if (!analysis || !analysis.ok || !(trial.ampDeg > 0) || !(trial.radiusDeg > 0)) return null;
  return Math.abs(analysis.ratio - 1) * trial.ampDeg <= trial.radiusDeg;
}

// Items passed to the statistics: one per outward flick.
export function toItems(trials, analyses) {
  return trials.map((t, i) => ({
    primary: primaryHit(t, analyses[i]),
    hit: !!t.hit,
    hitMs: t.hit ? t.hitMs : null,
    clicks: t.clicks || 0,
  }));
}

export const stats = {
  primaryRate(items) {
    const v = items.filter((it) => it.primary !== null);
    return v.length ? v.filter((it) => it.primary).length / v.length : NaN;
  },
  medianHitMs(items) {
    return median(items.filter((it) => it.hit && Number.isFinite(it.hitMs)).map((it) => it.hitMs));
  },
  clickAccuracy(items) {
    const shots = items.reduce((s, it) => s + it.clicks, 0);
    return shots ? items.filter((it) => it.hit).length / shots : NaN;
  },
};

export function conditionMetrics(items) {
  const segmented = items.filter((it) => it.primary !== null);
  return {
    flicks: items.length,
    segmented: segmented.length,
    primaryHits: segmented.filter((it) => it.primary).length,
    primaryRate: stats.primaryRate(items),
    hits: items.filter((it) => it.hit).length,
    shots: items.reduce((s, it) => s + it.clicks, 0),
    medianHitMs: stats.medianHitMs(items),
    clickAccuracy: stats.clickAccuracy(items),
  };
}

/** Compares ON vs OFF items. Positive differences mean ON is higher. */
export function compareConditions(onItems, offItems, { iters = 2000, seed = 7 } = {}) {
  const on = conditionMetrics(onItems);
  const off = conditionMetrics(offItems);
  const tests = {};
  for (const key of ['primaryRate', 'medianHitMs', 'clickAccuracy']) {
    tests[key] = permutationTest(onItems, offItems, stats[key], iters, seed);
  }
  return { on, off, tests };
}

/** Plain-language summary; lower time is better, higher rates are better. */
export function abVerdict(cmp, alpha = 0.05) {
  const better = [], worse = [];
  const names = { primaryRate: 'first-flick accuracy', medianHitMs: 'time to hit', clickAccuracy: 'click accuracy' };
  for (const [key, t] of Object.entries(cmp.tests)) {
    if (!(t.p < alpha)) continue;
    const onBetter = key === 'medianHitMs' ? t.observed < 0 : t.observed > 0;
    (onBetter ? better : worse).push(names[key]);
  }
  if (!better.length && !worse.length) {
    return 'No difference you could not get by chance. Keep the profile only if it feels better; the numbers do not show a benefit yet.';
  }
  const parts = [];
  if (better.length) parts.push(`With the profile ON your ${better.join(' and ')} improved beyond chance`);
  if (worse.length) parts.push(`${better.length ? 'but' : 'With the profile ON'} your ${worse.join(' and ')} got worse`);
  return parts.join(' ') + '.';
}
