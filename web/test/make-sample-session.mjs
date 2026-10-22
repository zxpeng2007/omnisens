// Writes web/test/fixtures/sample-session.json: a simulated player doing the
// Quick calibration (warm-up + 3 rounds) with a known directional bias.
// The web app's "See an example result" button and "Load session" use it.
// Run: node web/test/make-sample-session.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCalibrationPlan, mulberry32 } from '../js/schedule.js';
import { requiredCounts } from '../js/aim-task.js';
import { vecAngle } from '../js/omni-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'fixtures', 'sample-session.json');

const SEED = 20261021;
const DPI = 800;
const DPC = 0.022;            // CS2, sensitivity 1.0
const SAMPLE_MS = 2;          // 500 Hz keeps the file small; analysis resamples to 1 ms

// Overshoots right and down-right, undershoots up-left, plus a general 3% overshoot.
export const trueBias = (deg) => {
  const a = (deg * Math.PI) / 180;
  return 1.03 * (1 + 0.07 * Math.cos(a) - 0.04 * Math.sin(a) + 0.03 * Math.cos(2 * a));
};

const mj = (tau) => (tau <= 0 ? 0 : tau >= 1 ? 1 : tau ** 3 * (10 - 15 * tau + 6 * tau * tau));

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** One flick from `aim` to `target` (degrees). Returns the trial fields and the final aim. */
function flick(rng, aim, target, radiusDeg) {
  const req = requiredCounts(aim, target.yaw, target.pitch, DPC);
  const dist = Math.hypot(req[0], req[1]);
  const ux = req[0] / dist, uy = req[1] / dist;
  const theta = vecAngle(req[0], req[1]);
  const primary = trueBias(theta) * dist * (1 + 0.06 * gauss(rng));
  const radC = radiusDeg / DPC;
  const errAlong = 0.3 * radC * gauss(rng), errLat = 0.3 * radC * gauss(rng);
  const anticipate = rng() < 0.03;
  const rt = anticipate ? 30 + 30 * rng() : 160 + 60 * rng();
  const d1 = 140 + 0.08 * dist + 30 * rng();
  const gap = 25 + 30 * rng();
  const d2 = 120 + 40 * rng();
  const lat = 0.03 * dist * gauss(rng);
  const end = rt + d1 + gap + d2 + 40 + 40 * rng();
  const t = [0], x = [0], y = [0];
  let cx = 0, cy = 0;
  for (let ms = SAMPLE_MS; ms <= end; ms += SAMPLE_MS) {
    const p1 = mj((ms - rt) / d1);
    const p2 = mj((ms - rt - d1 - gap) / d2);
    const along = primary * p1 + (dist + errAlong - primary) * p2;
    const side = lat * p1 * (1 - p2) + errLat * p2;
    const nx = Math.round(ux * along - uy * side), ny = Math.round(uy * along + ux * side);
    if (nx !== cx || ny !== cy) { t.push(ms); x.push(nx); y.push(ny); cx = nx; cy = ny; }
  }
  const finalAim = { yaw: aim.yaw + cx * DPC, pitch: aim.pitch - cy * DPC };
  const missFirst = rng() < 0.15;
  return {
    req: [Math.round(req[0] * 1000) / 1000, Math.round(req[1] * 1000) / 1000],
    t, x, y,
    hit: true,
    hitMs: Math.round(end),
    clicks: missFirst ? 2 : 1,
    timeout: false,
    degPerCount: DPC,
    finalAim,
  };
}

export function makeSampleSession() {
  const rng = mulberry32(SEED);
  const plan = makeCalibrationPlan({ rounds: 3, seed: SEED });
  const trials = [];
  for (const round of plan) {
    let aim = { yaw: 0, pitch: 0 };
    round.targets.forEach((spec, index) => {
      const a = (spec.theta * Math.PI) / 180;
      const target = { yaw: spec.ampDeg * Math.cos(a), pitch: spec.ampDeg * Math.sin(a) };
      const out = flick(rng, aim, target, spec.radiusDeg);
      aim = out.finalAim;
      delete out.finalAim;
      trials.push({ kind: 'out', round: round.index, warmup: round.warmup, index, thetaPlanned: spec.theta, ampDeg: spec.ampDeg, radiusDeg: spec.radiusDeg, ...out, applied: null });
      if (index === round.targets.length - 1) return;
      const back = flick(rng, aim, { yaw: 0, pitch: 0 }, spec.radiusDeg);
      aim = back.finalAim;
      delete back.finalAim;
      trials.push({ kind: 'return', round: round.index, warmup: round.warmup, index, thetaPlanned: (spec.theta + 180) % 360, ampDeg: spec.ampDeg, radiusDeg: spec.radiusDeg, ...back, applied: null });
    });
  }
  const settings = {
    dpi: DPI, game: 'cs2', sens: 1, customYaw: 0.022, r6Multiplier: 0.02, cm360: 40, hFov: 106.26,
    preset: 'quick', customRounds: 4, fullscreen: true, adapterMode: 'fresh', nPoints: 16, strength: 0.7, symmetric: false,
  };
  return {
    format: 'omnisens-session',
    version: 1,
    created: '2026-10-21T12:00:00.000Z',
    simulated: 'Example data from web/test/make-sample-session.mjs: overshoots right and down-right, undershoots up-left, 3% general overshoot.',
    settings,
    degPerCount: DPC,
    cm360: (360 / (DPC * DPI)) * 2.54,
    hFov: settings.hFov,
    dpi: DPI,
    adapter: 'none',
    current: null,
    inputMode: 'raw',
    seed: SEED,
    rounds: plan.map((r) => ({ index: r.index, warmup: r.warmup, targets: r.targets.length })),
    trials,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = makeSampleSession();
  mkdirSync(dirname(OUT), { recursive: true });
  const text = JSON.stringify(s);
  writeFileSync(OUT, text + '\n');
  console.log(`wrote ${OUT}: ${s.trials.length} trials, ${(text.length / 1024).toFixed(0)} KiB`);
}
