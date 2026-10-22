// view-export.js - profile code, JSON, firmware header and Raw Accel export.
import { sanitizeConfig } from './omni-core.js';
import {
  encodeProfile, decodeProfile, profileJson, profileHeader, rawAccelSettings, headlineGains, headlineText,
} from './export.js';
import { profileFromFit } from './report.js';
import { $, $$, h, toast, download, copyWithToast, fmt, dateStamp } from './ui.js';

let ctx;
let source = null;      // 'result' | 'device' | 'paste'
let pasted = null;      // decoded config from the paste box

export function init(c) {
  ctx = c;
  for (const r of $$('input[name="exp-src"]')) {
    r.addEventListener('change', () => { source = r.value; render(); });
  }
  $('#exp-paste-go').addEventListener('click', () => {
    try {
      pasted = decodeProfile($('#exp-paste-text').value);
      render();
      toast('Profile loaded.', 'ok', 2000);
    } catch (e) {
      pasted = null;
      toast(e.message, 'error');
      render();
    }
  });
  $('#exp-copy-values').addEventListener('click', () => withCfg((cfg) => copyWithToast(`${headlineText(headlineGains(cfg))}\nProfile code: ${encodeProfile(cfg)}`, 'Values copied')));
  $('#exp-copy-code').addEventListener('click', () => withCfg((cfg) => copyWithToast(encodeProfile(cfg), 'Profile code copied')));
  $('#exp-copy-header').addEventListener('click', () => withCfg((cfg) => copyWithToast(profileHeader(cfg), 'Header copied')));
  $('#exp-json').addEventListener('click', () => withCfg((cfg) => download(`omnisens-profile-${dateStamp()}.json`, profileJson(cfg))));
  $('#exp-rawaccel').addEventListener('click', () => withCfg((cfg) => {
    download('settings.json', rawAccelSettings(cfg));
    toast('Downloaded settings.json. Back up your old one before replacing it.', 'info', 6000);
  }));
  const rerender = () => { if (ctx.route === 'export') render(); };
  ctx.on('fit', rerender);
  ctx.on('device', rerender);
}

export function show() {
  render();
}

function resultCfg() {
  if (!ctx.fit || !ctx.fit.ok || ctx.fit.error) return null;
  return profileFromFit(ctx.fit, ctx.session, ctx.devConfig);
}

function currentCfg() {
  if (source === 'result') return resultCfg();
  if (source === 'device') return ctx.devConfig ? sanitizeConfig(ctx.devConfig) : null;
  if (source === 'paste') return pasted;
  return null;
}

function withCfg(fn) {
  const cfg = currentCfg();
  if (cfg) fn(cfg);
}

function render() {
  const hasResult = !!resultCfg();
  const hasDevice = !!ctx.devConfig;
  if (!source) source = hasResult ? 'result' : hasDevice ? 'device' : 'paste';
  for (const r of $$('input[name="exp-src"]')) {
    r.checked = r.value === source;
    r.disabled = (r.value === 'result' && !hasResult) || (r.value === 'device' && !hasDevice);
  }
  $('#exp-src-result').textContent = hasResult
    ? `${ctx.fit.applied ? '' : 'flat (no reliable bias), '}${ctx.fit.nPoints} points`
    : 'none yet';
  $('#exp-src-device').textContent = hasDevice ? `"${ctx.devConfig.label || 'unnamed'}", ${ctx.devConfig.nPoints} points` : 'not connected';
  $('#exp-paste').hidden = source !== 'paste';

  const cfg = currentCfg();
  $('#exp-empty').hidden = !!cfg;
  $('#exp-body').hidden = !cfg;
  if (!cfg) return;

  const rows = headlineGains(cfg);
  $('#exp-table').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Direction'), h('th', { scope: 'col' }, 'Angle'), h('th', { scope: 'col' }, 'Multiplier'), h('th', { scope: 'col' }, 'vs 1.000x'))),
    h('tbody', {}, ...rows.map((r) => h('tr', {},
      h('th', { scope: 'row' }, r.name),
      h('td', {}, `${r.theta}°`),
      h('td', { class: 'mult' }, fmt.gain(r.gain)),
      h('td', {}, fmt.pct((r.gain - 1) * 100))))),
  );
  $('#exp-code').textContent = encodeProfile(cfg);
  $('#exp-header').textContent = profileHeader(cfg);

  const right = rows[0].gain, up = rows[2].gain, left = rows[4].gain, down = rows[6].gain;
  const diag = [1, 3, 5, 7].map((k) => rows[k]);
  const note = `Raw Accel gets right ${right.toFixed(3)}x, up ${up.toFixed(3)}x, left ${left.toFixed(3)}x, down ${down.toFixed(3)}x (as an output DPI of ${Math.round(1000 * right)} with ratios). `
    + `Your diagonals (${diag.map((r) => `${r.name.toLowerCase()} ${r.gain.toFixed(3)}x`).join(', ')}) are approximated by mixing their two axes.`;
  $('#exp-rawaccel-note').textContent = note;
}
