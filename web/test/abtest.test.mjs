// Run: node --test "web/test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeAbPlan, permutationTest, primaryHit, toItems, conditionMetrics, compareConditions, abVerdict, stats, median, ON, OFF,
} from '../js/ab-test.js';
import { mulberry32 } from '../js/schedule.js';

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

test('A/B plan is balanced, seeded, and never runs a condition 3 times in a row', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const p = makeAbPlan(seed, 6);
    assert.equal(p.length, 6);
    assert.equal(p.filter((c) => c === ON).length, 3);
    assert.equal(p.filter((c) => c === OFF).length, 3);
    for (let i = 2; i < p.length; i++) assert.ok(!(p[i] === p[i - 1] && p[i] === p[i - 2]), `seed ${seed}`);
  }
  assert.deepEqual(makeAbPlan(5), makeAbPlan(5));
  const orders = new Set(Array.from({ length: 50 }, (_, s) => makeAbPlan(s + 1).join()));
  assert.ok(orders.size > 5, 'orders vary between seeds');
});

test('permutation test: p is small for a real difference and not for noise', () => {
  const rng = mulberry32(11);
  const a = Array.from({ length: 60 }, () => 1 + rng());
  const b = Array.from({ length: 60 }, () => rng());
  const strong = permutationTest(a, b, mean, 999, 3);
  assert.ok(strong.observed > 0.9);
  assert.ok(strong.p <= 0.002, `p ${strong.p}`);

  const c = Array.from({ length: 60 }, () => rng());
  const d = Array.from({ length: 60 }, () => rng());
  const weak = permutationTest(c, d, mean, 999, 3);
  assert.ok(weak.p > 0.05, `p ${weak.p}`);
  assert.deepEqual(permutationTest(c, d, mean, 199, 8), permutationTest(c, d, mean, 199, 8), 'deterministic for a seed');
  assert.ok(Number.isNaN(permutationTest([], d, mean, 10, 1).p));
});

test('false positive rate of the permutation test is about alpha', () => {
  const rng = mulberry32(99);
  let hits = 0;
  const runs = 120;
  for (let r = 0; r < runs; r++) {
    const a = Array.from({ length: 30 }, () => rng());
    const b = Array.from({ length: 30 }, () => rng());
    if (permutationTest(a, b, mean, 199, r + 1).p < 0.05) hits++;
  }
  assert.ok(hits / runs < 0.12, `${hits} of ${runs}`);
});

test('primary hit: endpoint within the target along the flick', () => {
  const trial = { ampDeg: 14, radiusDeg: 1 };
  assert.equal(primaryHit(trial, { ok: true, ratio: 1.05 }), true);   // 0.7 deg off
  assert.equal(primaryHit(trial, { ok: true, ratio: 0.92 }), false);  // 1.12 deg short
  assert.equal(primaryHit(trial, { ok: false, reason: 'blip' }), null);
  assert.equal(primaryHit({}, { ok: true, ratio: 1 }), null);
});

test('metrics and comparison', () => {
  const trials = [
    { ampDeg: 16, radiusDeg: 16 / 14, hit: true, hitMs: 500, clicks: 1 },
    { ampDeg: 16, radiusDeg: 16 / 14, hit: true, hitMs: 700, clicks: 2 },
    { ampDeg: 16, radiusDeg: 16 / 14, hit: false, hitMs: null, clicks: 3 },
  ];
  const analyses = [{ ok: true, ratio: 1.01 }, { ok: true, ratio: 1.3 }, { ok: false, reason: 'blip' }];
  const items = toItems(trials, analyses);
  const m = conditionMetrics(items);
  assert.equal(m.flicks, 3);
  assert.equal(m.segmented, 2);
  assert.equal(m.primaryHits, 1);
  assert.equal(m.primaryRate, 0.5);
  assert.equal(m.medianHitMs, 600);
  assert.equal(m.hits, 2);
  assert.equal(m.shots, 6);
  assert.ok(Math.abs(m.clickAccuracy - 1 / 3) < 1e-12);
  assert.equal(median([3, 1, 2]), 2);
  assert.ok(Number.isNaN(stats.medianHitMs([])));

  // ON clearly better on first-flick accuracy.
  const rng = mulberry32(5);
  const mk = (pHit) => Array.from({ length: 72 }, () => ({ primary: rng() < pHit, hit: true, hitMs: 600 + 100 * rng(), clicks: 1 }));
  const cmp = compareConditions(mk(0.7), mk(0.3), { iters: 999, seed: 2 });
  assert.ok(cmp.on.primaryRate > cmp.off.primaryRate);
  assert.ok(cmp.tests.primaryRate.p < 0.01);
  assert.ok(cmp.tests.medianHitMs.p > 0.01);
  assert.match(abVerdict(cmp), /first-flick accuracy improved/);
  const none = compareConditions(mk(0.5), mk(0.5), { iters: 299, seed: 4 });
  if (Object.values(none.tests).every((t) => !(t.p < 0.05))) assert.match(abVerdict(none), /No difference/);
});
