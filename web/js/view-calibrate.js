// view-calibrate.js - landing page, setup form and the calibration session.
import { GAMES, gameById, defaultFov, resolveSensitivity } from './games.js';
import { makeCalibrationPlan, roundsFor } from './schedule.js';
import { makeSession } from './report.js';
import { configGains, FLAG_LINEAR } from './omni-core.js';
import { webHidSupported } from './device.js';
import { pointerLockSupported } from './capture.js';
import { $, $$, h, toast, attempt, readFile, fmt } from './ui.js';

let ctx;

export function init(c) {
  ctx = c;
  const sel = $('#f-game');
  for (const g of GAMES) sel.append(h('option', { value: g.id }, g.name));
  fillForm();

  sel.addEventListener('change', () => {
    ctx.settings.game = sel.value;
    ctx.settings.hFov = defaultFov(sel.value);
    $('#f-fov').value = ctx.settings.hFov;
    commit();
  });
  const bindNum = (id, key) => $(id).addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (e.target.value !== '' && Number.isFinite(v)) ctx.settings[key] = v;
    commit();
  });
  bindNum('#f-sens', 'sens');
  bindNum('#f-yaw', 'customYaw');
  bindNum('#f-r6', 'r6Multiplier');
  bindNum('#f-cm', 'cm360');
  bindNum('#f-dpi', 'dpi');
  bindNum('#f-fov', 'hFov');
  bindNum('#f-rounds', 'customRounds');
  for (const r of $$('input[name="preset"]')) {
    r.addEventListener('change', () => { ctx.settings.preset = r.value; commit(); });
  }
  $('#f-fullscreen').addEventListener('change', (e) => { ctx.settings.fullscreen = e.target.checked; commit(); });

  $('#cal-cta').addEventListener('click', () => {
    $('#cal-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#f-game').focus({ preventScroll: true });
  });
  $('#cal-demo').addEventListener('click', () => attempt('Loading the example', () => ctx.loadSample()));
  $('#cal-load').addEventListener('change', (e) => loadFile(e.target));
  $('#cal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    start();
  });
  ctx.on('device', () => { if (ctx.route === 'calibrate') renderAdapter(); });
}

export function show() {
  fillForm();
  renderAdapter();
}

export async function loadFile(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  await attempt('Loading the session', async () => ctx.loadSessionText(await readFile(file)));
}

function fillForm() {
  const s = ctx.settings;
  $('#f-game').value = s.game;
  $('#f-sens').value = s.sens;
  $('#f-yaw').value = s.customYaw;
  $('#f-r6').value = s.r6Multiplier;
  $('#f-cm').value = s.cm360;
  $('#f-dpi').value = s.dpi;
  $('#f-fov').value = s.hFov;
  $('#f-rounds').value = s.customRounds;
  $('#f-fullscreen').checked = s.fullscreen;
  for (const r of $$('input[name="preset"]')) r.checked = r.value === s.preset;
  updateDerived();
}

function commit() {
  ctx.saveSettings();
  updateDerived();
}

function updateDerived() {
  const s = ctx.settings;
  const g = gameById(s.game);
  $('#w-sens').hidden = s.game === 'cm360';
  $('#w-yaw').hidden = s.game !== 'custom';
  $('#w-r6').hidden = !g?.multiplier;
  $('#w-cm').hidden = s.game !== 'cm360';
  $('#w-rounds').hidden = s.preset !== 'custom';
  $('#f-sens-label').textContent = g?.sensLabel || 'In-game sensitivity';
  $('#f-note').textContent = g?.note || '';
  const r = resolveSensitivity(s);
  const calc = $('#f-calc');
  if (r.ok) {
    calc.className = 'calc';
    calc.textContent = `= ${r.cm360.toFixed(2)} cm/360 (${(r.cm360 / 2.54).toFixed(2)} in) · ${r.degPerCount.toPrecision(4)} deg per count`;
  } else {
    calc.className = 'calc bad';
    calc.textContent = r.error;
  }
}

