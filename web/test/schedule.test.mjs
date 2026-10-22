// Run: node --test "web/test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeSchedule, makeWarmup, makeCalibrationPlan, makeBlocks, targetRadius, angDist, roundsFor,
  AMPLITUDES, MIN_SEPARATION,
} from '../js/schedule.js';
import { requiredCounts, angleBetween, project, wrap180 } from '../js/aim-task.js';
import { vecAngle } from '../js/omni-core.js';

test('a round is 16 directions x 3 amplitudes with jitter inside each sector', () => {
  for (const seed of [1, 2, 99, 123456]) {
    const [round] = makeSchedule({ rounds: 1, seed });
    assert.equal(round.targets.length, 48);
    assert.equal(round.warmup, false);
    const bySector = new Map();
    for (const t of round.targets) {
      assert.ok(t.theta >= 0 && t.theta < 360);
      assert.ok(AMPLITUDES.includes(t.ampDeg));
      const sector = Math.round(t.theta / 22.5) % 16;
      // Each base direction k*22.5 is jittered by at most +-11.25 deg.
      assert.ok(angDist(t.theta, sector * 22.5) <= 11.25 + 1e-9);
      bySector.set(sector, (bySector.get(sector) || 0) + 1);
    }
    assert.equal(bySector.size, 16);
    for (const n of bySector.values()) assert.equal(n, 3);
    const amps = round.targets.map((t) => t.ampDeg);
    for (const a of AMPLITUDES) assert.equal(amps.filter((x) => x === a).length, 16);
  }
});

test('consecutive targets are at least 45 deg apart, across rounds too', () => {
  for (const seed of [3, 4, 5, 6, 7, 8]) {
    const plan = makeSchedule({ rounds: 6, seed });
    const all = plan.flatMap((r) => r.targets);
    for (let i = 1; i < all.length; i++) {
      assert.ok(angDist(all[i].theta, all[i - 1].theta) >= MIN_SEPARATION, `seed ${seed} target ${i}`);
    }
  }
});

test('schedules are deterministic for a seed and differ between seeds', () => {
  assert.deepEqual(makeSchedule({ rounds: 3, seed: 42 }), makeSchedule({ rounds: 3, seed: 42 }));
  assert.notDeepEqual(makeSchedule({ rounds: 1, seed: 42 }), makeSchedule({ rounds: 1, seed: 43 }));
});

test('target radius keeps a constant index of difficulty (W = D/7), min 0.5 deg', () => {
  assert.equal(targetRadius(28), 2);
  assert.equal(targetRadius(14), 1);
  assert.equal(targetRadius(3), 0.5);
  const [round] = makeSchedule({ rounds: 1, seed: 1 });
  for (const t of round.targets) assert.equal(t.radiusDeg, targetRadius(t.ampDeg));
});

test('warm-up, calibration plan and A/B blocks', () => {
  const w = makeWarmup({ seed: 9 });
  assert.equal(w.warmup, true);
  assert.equal(w.index, 0);
  assert.equal(w.targets.length, 24);
  const plan = makeCalibrationPlan({ rounds: 6, seed: 9 });
  assert.equal(plan.length, 7);
  assert.equal(plan[0].warmup, true);
  assert.deepEqual(plan.slice(1).map((r) => r.index), [1, 2, 3, 4, 5, 6]);
  assert.equal(makeCalibrationPlan({ rounds: 3, seed: 9 }).length, 4);
  const blocks = makeBlocks({ blocks: 6, perBlock: 24, seed: 9 });
  assert.equal(blocks.length, 6);
  for (const b of blocks) {
    assert.equal(b.targets.length, 24);
    for (let i = 1; i < b.targets.length; i++) assert.ok(angDist(b.targets[i].theta, b.targets[i - 1].theta) >= 45);
  }
});

test('session length presets', () => {
  assert.equal(roundsFor('quick'), 3);
  assert.equal(roundsFor('standard'), 5);
  assert.equal(roundsFor('custom', 12), 10);
  assert.equal(roundsFor('custom', 1), 2);
  assert.equal(roundsFor('custom', 'x'), 5);
});

test('aim geometry: required counts point in the planned mouse direction', () => {
  const dpc = 0.022;
  for (const theta of [0, 30, 90, 135, 180, 250, 270, 315]) {
    const a = (theta * Math.PI) / 180;
    const [rx, ry] = requiredCounts({ yaw: 0, pitch: 0 }, 16 * Math.cos(a), 16 * Math.sin(a), dpc);
    assert.ok(angDist(vecAngle(rx, ry), theta) < 1e-6, `theta ${theta}`);
    assert.ok(Math.abs(Math.hypot(rx, ry) - 16 / dpc) < 1e-6);
  }
  // Yaw differences wrap the short way round.
  const [rx] = requiredCounts({ yaw: 175, pitch: 0 }, -175, 0, 1);
  assert.equal(rx, 10);
  assert.equal(wrap180(190), -170);
});

test('aim geometry: projection and hit angles', () => {
  const cam = { yaw: 10, pitch: -5 };
  const [sx, sy] = project(cam, 10, -5, 800, 1600, 900);
  assert.ok(Math.abs(sx - 800) < 1e-9 && Math.abs(sy - 450) < 1e-9, 'looking at a point puts it at the centre');
  const right = project({ yaw: 0, pitch: 0 }, 10, 0, 800, 1600, 900);
  assert.ok(right[0] > 800 && Math.abs(right[1] - 450) < 1e-9, 'positive yaw is to the right');
  const up = project({ yaw: 0, pitch: 0 }, 0, 10, 800, 1600, 900);
  assert.ok(up[1] < 450, 'positive pitch is up');
  assert.equal(project({ yaw: 0, pitch: 0 }, 180, 0, 800, 1600, 900), null, 'behind the camera');
  assert.ok(Math.abs(angleBetween(0, 0, 3, 4) - 5) < 0.01);
});
