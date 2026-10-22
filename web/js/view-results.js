// view-results.js - verdict, the 8 headline values, polar charts, tuning and actions.
import { DIR8, gainAt } from './omni-core.js';
import { encodeProfile, profileJson, rawAccelSettings, headlineText } from './export.js';
import { headlineRows, verdict, overallText, reasonLabel, profileFromFit } from './report.js';
import { gameById } from './games.js';
import { polarChart, legend } from './plot.js';
import { $, $$, h, toast, attempt, download, copyWithToast, fmt, debounce, dateStamp } from './ui.js';
import { loadFile } from './view-calibrate.js';
import { isDesktop } from './desktop.js';

let ctx;
let sent = false;

export function init(c) {
  ctx = c;
  ctx.on('fit', () => { if (ctx.route === 'results') render(); });
  ctx.on('session', () => { sent = false; });
  ctx.on('device', () => { if (ctx.route === 'results' && ctx.fit) renderActions(); });
  ctx.on('desktop', () => { if (ctx.route === 'results' && ctx.fit) renderActions(); });

  $('#res-load').addEventListener('change', (e) => loadFile(e.target));
  $('#res-demo').addEventListener('click', () => attempt('Loading the example', () => ctx.loadSample()));

  const strength = $('#c-strength');
  const refitSoon = debounce(() => ctx.refit(), 60);
  strength.addEventListener('input', () => {
    ctx.settings.strength = Number(strength.value) / 100;
    $('#c-strength-out').textContent = `${strength.value}%`;
    ctx.saveSettings();
    refitSoon();
  });
  $('#c-symmetric').addEventListener('change', (e) => {
    ctx.settings.symmetric = e.target.checked;
    ctx.saveSettings();
    slowRefit();
  });
  for (const r of $$('input[name="c-res"]')) {
    r.addEventListener('change', () => {
      ctx.settings.nPoints = Number(r.value);
      ctx.saveSettings();
      ctx.refit();
    });
  }
  $('#c-force').addEventListener('change', (e) => {
    ctx.force = e.target.checked;
    ctx.refit();
  });

  $('#res-copy-values').addEventListener('click', () => {
    const rows = headlineRows(ctx.fit, ctx.session.current);
    copyWithToast(`${headlineText(rows)}\nProfile code: ${encodeProfile(profile())}`, 'Values copied');
  });
  $('#res-copy-code').addEventListener('click', () => copyWithToast(encodeProfile(profile()), 'Profile code copied'));
  $('#act-send').addEventListener('click', send);
  $('#act-pc').addEventListener('click', () => {
    ctx.pcPick = 'result';
    ctx.navigate('pc');
  });
  $('#act-save').addEventListener('click', () => attempt('Saving to flash', async () => {
    await ctx.withDevice((d) => d.save());
    await ctx.refreshDevice();
    toast('Saved. The adapter keeps this profile after unplugging.', 'ok');
    $('#act-save').hidden = true;
  }));
  $('#act-json').addEventListener('click', () => download(`omnisens-profile-${dateStamp()}.json`, profileJson(profile())));
  $('#act-rawaccel').addEventListener('click', () => {
    download('settings.json', rawAccelSettings(profile()));
    toast('Back up your current Raw Accel settings.json before replacing it. See Export for the steps.', 'info', 7000);
  });
  $('#act-session').addEventListener('click', () => {
    if (ctx.session) download(`omnisens-session-${dateStamp()}.json`, JSON.stringify(ctx.session));
  });
}

export function show() {
  render();
}

function profile() {
  return profileFromFit(ctx.fit, ctx.session, ctx.devConfig);
}

function slowRefit() {
  $('#c-status').textContent = 'Updating...';
  setTimeout(() => {
    ctx.refit();
    $('#c-status').textContent = '';
  }, 20);
}

async function send() {
  await attempt('Sending to the adapter', async () => {
    const cfg = profile();
    await ctx.withDevice((d) => d.writeConfig(cfg));
    await ctx.refreshDevice();
    sent = true;
    $('#act-save').hidden = false;
    toast('Sent. The adapter uses the new profile now. Save to flash to keep it after unplugging.', 'ok', 6000);
    $('#act-save').focus();
  });
}

