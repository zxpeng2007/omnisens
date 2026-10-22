// view-verify.js - blind A/B test: does the profile help, or does it only feel different?
import { Engine, sanitizeConfig, configGains, FLAG_ENABLED, FLAG_LINEAR } from './omni-core.js';
import { decodeProfile, headlineGains } from './export.js';
import { resolveSensitivity } from './games.js';
import { makeBlocks } from './schedule.js';
import { makeAbPlan, toItems, compareConditions, abVerdict, ON } from './ab-test.js';
import { analyzeTrials, profileFromFit, fmtP } from './report.js';
import { pointerLockSupported } from './capture.js';
import { webHidSupported } from './device.js';
import { $, h, toast, attempt, download, fmt, dateStamp } from './ui.js';

const BLOCKS = 6;
const PER_BLOCK = 24;

let ctx;
let simSource = 'result';
let simPasted = null;
let run = null;   // { plan, blocks, trials, seed, mode, degPerCount, guess, cmp }

export function init(c) {
  ctx = c;
  const rerender = () => { if (ctx.route === 'verify' && !ctx.task.active) render(); };
  ctx.on('device', rerender);
  ctx.on('fit', rerender);
}

export function show() {
  render();
}

function resultCfg() {
  return ctx.fit && ctx.fit.ok && !ctx.fit.error ? profileFromFit(ctx.fit, ctx.session, ctx.devConfig) : null;
}

function testProfile() {
  if (ctx.dev) return ctx.devConfig ? sanitizeConfig(ctx.devConfig) : null;
  return simSource === 'result' ? resultCfg() : simPasted;
}

const isFlat = (cfg) => configGains(cfg).every((g) => Math.abs(g - 1) < 1e-3);

function render() {
  $('#ver-guess').hidden = !(run && run.phase === 'guess');
  $('#ver-result').hidden = !(run && run.phase === 'result');
  if (run?.phase === 'guess') renderGuess();
  if (run?.phase === 'result') renderResult();
  renderSetup();
}

function summary(cfg) {
  return headlineGains(cfg).map((r) => `${r.name} ${r.gain.toFixed(3)}x`).join(', ');
}

function renderSetup() {
  const box = $('#ver-setup');
  const s = ctx.settings;
  const sens = resolveSensitivity(s);
  const kids = [
    h('h2', {}, 'How it works'),
    h('ul', {},
      h('li', {}, `${BLOCKS} blocks of ${PER_BLOCK} targets (about 4 minutes), the same flick task as the calibration.`),
      h('li', {}, 'Three blocks run with the profile ON and three with it OFF, in a random order you are not told.'),
      h('li', {}, 'Compared: how often your first flick lands inside the target, your time to hit, and your click accuracy.'),
      h('li', {}, 'At the end you guess which blocks were ON, then the order is revealed.')),
    h('p', { class: 'muted small' }, sens.ok
      ? `Sensitivity: ${sens.cm360.toFixed(2)} cm/360 at ${s.dpi} DPI (from the Calibrate page).`
      : `Set your sensitivity on the Calibrate page first: ${sens.error}`),
  ];

  if (ctx.dev) {
    const cfg = testProfile();
    kids.push(h('h3', {}, 'Profile under test'));
    if (cfg) {
      kids.push(h('p', {}, `The profile on your adapter${cfg.label ? ` ("${cfg.label}")` : ''}: ${summary(cfg)}.`));
      if (isFlat(cfg)) kids.push(h('p', { class: 'warn-line' }, 'This profile is flat, so ON and OFF are identical. Send a calibration result to the adapter first.'));
    }
    kids.push(h('p', { class: 'muted small' }, 'The adapter LED shows whether correction is on. Cover it or put it out of sight so the test stays blind.'));
  } else {
    kids.push(h('h3', {}, 'No adapter connected'));
    kids.push(h('p', {}, 'The test can apply the profile inside this page instead (the same math the adapter runs, applied to the movement the browser receives). It is a close approximation; with an adapter the test is exact.'));
    const opt = (value, title, text, disabled) => h('label', { class: 'seg-opt' },
      h('input', { type: 'radio', name: 'ver-src', value, checked: simSource === value, disabled, onchange: () => { simSource = value; render(); } }),
      h('span', {}, h('b', {}, title), h('small', {}, text)));
    const hasResult = !!resultCfg();
    if (!hasResult && simSource === 'result') simSource = 'paste';
    kids.push(h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Profile to test' },
      opt('result', 'Latest calibration', hasResult ? `${ctx.fit.nPoints} points` : 'none yet', !hasResult),
      opt('paste', 'Paste a code', simPasted ? `"${simPasted.label || 'unnamed'}" loaded` : 'omni1... or JSON', false)));
    if (simSource === 'paste') {
      const ta = h('textarea', { id: 'ver-paste', rows: 2, spellcheck: 'false' });
      kids.push(h('label', { class: 'field' }, h('span', {}, 'Profile code or JSON'), ta),
        h('button', { class: 'btn', type: 'button', onclick: () => {
          try {
            simPasted = decodeProfile(ta.value);
            render();
          } catch (e) {
            toast(e.message, 'error');
          }
        } }, 'Load'));
    }
    const cfg = testProfile();
    if (cfg) kids.push(h('p', {}, `Testing: ${summary(cfg)}.`));
    if (webHidSupported()) {
      kids.push(h('p', {}, h('button', { class: 'btn ghost', type: 'button', onclick: () => attempt('Connecting', () => ctx.connect()) }, 'Connect adapter instead')));
    }
  }

  const cfg = testProfile();
  const err = h('p', { class: 'error', role: 'alert' });
  const startBtn = h('button', {
    class: 'btn primary big', type: 'button', disabled: !cfg || !sens.ok,
    onclick: () => start(err),
  }, run ? 'Run the test again' : 'Start blind test');
  kids.push(err, h('div', { class: 'cta-row' }, startBtn));
  if (!cfg) kids.push(h('p', { class: 'muted small' }, ctx.dev ? 'Reading the adapter profile...' : 'Calibrate first, or paste a profile code to test.'));
  box.replaceChildren(...kids);
}

