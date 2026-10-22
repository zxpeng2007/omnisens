// view-device.js - adapter status, live view, profile editor and maintenance (WebHID).
import {
  sanitizeConfig, configGains, gainsToQ12, gainAt, directionName,
  FLAG_ENABLED, FLAG_LINEAR, FLAG_CHORD_TOGGLE, GAIN_ONE, MAX_POINTS,
} from './omni-core.js';
import { webHidSupported } from './device.js';
import { encodeProfile, decodeProfile } from './export.js';
import { polarChart, sampleCurve } from './plot.js';
import { $, h, toast, attempt, copyWithToast, fmt } from './ui.js';

const LIVE_MS = 66;        // about 15 Hz
const STATUS_MS = 1000;
const G_MIN = 0.5, G_MAX = 2.0;

let ctx;
let edit = null;           // config being edited (sanitized)
let editDirty = false;
let liveScale = null;
let liveKey = '';
let polling = false;

export function init(c) {
  ctx = c;
  ctx.on('device', () => { if (ctx.route === 'device') render(); });

  $('#dev-connect').addEventListener('click', () => attempt('Connecting', async () => {
    await ctx.connect();
    startPolling();
  }));
  $('#dev-disconnect').addEventListener('click', () => attempt('Disconnecting', () => ctx.disconnect()));
  $('#dev-refresh').addEventListener('click', () => attempt('Reading the adapter', () => ctx.refreshDevice()));
  $('#dev-toggle').addEventListener('click', () => attempt('Switching correction', async () => {
    const on = !ctx.devStatus?.enabled;
    await ctx.withDevice((d) => d.setEnabled(on));
    await ctx.refreshDevice();
    toast(on ? 'Correction on.' : 'Correction off: the adapter passes your mouse through unchanged.', 'ok');
  }));
  $('#dev-reset-counters').addEventListener('click', () => attempt('Resetting counters', () => ctx.withDevice((d) => d.resetCounters())));

  const form = $('#dev-editor');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    apply();
  });
  form.addEventListener('input', onEditorInput);
  form.addEventListener('change', onEditorInput);
  $('#ed-save').addEventListener('click', () => attempt('Saving to flash', async () => {
    if (editDirty) await ctx.withDevice((d) => d.writeConfig(edit));
    await ctx.withDevice((d) => d.save());
    editDirty = false;
    await ctx.refreshDevice();
    toast('Saved to flash. The adapter keeps this profile after unplugging.', 'ok');
  }));
  $('#ed-revert').addEventListener('click', () => attempt('Reverting', async () => {
    await ctx.withDevice((d) => d.revert());
    editDirty = false;
    await ctx.refreshDevice();
    toast('Reverted to the profile saved in flash.', 'ok');
  }));
  $('#ed-copy').addEventListener('click', () => copyWithToast(encodeProfile(edit), 'Profile code copied'));
  $('#ed-import-toggle').addEventListener('click', (e) => {
    const box = $('#ed-import');
    box.hidden = !box.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
    if (!box.hidden) $('#ed-import-text').focus();
  });
  $('#ed-import-go').addEventListener('click', () => {
    try {
      edit = decodeProfile($('#ed-import-text').value);
      editDirty = true;
      renderEditor();
      toast('Profile loaded into the editor. Press Apply to use it.', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  $('#dev-defaults').addEventListener('click', () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Load factory defaults (flat profile) into the adapter? Save to flash afterwards to make it stick.')) return;
    attempt('Loading defaults', async () => {
      await ctx.withDevice((d) => d.loadDefaults());
      editDirty = false;
      await ctx.refreshDevice();
      toast('Factory defaults loaded (not saved yet).', 'ok');
    });
  });
  $('#dev-bootloader').addEventListener('click', () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Restart the adapter into its firmware-update mode? Your mouse stops working through it until you copy a .uf2 file onto the RPI-RP2 / RP2350 drive (or unplug and replug it).')) return;
    attempt('Entering the bootloader', async () => {
      await ctx.withDevice((d) => d.enterBootloader());
      toast('A drive named RPI-RP2 or RP2350 should appear. Drag the .uf2 from the GitHub Releases page onto it.', 'info', 12000);
    });
  });
}

export function show() {
  render();
  startPolling();
}

export function hide() {
  polling = false;
}

function render() {
  const supported = webHidSupported();
  $('#dev-unsupported').hidden = supported;
  $('#dev-disconnected').hidden = !supported || !!ctx.dev;
  $('#dev-connected').hidden = !ctx.dev;
  if (!ctx.dev) return;
  renderStatus();
  if (ctx.devConfig && (!edit || !editDirty)) {
    edit = sanitizeConfig(ctx.devConfig);
    editDirty = false;
    renderEditor();
  }
  renderLiveChart();
  if (ctx.route === 'device') startPolling();
}

function renderStatus() {
  const st = ctx.devStatus;
  const dl = $('#dev-status');
  if (!st) {
    dl.replaceChildren(h('dt', {}, 'Status'), h('dd', {}, 'reading...'));
    return;
  }
  const rows = [
    ['Firmware', `${st.firmware} (protocol ${st.protocol})`],
    ['Board', st.board || `id ${st.boardId}`],
    ['Mouse', st.mouseAttached ? `attached, ${fmt.hex4(st.mouseVid)}:${fmt.hex4(st.mousePid)}` : 'none attached'],
    ['Report rate', st.mouseAttached ? `${st.reportRate} reports/s` : '-'],
    ['Keyboard passthrough', st.keyboardAttached ? 'yes (macro keys work)' : 'no'],
    ['Correction', st.enabled ? 'on' : 'off (passthrough)'],
    ['Unsaved changes', st.dirty ? 'yes: Save to flash to keep them' : 'no'],
    ['Saved profile', st.saved ? `yes (${st.saveCount} saves)` : 'none (factory defaults)'],
    ['Uptime', `${Math.floor(st.uptimeMs / 60000)} min`],
  ];
  dl.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  const warns = [];
  if (!st.mouseAttached) warns.push('No mouse detected on the adapter. Plug the mouse (or its receiver) into the adapter\'s USB host port.');
  if (st.bootFallback) warns.push('The mouse is running in boot-protocol fallback because its full report format could not be used. Motion and buttons still work, but very fast movement may be limited and extra buttons may be missing. Please report your mouse model on GitHub.');
  $('#dev-warnings').replaceChildren(...warns.map((w) => h('p', { class: 'warn-line' }, w)));
  $('#dev-toggle').textContent = st.enabled ? 'Disable correction' : 'Enable correction';
}

// ------------------------------------------------------------------ live

function renderLiveChart() {
  const cfg = ctx.devConfig;
  if (!cfg) return;
  const key = encodeProfile(cfg);
  if (key === liveKey && $('#dev-live-chart').firstChild) return;
  liveKey = key;
  const gains = configGains(cfg);
  const linear = !!(cfg.flags & FLAG_LINEAR);
  const { svg, scale } = polarChart({
    title: 'Adapter profile with live direction',
    desc: 'Polar chart of the gains active on the adapter. A needle shows the current movement direction and gain.',
    size: 300,
    series: [{ data: sampleCurve((a) => gainAt(gains, a, linear)), cls: 'pc-rec', width: 2 }],
    dots: gains.map((g, k) => ({ theta: (k * 360) / gains.length, v: g, cls: 'pc-rec-dot', r: 3 })),
    unitLabel: '1.00x',
    needle: true,
    format: (v) => `${v.toFixed(2)}x`,
  });
  $('#dev-live-chart').innerHTML = svg;
  liveScale = scale;
}

function renderLive(live) {
  const needle = $('#dev-live-chart .pc-needle');
  if (needle && liveScale) {
    const [x, y] = liveScale.xy(live.angleDeg, live.gain);
    needle.setAttribute('x2', x.toFixed(1));
    needle.setAttribute('y2', y.toFixed(1));
  }
  const rows = [
    ['Direction', `${live.angleDeg.toFixed(1)}°`],
    ['Gain', fmt.gain(live.gain)],
    ['In (x, y)', `${live.inX}, ${live.inY}`],
    ['Out (x, y)', `${live.outX}, ${live.outY}`],
    ['Reports', String(live.reports)],
  ];
  $('#dev-live').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

async function startPolling() {
  if (polling || !ctx.dev) return;
  polling = true;
  let lastStatus = performance.now();
  let failures = 0;
  while (polling && ctx.dev && ctx.route === 'device') {
    const t0 = performance.now();
    if (document.visibilityState === 'visible') {
      try {
        renderLive(await ctx.withDevice((d) => d.readLive()));
        if (t0 - lastStatus > STATUS_MS) {
          lastStatus = t0;
          ctx.devStatus = await ctx.withDevice((d) => d.readStatus());
          renderStatus();
        }
        failures = 0;
      } catch {
        if (++failures > 5) break;
      }
    }
    await new Promise((r) => setTimeout(r, Math.max(10, LIVE_MS - (performance.now() - t0))));
  }
  polling = false;
}

// ------------------------------------------------------------------ editor

function editGains() {
  return configGains(edit);
}

function renderEditor() {
  if (!edit) return;
  $('#ed-n').value = edit.nPoints;
  $('#ed-interp').value = edit.flags & FLAG_LINEAR ? 'linear' : 'cubic';
  $('#ed-smooth').value = edit.smoothingCounts;
  $('#ed-reset').value = edit.resetMs;
  $('#ed-rot').value = (edit.rotationCdeg / 100).toFixed(2);
  $('#ed-label').value = edit.label;
  $('#ed-enabled').checked = !!(edit.flags & FLAG_ENABLED);
  $('#ed-chord').checked = !!(edit.flags & FLAG_CHORD_TOGGLE);
  const gains = editGains();
  const list = $('#ed-gains');
  list.replaceChildren(...gains.map((g, k) => {
    const name = directionName(k, gains.length);
    const angle = Math.round((k * 360) / gains.length);
    const id = `ed-g${k}`;
    return h('div', { class: 'gain-row' },
      h('label', { for: id }, `${name}${gains.length === 8 || gains.length === 4 ? ` (${angle}°)` : ''}`),
      h('input', { type: 'range', min: G_MIN, max: G_MAX, step: 0.001, value: g.toFixed(3), 'data-k': k, 'data-kind': 'range', 'aria-label': `${name} gain slider` }),
      h('input', { type: 'number', id, min: G_MIN, max: G_MAX, step: 0.001, value: g.toFixed(3), 'data-k': k, 'data-kind': 'num', inputmode: 'decimal' }));
  }));
  $('#ed-dirty').hidden = !editDirty;
  renderPreview();
}

function renderPreview() {
  const gains = editGains();
  const linear = !!(edit.flags & FLAG_LINEAR);
  const cur = ctx.devConfig ? configGains(ctx.devConfig) : null;
  const curLinear = ctx.devConfig ? !!(ctx.devConfig.flags & FLAG_LINEAR) : false;
  const series = [];
  if (cur && editDirty) series.push({ data: sampleCurve((a) => gainAt(cur, a, curLinear)), cls: 'pc-current', width: 1.5, dash: '5 4' });
  series.push({ data: sampleCurve((a) => gainAt(gains, a, linear)), cls: 'pc-rec', width: 2.5 });
  $('#ed-chart').innerHTML = polarChart({
    title: 'Edited profile preview',
    desc: 'Polar chart of the gains in the editor. The gain inputs list the same values.',
    series,
    dots: gains.map((g, k) => ({ theta: (k * 360) / gains.length, v: g, cls: 'pc-rec-dot', r: 3.5 })),
    unitLabel: '1.00x',
    format: (v) => `${v.toFixed(2)}x`,
  }).svg;
  $('#ed-dirty').hidden = !editDirty;
}

function onEditorInput(e) {
  if (!edit) return;
  const t = e.target;
  const num = Number(t.value);
  let rebuild = false;
  if (t.dataset.k !== undefined) {
    if (!Number.isFinite(num) || t.value === '') return;
    const k = Number(t.dataset.k);
    const g = Math.min(G_MAX, Math.max(G_MIN, num));
    edit.gainsQ12[k] = gainsToQ12([g])[0];
    const twin = t.parentElement.querySelector(`input[data-kind="${t.dataset.kind === 'range' ? 'num' : 'range'}"]`);
    if (twin && document.activeElement !== twin) twin.value = g.toFixed(3);
    if (e.type === 'change' && t.dataset.kind === 'num') t.value = g.toFixed(3);
  } else if (t.id === 'ed-n') {
    const n = Math.round(num);
    if (!(n >= 1 && n <= MAX_POINTS) || n === edit.nPoints) return;
    const old = editGains();
    const linear = !!(edit.flags & FLAG_LINEAR);
    const next = Array.from({ length: n }, (_, k) => gainAt(old, (k * 360) / n, linear));
    edit.nPoints = n;
    edit.gainsQ12 = [...gainsToQ12(next), ...new Array(MAX_POINTS - n).fill(GAIN_ONE)];
    rebuild = true;
  } else if (t.id === 'ed-interp') {
    edit.flags = t.value === 'linear' ? edit.flags | FLAG_LINEAR : edit.flags & ~FLAG_LINEAR;
  } else if (t.id === 'ed-smooth') {
    if (Number.isFinite(num) && t.value !== '') edit.smoothingCounts = Math.round(num);
  } else if (t.id === 'ed-reset') {
    if (Number.isFinite(num) && t.value !== '') edit.resetMs = Math.round(num);
  } else if (t.id === 'ed-rot') {
    if (Number.isFinite(num) && t.value !== '') edit.rotationCdeg = Math.round(Math.min(45, Math.max(-45, num)) * 100);
  } else if (t.id === 'ed-label') {
    edit.label = t.value.replace(/[^\x20-\x7e]/g, '').slice(0, 16);
    if (e.type === 'change') t.value = edit.label;
  } else if (t.id === 'ed-enabled') {
    edit.flags = t.checked ? edit.flags | FLAG_ENABLED : edit.flags & ~FLAG_ENABLED;
  } else if (t.id === 'ed-chord') {
    edit.flags = t.checked ? edit.flags | FLAG_CHORD_TOGGLE : edit.flags & ~FLAG_CHORD_TOGGLE;
  } else {
    return;
  }
  editDirty = true;
  if (rebuild) renderEditor();
  else renderPreview();
}

async function apply() {
  if (!edit) return;
  await attempt('Applying', async () => {
    edit = sanitizeConfig(edit);
    await ctx.withDevice((d) => d.writeConfig(edit));
    editDirty = false;
    await ctx.refreshDevice();
    toast('Applied. The adapter uses it now; Save to flash to keep it after unplugging.', 'ok');
  });
}