/** The session was recorded on top of a profile (adapter or this PC) that the result refines. */
const refining = (s) => s.adapter === 'refine' || s.desktop === 'refine';

function render() {
  const nf = ctx.fit;
  const s = ctx.session;
  $('#res-empty').hidden = !!s;
  $('#res-body').hidden = !s;
  if (!s) {
    $('#res-meta').textContent = '';
    return;
  }
  renderMeta(s);
  if (!nf) {
    $('#res-verdict').replaceChildren(h('h2', {}, 'Analysis failed'), h('p', {}, 'The session could not be analysed. Download it below and open an issue on GitHub.'));
    return;
  }
  renderVerdict(nf, s);
  // Without a usable fit there are no values to show; keep the verdict and the session download.
  const usable = !nf.error;
  for (const sel of ['.headline', '.controls', '.charts']) $(`#res-body ${sel}`).hidden = !usable;
  if (usable) {
    renderTable(nf, s);
    renderControls(nf);
    renderCharts(nf, s);
  }
  renderActions();
}

function renderMeta(s) {
  const st = s.settings || {};
  const game = gameById(st.game);
  const parts = [];
  if (s.created) parts.push(new Date(s.created).toLocaleString());
  if (game) parts.push(st.game === 'cm360' ? `${Number(s.cm360).toFixed(2)} cm/360` : `${game.name}, sens ${st.sens} @ ${s.dpi} DPI (${Number(s.cm360).toFixed(2)} cm/360)`);
  const measured = s.trials.filter((t) => !t.warmup).length;
  parts.push(`${measured} flicks recorded`);
  parts.push(s.adapter === 'refine' ? 'refined the adapter profile'
    : s.adapter === 'fresh' ? 'adapter bypassed'
      : s.desktop === 'refine' ? 'refined the profile on this PC'
        : s.desktop === 'fresh' ? 'correction on this PC paused'
          : 'no adapter');
  if (s.simulated) parts.push('simulated example data');
  $('#res-meta').textContent = parts.join(' · ');
}

function renderVerdict(nf, s) {
  const v = verdict(nf, refining(s));
  const card = $('#res-verdict');
  card.className = `card verdict verdict-${v.kind}`;
  const icon = { pass: '✓', flat: '≈', error: '!', info: 'i' }[v.kind];
  const kids = [
    h('div', { class: 'verdict-head' },
      h('span', { class: 'verdict-icon', 'aria-hidden': 'true' }, icon),
      h('div', {}, h('h2', {}, v.title), h('p', {}, v.text))),
  ];
  const facts = h('ul', { class: 'facts' });
  const nRej = nf.total - nf.used;
  facts.append(h('li', {}, h('b', {}, `${nf.used}`), ` of ${nf.total} flicks used`));
  if (Number.isFinite(nf.overallRatio)) facts.append(h('li', {}, overallText(nf.overallRatio)));
  kids.push(facts);
  if (nRej > 0) {
    const list = h('ul', {}, ...Object.entries(nf.rejected).sort((a, b) => b[1] - a[1])
      .map(([code, n]) => h('li', {}, `${n} × ${reasonLabel(code)}`)));
    kids.push(h('details', { class: 'more' }, h('summary', {}, `Why ${nRej} flick${nRej === 1 ? ' was' : 's were'} not used`), list));
  }
  if (s.inputMode === 'accel' || s.inputMode === 'mixed') {
    kids.push(h('p', { class: 'warn-line' }, 'Recorded without raw input: OS pointer acceleration may have distorted the measurement. Recalibrate in Chrome or Edge with "Enhance pointer precision" off for best results.'));
  }
  if (!nf.error && !nf.applied) {
    kids.push(h('p', { class: 'muted small' }, `The values below equal your ${refining(s) ? 'current profile' : 'flat profile (1.000x everywhere)'}. Tick "Apply anyway" under Tune to see the measured pattern.`));
  }
  if (nf.warnings.length) kids.push(h('ul', { class: 'warnings' }, ...nf.warnings.map((w) => h('li', {}, w))));
  card.replaceChildren(...kids);
}

