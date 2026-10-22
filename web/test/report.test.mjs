// Run: node --test "web/test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSession, analysedTrials, analyzeTrials, fitResults, normalizeFit, headlineRows, verdict, overallText,
  binResults, profileFromFit, reasonLabel,
} from '../js/report.js';
import { makeSampleSession } from './make-sample-session.mjs';

const fixture = new URL('./fixtures/sample-session.json', import.meta.url);

test('the committed sample session matches its generator', () => {
  const onDisk = JSON.parse(readFileSync(fixture, 'utf8'));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(makeSampleSession())), 'run: node web/test/make-sample-session.mjs');
});

test('sample session loads and recovers the simulated bias', () => {
  const s = parseSession(readFileSync(fixture, 'utf8'));
  const trials = analysedTrials(s);
  assert.ok(trials.every((t) => !t.warmup));
  const results = analyzeTrials(trials, s.degPerCount);
  const nf = fitResults(results, { nPoints: 16, strength: 1, symmetric: false, bootstrap: 50, seed: 1 }, null);
  assert.ok(!nf.error, nf.error);
  assert.equal(nf.gains8.length, 8);
  // The player overshoots right / down-right and undershoots up-left.
  const rows = headlineRows(nf, null);
  assert.ok(rows[0].gain < 0.97, `right ${rows[0].gain}`);
  assert.ok(rows[3].gain > 1.03, `up-left ${rows[3].gain}`);
  assert.ok(rows[0].biasPct > 0 && rows[3].biasPct < 0);
  if (nf.evidence) assert.equal(verdict(nf).kind, 'pass');
  assert.match(overallText(nf.overallRatio), /overshoot by 3%/);
  const cfg = profileFromFit(nf, s, null, new Date(2026, 9, 21));
  assert.equal(cfg.label, 'cal 2026-10-21');
  assert.equal(cfg.calibDpi, 800);
  assert.equal(cfg.smoothingCounts, 16);
  assert.equal(cfg.nPoints, 16);
});

test('parseSession rejects bad files with readable errors', () => {
  assert.throws(() => parseSession('nope'), /JSON/);
  assert.throws(() => parseSession('{"format":"x"}'), /session/);
  assert.throws(() => parseSession({ format: 'omnisens-session', version: 1, trials: [] }), /no recorded/);
  assert.throws(() => parseSession({ format: 'omnisens-session', version: 1, trials: [{ req: [1], t: [0], x: [0], y: [0] }] }), /damaged/);
  assert.throws(() => parseSession({ format: 'omnisens-session', version: 99, trials: [] }), /newer/);
});

test('normalizeFit fills fields an older fitProfile does not return', () => {
  const results = [
    { ok: true, theta: 0, ratio: 1.1, dist: 500 },
    { ok: true, theta: 180, ratio: 0.9, dist: 500 },
    { ok: false, reason: 'blip' },
  ];
  const old = {
    trials: 2, nPoints: 8, warnings: ['w'],
    directions: [0, 45, 90, 135, 180, 225, 270, 315],
    gains: [0.95, 1, 1, 1, 1.05, 1, 1, 1],
    ci: Array.from({ length: 8 }, () => [0.9, 1.1]),
    curve: [{ theta: 0, demand: 0.9, current: 1 }],
    overallRatio: 1.02,
  };
  const nf = normalizeFit(old, results, null);
  assert.equal(nf.ok, true);
  assert.equal(nf.used, 2);
  assert.deepEqual(nf.rejected, { blip: 1 });
  assert.equal(nf.gains8[0], 0.95);
  assert.deepEqual(nf.ci8[0], [0.9, 1.1]);
  assert.ok(Math.abs(nf.curve[0].ratio - 1 / 0.9) < 1e-12);
  assert.equal(nf.evidence, null);
  assert.equal(verdict(nf).kind, 'info');
  assert.equal(nf.bins8[0].n, 1);
  assert.equal(nf.bins8[0].medianRatio, 1.1);

  const err = normalizeFit({ ok: false, error: 'Need more flicks.' }, results, null);
  assert.equal(err.ok, false);
  assert.equal(verdict(err).kind, 'error');
  assert.equal(err.gains8.length, 8);
  assert.equal(binResults([]).length, 8);
  assert.match(reasonLabel('mouse-lifted'), /lifted/);
  assert.equal(reasonLabel('some-new-code'), 'some new code');
});