function start(errEl) {
  const s = ctx.settings;
  const sens = resolveSensitivity(s);
  const profile = testProfile();
  if (!sens.ok || !profile) return;
  if (!pointerLockSupported()) {
    errEl.textContent = 'This browser cannot capture the mouse (pointer lock). Use a desktop browser with a mouse.';
    return;
  }
  // eslint-disable-next-line no-alert
  if (isFlat(profile) && !window.confirm('The profile is flat, so ON and OFF are the same. Run anyway?')) return;
  if (ctx.task.active) return;

  const cfg = sanitizeConfig({ ...profile, flags: profile.flags | FLAG_ENABLED });
  const applied = { gains: configGains(cfg), linear: !!(cfg.flags & FLAG_LINEAR), rotationCdeg: cfg.rotationCdeg };
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
  const plan = makeAbPlan(seed, BLOCKS);
  const blocks = makeBlocks({ blocks: BLOCKS, perBlock: PER_BLOCK, seed });
  for (const b of blocks) b.label = `Block ${b.index} of ${BLOCKS}`;
  const useDev = !!ctx.dev;
  const cond = (round) => plan[round.index - 1];
  let prevEnabled = null;
  const restore = () => (useDev && ctx.dev && prevEnabled !== null ? ctx.withDevice((d) => d.setEnabled(prevEnabled)) : Promise.resolve());
  const setup = useDev ? (async () => {
    await ctx.refreshDevice();
    prevEnabled = ctx.devStatus.enabled;
    ctx.adapterGuard = { restore };
  })().catch((e) => toast(`Could not read the adapter: ${e.message}`, 'error')) : null;

  run = { phase: 'running', plan, blocks, seed, mode: useDev ? 'adapter' : 'browser', degPerCount: sens.degPerCount, profile: cfg, trials: [] };

  ctx.task.open({
    rounds: blocks,
    degPerCount: sens.degPerCount,
    hFov: s.hFov,
    fullscreen: s.fullscreen,
    getApplied: (round) => (cond(round) === ON ? applied : null),
    getTransform: (round) => {
      if (useDev || cond(round) !== ON) return null;
      const eng = new Engine(cfg);
      return (dx, dy, ts) => eng.process(dx, dy, Math.round(ts * 1000));
    },
    beforeBegin: (task) => (useDev && ctx.dev ? ctx.withDevice((d) => d.setEnabled(plan[task.roundPos] === ON)) : null),
    onPause: () => (useDev ? restore() : null),
    quitText: 'Quit the A/B test? The blocks so far are discarded.',
    intro: {
      title: 'Blind A/B test',
      body: [
        `${BLOCKS} blocks of ${PER_BLOCK} targets. Aim exactly like in the calibration: one fast flick, correct, click.`,
        'Some blocks have the profile on, some off. Do not try to work out which; just aim.',
        useDev ? 'Tip: cover the adapter LED.' : null,
      ],
      button: 'Start block 1',
      busy: setup,
    },
    pauseView: () => ({ title: 'Paused', body: ['The flick in progress was discarded.'], button: 'Continue' }),
    onRoundEnd: (task, info) => ({
      title: `Block ${info.round.index} of ${BLOCKS} done`,
      body: [`${BLOCKS - info.round.index} to go. Relax your hand for a moment if you like.`],
      button: `Start block ${info.round.index + 1}`,
    }),
    onDone: (task) => finish(task, restore, true),
    onQuit: (task) => finish(task, restore, false),
  });
}

async function finish(task, restore, complete) {
  const trials = task.trials.slice();
  ctx.task.close();
  try {
    await restore();
  } catch (e) {
    toast(`Could not restore the adapter state: ${e.message}`, 'error');
  }
  ctx.adapterGuard = null;
  if (!complete) {
    run = null;
    toast('A/B test cancelled.', 'info');
    render();
    return;
  }
  run.trials = trials;
  run.phase = 'guess';
  run.cmp = compute(run);
  render();
  $('#ver-guess h2')?.focus();
}