function renderTable(nf, s) {
  const rows = headlineRows(nf, s.current);
  const table = $('#res-table');
  const head = h('thead', {}, h('tr', {},
    h('th', { scope: 'col' }, 'Direction'),
    h('th', { scope: 'col' }, 'Multiplier'),
    h('th', { scope: 'col' }, 'Change vs now'),
    h('th', { scope: 'col' }, '90% range'),
    h('th', { scope: 'col' }, 'Measured bias'),
    h('th', { scope: 'col', class: 'num-n' }, 'Flicks')));
  const body = h('tbody');
  for (const r of rows) {
    const bar = h('span', { class: `delta ${r.changePct >= 0 ? 'up' : 'down'}`, 'aria-hidden': 'true' });
    bar.style.width = `${Math.min(50, Math.abs(r.changePct) * 3.3).toFixed(1)}%`;
    body.append(h('tr', {},
      h('th', { scope: 'row' }, h('span', { class: 'dir-arrow', 'aria-hidden': 'true' }, arrow(r.theta)), r.name),
      h('td', { class: 'mult' }, fmt.gain(r.gain)),
      h('td', { class: 'chg' }, h('span', { class: 'delta-track', 'aria-hidden': 'true' }, bar), fmt.pct(r.changePct)),
      h('td', { class: 'ci' }, fmt.ci(r.ci)),
      h('td', {}, r.biasPct === null ? '-' : `${fmt.pct(r.biasPct)} ${r.biasPct > 0 ? 'over' : r.biasPct < 0 ? 'under' : ''}`),
      h('td', { class: 'num-n' }, r.n ?? '-')));
  }
  table.replaceChildren(head, body);

  const pts = $('#res-points');
  pts.querySelector('summary').textContent = `All ${nf.nPoints} adapter points`;
  const tb = h('tbody', {}, ...nf.directions.map((d, k) => h('tr', {},
    h('th', { scope: 'row' }, `${Number(d.toFixed(1))}°`),
    h('td', { class: 'mult' }, fmt.gain(nf.gains[k])),
    h('td', { class: 'ci' }, fmt.ci(nf.ci[k])))));
  pts.querySelector('.table-wrap').replaceChildren(h('table', { class: 'values compact' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Angle'), h('th', { scope: 'col' }, 'Multiplier'), h('th', { scope: 'col' }, '90% range'))), tb));
}

const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
function arrow(theta) {
  return ARROWS[Math.round(theta / 45) % 8];
}

function renderControls(nf) {
  const s = ctx.settings;
  const strength = $('#c-strength');
  strength.value = Math.round(s.strength * 100);
  $('#c-strength-out').textContent = `${strength.value}%`;
  $('#c-symmetric').checked = s.symmetric;
  for (const r of $$('input[name="c-res"]')) r.checked = Number(r.value) === s.nPoints;
  const failed = !!nf.evidence && !nf.evidence.passed;
  $('#w-force').hidden = !(failed || ctx.force);
  $('#c-force').checked = ctx.force;
}

function renderCharts(nf, s) {
  const ratio = nf.curve.filter((c) => Number.isFinite(c.ratio)).map((c) => ({ theta: c.theta, v: c.ratio }));
  const bins = nf.bins8.map((b, k) => ({
    theta: b.theta, v: b.medianRatio, cls: 'pc-measured',
    title: b.medianRatio === null ? '' : `${DIR8[k]}: first flick ${(b.medianRatio * 100).toFixed(1)}% of the distance (median of ${b.n})`,
  }));
  const bias = polarChart({
    title: 'Your bias by direction',
    desc: 'Primary flick extent relative to the target distance for each direction. 1.00 is perfect; larger is overshoot. The table above lists the same directions.',
    series: ratio.length ? [{ data: ratio, cls: 'pc-fit', width: 2.5 }] : [],
    dots: bins,
    unitLabel: '1.00 perfect',
  });
  $('#chart-bias').innerHTML = bias.svg;
  $('#legend-bias').innerHTML = legend([
    ...(ratio.length ? [{ cls: 'k-fit', label: 'Fitted pattern' }] : []),
    { cls: 'k-measured', kind: 'dot', label: 'Median per direction' },
    { cls: 'k-unit', kind: 'dash', label: 'Perfect (1.00)' },
  ]);

  const cur = (th) => (s.current ? gainAt(s.current.gains, th, s.current.linear) : 1);
  const recData = nf.curve.length
    ? nf.curve.map((c) => ({ theta: c.theta, v: c.recommended }))
    : sampleGains(nf.gains);
  const curData = nf.curve.length
    ? nf.curve.map((c) => ({ theta: c.theta, v: c.current }))
    : sampleGains(null, cur);
  const rec = polarChart({
    title: 'Recommended sensitivity by direction',
    desc: 'Recommended multiplier per hand direction compared with the current profile, with 90% uncertainty ranges. The table above lists the values.',
    series: [
      { data: curData, cls: 'pc-current', width: 1.5, dash: '5 4' },
      { data: recData, cls: 'pc-rec', width: 2.5 },
    ],
    whiskers: nf.ci8.map((c, k) => (c ? { theta: k * 45, lo: c[0], hi: c[1], cls: 'pc-ci' } : null)).filter(Boolean),
    dots: nf.gains8.map((g, k) => ({ theta: k * 45, v: g, cls: 'pc-rec-dot', r: 3.5, title: `${DIR8[k]}: ${g.toFixed(3)}x` })),
    unitLabel: '1.00x',
    format: (v) => `${v.toFixed(2)}x`,
  });
  $('#chart-rec').innerHTML = rec.svg;
  $('#legend-rec').innerHTML = legend([
    { cls: 'k-rec', label: 'Recommended' },
    { cls: 'k-current', kind: 'dash', label: 'Current' },
    { cls: 'k-ci', label: '90% range' },
  ]);
}

function sampleGains(gains, fn) {
  const data = [];
  for (let a = 0; a <= 360; a += 3) data.push({ theta: a, v: gains ? gainAt(gains, a, false) : fn(a) });
  return data;
}

function renderActions() {
  const nf = ctx.fit;
  if (!nf) return;
  const sendBtn = $('#act-send');
  const pcBtn = $('#act-pc');
  const hint = $('#act-hint');
  const usable = nf.ok && !nf.error;
  for (const id of ['#act-json', '#act-rawaccel', '#res-copy-code', '#res-copy-values']) $(id).disabled = !usable;
  // Inside the omnisens app (and where it can apply profiles) "Apply on this PC" sits next to the adapter.
  const pc = isDesktop() && ['rawaccel', 'engine'].includes(ctx.desktop?.method);
  pcBtn.hidden = !pc;
  pcBtn.disabled = !usable || !nf.applied;
  pcBtn.classList.toggle('primary', pc && !ctx.dev);
  sendBtn.classList.toggle('primary', !pc || !!ctx.dev);
  sendBtn.disabled = !ctx.dev || !usable || !nf.applied;
  if (!ctx.dev && !pc) {
    hint.textContent = 'Connect an adapter on the Adapter page to send the profile. Without one, copy the values or export them (Raw Accel works on Windows).';
  } else if (!usable) {
    hint.textContent = 'Nothing to use yet: record more flicks. You can download this session and re-analyse it later.';
  } else if (!nf.applied) {
    hint.textContent = 'Nothing to change: no reliable directional bias, so your profile stays as it is. Tick "Apply anyway" to use the measured pattern.';
  } else if (ctx.dev) {
    hint.textContent = `Sends ${nf.nPoints} points, direction smoothing for ${ctx.session.dpi} DPI, and keeps the adapter's rotation and toggle settings.`;
  } else {
    hint.textContent = ctx.desktop?.method === 'rawaccel'
      ? 'Apply on this PC shows how close Raw Accel gets to this profile before anything changes. To use an adapter instead, connect it on the Adapter page.'
      : 'Apply on this PC runs this profile on this computer. To use an adapter instead, connect it on the Adapter page.';
  }
  $('#act-save').hidden = !(sent && ctx.dev && ctx.devStatus?.dirty !== false);
}
