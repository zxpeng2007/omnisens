// schedule.js - trial schedules for the flick task. Pure and deterministic for a seed.
//
// A round is 16 base directions x 3 amplitudes = 48 peripheral targets, each
// direction jittered by up to half the spacing so every angle gets sampled.
// Target size scales with distance (W = D/7) so every flick has the same
// Fitts index of difficulty and the bias we measure is not mixed up with
// how hard individual targets were.

export const AMPLITUDES = [8, 16, 28];
export const DIRECTIONS = 16;
export const MIN_SEPARATION = 45;
export const PRESETS = { quick: 3, standard: 6 };
export const WARMUP_TARGETS = 24;

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

/** Angular target radius in degrees for an amplitude in degrees. */
export function targetRadius(ampDeg) {
  return Math.max(0.5, ampDeg / 14);
}

export function angDist(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

const wrap360 = (a) => ((a % 360) + 360) % 360;

function shuffle(rand, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** nDirs evenly spaced directions x amplitudes, each direction jittered by +-spacing/2. */
export function makeTargetSet(rand, nDirs = DIRECTIONS, amplitudes = AMPLITUDES) {
  const spacing = 360 / nDirs;
  const out = [];
  for (let k = 0; k < nDirs; k++) {
    for (const amp of amplitudes) {
      const theta = wrap360(k * spacing + (rand() - 0.5) * spacing);
      out.push({ theta: Math.round(theta * 100) / 100, ampDeg: amp, radiusDeg: targetRadius(amp) });
    }
  }
  return out;
}

/**
 * Random order in which consecutive targets differ by at least minSep degrees
 * (so the hand cannot reuse the previous plan). Plain reshuffling almost never
 * satisfies this for 48 targets, so it builds the order greedily from random
 * candidates and restarts on a dead end.
 */
export function orderTargets(rand, items, minSep = MIN_SEPARATION, prevTheta = null) {
  let best = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const pool = shuffle(rand, [...items]);
    const out = [];
    let last = prevTheta;
    while (pool.length) {
      const cands = [];
      for (let i = 0; i < pool.length; i++) {
        if (last === null || angDist(pool[i].theta, last) >= minSep) cands.push(i);
      }
      if (!cands.length) break;
      const i = cands[Math.floor(rand() * cands.length)];
      out.push(pool[i]);
      last = pool[i].theta;
      pool.splice(i, 1);
    }
    if (!pool.length) return out;
    if (!best || out.length > best.out.length) best = { out, rest: pool };
  }
  return [...best.out, ...best.rest];
}

function makeRound(rand, { index, warmup = false, nDirs, amplitudes, prevTheta }) {
  const targets = orderTargets(rand, makeTargetSet(rand, nDirs, amplitudes), MIN_SEPARATION, prevTheta);
  return { index, warmup, targets };
}

/** Analysed rounds: [{ index: 1.., warmup: false, targets: [{theta, ampDeg, radiusDeg}] x48 }]. */
export function makeSchedule({ rounds = PRESETS.standard, seed = 1 } = {}) {
  const rand = mulberry32(seed);
  const out = [];
  let prev = null;
  for (let r = 0; r < rounds; r++) {
    const round = makeRound(rand, { index: r + 1, nDirs: DIRECTIONS, amplitudes: AMPLITUDES, prevTheta: prev });
    prev = round.targets[round.targets.length - 1].theta;
    out.push(round);
  }
  return out;
}

/** Warm-up round (not analysed): 8 directions x 3 amplitudes = 24 targets. */
export function makeWarmup({ seed = 1, count = WARMUP_TARGETS } = {}) {
  const rand = mulberry32((seed ^ 0x5bd1e995) >>> 0);
  const nDirs = Math.max(1, Math.round(count / AMPLITUDES.length));
  return makeRound(rand, { index: 0, warmup: true, nDirs, amplitudes: AMPLITUDES, prevTheta: null });
}

/** Warm-up followed by the analysed rounds, ready for the aim task. */
export function makeCalibrationPlan({ rounds = PRESETS.standard, seed = 1, warmup = true } = {}) {
  const plan = makeSchedule({ rounds, seed });
  return warmup ? [makeWarmup({ seed }), ...plan] : plan;
}

/** Blocks for the blind A/B test: each 24 targets (8 directions x 3 amplitudes). */
export function makeBlocks({ blocks = 6, perBlock = 24, seed = 1 } = {}) {
  const rand = mulberry32((seed ^ 0x2545f491) >>> 0);
  const nDirs = Math.max(1, Math.round(perBlock / AMPLITUDES.length));
  const out = [];
  let prev = null;
  for (let b = 0; b < blocks; b++) {
    const round = makeRound(rand, { index: b + 1, nDirs, amplitudes: AMPLITUDES, prevTheta: prev });
    prev = round.targets[round.targets.length - 1].theta;
    out.push(round);
  }
  return out;
}

/** Number of rounds for a preset name or custom count (clamped 2..10). */
export function roundsFor(preset, custom) {
  if (preset in PRESETS) return PRESETS[preset];
  const n = Math.round(Number(custom));
  return Number.isFinite(n) ? Math.min(10, Math.max(2, n)) : PRESETS.standard;
}