function renderAdapter() {
  const box = $('#cal-adapter');
  const rawNote = 'If an omnisens adapter is plugged in, connect it here or disable it (hold Left + Right + Middle for 3 s; the LED flashes three times, then turns off, or dim red on RGB boards; boards without an LED give no sign) so the measurement sees your raw hand movement.';
  if (!webHidSupported()) {
    box.replaceChildren(
      h('p', {}, 'No adapter needed to find your values: you can copy them or export them to Raw Accel afterwards.'),
      h('p', { class: 'muted small' }, `This browser cannot talk to the adapter (WebHID needs desktop Chrome, Edge or Opera). ${rawNote}`),
    );
    return;
  }
  if (!ctx.dev) {
    box.replaceChildren(
      h('p', {}, 'No adapter connected. That is fine: you can still find your values and export them.'),
      h('p', { class: 'muted small' }, rawNote),
      h('button', { class: 'btn', type: 'button', onclick: () => attempt('Connecting', () => ctx.connect()) }, 'Connect adapter'),
    );
    return;
  }
  const st = ctx.devStatus;
  const cfg = ctx.devConfig;
  const flat = cfg ? configGains(cfg).every((g) => Math.abs(g - 1) < 1e-3) : true;
  const opt = (value, title, text) => h('label', { class: 'seg-opt' },
    h('input', { type: 'radio', name: 'adapter-mode', value, checked: ctx.settings.adapterMode === value, onchange: () => { ctx.settings.adapterMode = value; ctx.saveSettings(); } }),
    h('span', {}, h('b', {}, title), h('small', {}, text)));
  box.replaceChildren(
    h('p', {}, `Adapter connected${st ? ` (firmware ${st.firmware}, correction ${st.enabled ? 'on' : 'off'})` : ''}${cfg?.label ? `, profile "${cfg.label}"` : ''}.`),
    h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Calibration mode' },
      opt('fresh', 'Fresh calibration', 'Bypass the adapter while measuring; build a new profile from your raw hand movement.'),
      opt('refine', 'Refine current profile', flat ? 'Your adapter profile is flat, so this is the same as fresh.' : 'Keep the current profile on and correct what is left over.')),
    h('p', { class: 'muted small' }, 'The adapter is put back the way it was when the session ends or pauses. If you close the page mid-session, unplug and replug the adapter to restore it.'),
  );
}

// ------------------------------------------------------------------ session