function compute(r) {
  const outs = r.trials.filter((t) => t.kind === 'out');
  const analyses = analyzeTrials(outs, r.degPerCount);
  const items = toItems(outs, analyses);
  const on = [], off = [];
  outs.forEach((t, i) => (r.plan[t.round - 1] === ON ? on : off).push(items[i]));
  return compareConditions(on, off, { iters: 2000, seed: r.seed });
}

function renderGuess() {
  const box = $('#ver-guess');
  const checks = run.plan.map((_, i) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', value: String(i) }), h('span', {}, `Block ${i + 1}`)));
  const reveal = (useGuess) => {
    run.guess = useGuess ? checks.map((c) => c.querySelector('input').checked) : null;
    run.phase = 'result';
    render();
    $('#ver-result h2')?.focus();
  };
  box.replaceChildren(
    h('h2', { tabindex: '-1' }, 'Before the reveal: which blocks had the profile ON?'),
    h('p', { class: 'muted' }, 'Tick the blocks that felt like the profile was on (three were). If you cannot tell, that is a result too.'),
    h('div', { class: 'checks inline' }, ...checks),
    h('div', { class: 'cta-row' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => reveal(true) }, 'Reveal'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => reveal(false) }, 'Skip guessing')),
  );
}

function renderResult() {
  const box = $('#ver-result');
  const { on, off, tests } = run.cmp;
  const pp = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)} pts` : '-');
  const row = (label, a, b, diff, p, hint) => h('tr', {},
    h('th', { scope: 'row' }, label, hint ? h('small', { class: 'muted block' }, hint) : null),
    h('td', {}, a), h('td', {}, b), h('td', {}, diff), h('td', {}, fmtP(p)));
  const table = h('table', { class: 'values ab' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Metric'), h('th', { scope: 'col' }, 'Profile ON'), h('th', { scope: 'col' }, 'Profile OFF'), h('th', { scope: 'col' }, 'ON - OFF'), h('th', { scope: 'col' }, 'p-value'))),
    h('tbody', {},
      row('First flick lands in target', `${fmt.rate(on.primaryRate)} (${on.primaryHits}/${on.segmented})`, `${fmt.rate(off.primaryRate)} (${off.primaryHits}/${off.segmented})`, pp(tests.primaryRate.observed), tests.primaryRate.p, 'higher is better'),
      row('Median time to hit', fmt.ms(on.medianHitMs), fmt.ms(off.medianHitMs), Number.isFinite(tests.medianHitMs.observed) ? `${tests.medianHitMs.observed > 0 ? '+' : ''}${Math.round(tests.medianHitMs.observed)} ms` : '-', tests.medianHitMs.p, 'lower is better'),
      row('Click accuracy', `${fmt.rate(on.clickAccuracy)} (${on.hits}/${on.shots})`, `${fmt.rate(off.clickAccuracy)} (${off.hits}/${off.shots})`, pp(tests.clickAccuracy.observed), tests.clickAccuracy.p, 'hits / shots'),
      row('Flicks', String(on.flicks), String(off.flicks), '', NaN, null)));

  const order = h('ol', { class: 'block-order' }, ...run.plan.map((c, i) => {
    const guessed = run.guess ? run.guess[i] : null;
    const mark = guessed === null ? '' : (guessed === (c === ON) ? ' (you got this one)' : ' (you guessed wrong)');
    return h('li', { class: c === ON ? 'on' : 'off' }, `Block ${i + 1}: profile ${c === ON ? 'ON' : 'OFF'}${mark}`);
  }));
  const kids = [
    h('h2', { tabindex: '-1' }, 'Result'),
    h('p', { class: 'lead-sm' }, abVerdict(run.cmp)),
    h('div', { class: 'table-wrap' }, table),
    h('p', { class: 'muted small' }, `p-values from a permutation test (2000 shuffles). Below 0.05 means a difference this large rarely happens by chance. With about ${PER_BLOCK * 3} flicks per condition only fairly large effects show up; run the test again on another day for more certainty.${run.mode === 'browser' ? ' Profile applied in the browser (no adapter).' : ''}`),
    h('h3', {}, 'Block order'),
    order,
  ];
  if (run.guess) {
    const correct = run.plan.filter((c, i) => run.guess[i] === (c === ON)).length;
    kids.push(h('p', {}, `You classified ${correct} of ${BLOCKS} blocks correctly (pure guessing averages ${BLOCKS / 2}).`));
  }
  kids.push(h('div', { class: 'btn-row wrap' },
    h('button', { class: 'btn', type: 'button', onclick: () => download(`omnisens-ab-${dateStamp()}.json`, JSON.stringify({ format: 'omnisens-ab', version: 1, created: new Date().toISOString(), mode: run.mode, plan: run.plan, degPerCount: run.degPerCount, profile: run.profile, trials: run.trials })) }, 'Download test data')));
  box.replaceChildren(...kids);
}