function start() {
  const err = $('#cal-error');
  err.textContent = '';
  const s = ctx.settings;
  const sens = resolveSensitivity(s);
  if (!sens.ok) {
    err.textContent = sens.error;
    return;
  }
  if (!pointerLockSupported()) {
    err.textContent = 'This browser cannot capture the mouse (pointer lock). Use a desktop browser with a mouse.';
    return;
  }
  if (ctx.task.active) return;

  const rounds = roundsFor(s.preset, s.customRounds);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
  const plan = makeCalibrationPlan({ rounds, seed });
  for (const r of plan) r.label = r.warmup ? 'Warm-up' : `Round ${r.index} of ${rounds}`;
  const session = makeSession({ settings: s, degPerCount: sens.degPerCount, cm360: sens.cm360, seed, plan });

  // Adapter handling: fresh = bypass while measuring, refine = keep the profile on.
  const dev = ctx.dev;
  let prevEnabled = null;
  let sessionEnabled = null;
  const setEnabled = (on) => (ctx.dev && on !== null ? ctx.withDevice((d) => d.setEnabled(on)) : null);
  const restore = () => setEnabled(prevEnabled) || Promise.resolve();
  const enter = () => setEnabled(sessionEnabled);

  const setup = (async () => {
    if (!dev) return;
    session.adapter = s.adapterMode;
    await ctx.refreshDevice();
    prevEnabled = ctx.devStatus.enabled;
    if (s.adapterMode === 'refine') {
      const cfg = ctx.devConfig;
      session.current = { gains: configGains(cfg), linear: !!(cfg.flags & FLAG_LINEAR), rotationCdeg: cfg.rotationCdeg };
      sessionEnabled = true;
    } else {
      sessionEnabled = false;
    }
    ctx.adapterGuard = { restore };
    await enter();
  })().catch((e) => {
    session.adapter = 'error';
    session.current = null;
    sessionEnabled = null;
    toast(`Could not switch the adapter: ${e.message}. Disable it with the button chord (Left + Right + Middle for 3 s) before you start.`, 'error');
  });

  const stats = (task) => {
    const st = task.statsFor((t) => !t.warmup);
    return `${st.flicks} measured flicks so far, ${fmt.rate(st.hitRate)} hit.`;
  };
  const adapterLine = !dev ? null : s.adapterMode === 'refine'
    ? 'Your current adapter profile stays on; the result refines it.'
    : 'The adapter is bypassed while you flick and restored afterwards.';

  ctx.task.open({
    rounds: plan,
    degPerCount: sens.degPerCount,
    hFov: s.hFov,
    fullscreen: s.fullscreen,
    getApplied: () => session.current,
    getTransform: () => null,
    beforeBegin: () => enter(),
    onPause: () => restore(),
    quitText: 'Quit the calibration? Finished rounds are kept and analysed.',
    intro: {
      title: 'Warm-up',
      body: [
        `${plan[0].targets.length} warm-up targets (not measured), then ${rounds} rounds of ${plan[1].targets.length}. Sensitivity: ${sens.cm360.toFixed(2)} cm/360.`,
        h('ul', { class: 'task-steps' },
          h('li', {}, 'Shoot the orange centre target to start.'),
          h('li', {}, 'Flick to each teal target in one fast motion, correct, click.'),
          h('li', {}, 'Then flick back to the centre. Repeat. Esc pauses.')),
        adapterLine,
      ],
      button: 'Click to start',
      busy: setup,
    },
    pauseView: (task) => ({
      title: 'Paused',
      body: [stats(task), 'The flick in progress was discarded. Continue when ready.'],
      button: 'Continue',
    }),
    onRoundEnd: (task, info) => {
      const left = plan.length - task.roundPos;
      const r = task.statsFor((t) => t.round === info.round.index);
      return {
        title: info.round.warmup ? 'Warm-up done' : `Round ${info.round.index} of ${rounds} done`,
        body: [
          `This round: ${r.flicks} flicks, ${fmt.rate(r.hitRate)} hit, ${fmt.rate(r.accuracy)} click accuracy.`,
          stats(task),
          `${left} round${left === 1 ? '' : 's'} left. Take a short break if you like.`,
        ],
        button: `Start ${info.next?.label || 'next round'}`,
        busy: restore(),
      };
    },
    onDone: (task) => finish(task, session, restore, true),
    onQuit: (task) => finish(task, session, restore, false),
  });
}

async function finish(task, session, restore, complete) {
  session.trials = task.trials.slice();
  const modes = task.modes;
  session.inputMode = modes.has('accel') ? (modes.has('raw') ? 'mixed' : 'accel') : modes.has('raw') ? 'raw' : null;
  ctx.task.close();
  try {
    await restore();
  } catch (e) {
    toast(`Could not restore the adapter state: ${e.message}`, 'error');
  }
  ctx.adapterGuard = null;
  const measured = session.trials.filter((t) => !t.warmup && t.kind === 'out').length;
  if (!complete && measured === 0) {
    toast('Calibration cancelled. Nothing was measured yet.', 'info');
    return;
  }
  toast('Analysing your flicks...', 'info', 2000);
  setTimeout(() => {
    try {
      ctx.setSession(session);
    } catch (e) {
      toast(`Analysis failed: ${e.message}. Download the session and report it.`, 'error');
      ctx.session = session;
    }
    ctx.navigate('results');
  }, 50);
}
