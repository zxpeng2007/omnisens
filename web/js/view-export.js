// view-export.js - profile code, JSON, firmware header and Raw Accel export.
import { sanitizeConfig } from './omni-core.js';
import {
  encodeProfile, decodeProfile, profileJson, profileHeader, rawAccelSettings, rawAccelFit, rawAccelSummary,
  headlineGains, headlineText,
} from './export.js';
import { profileFromFit } from './report.js';
import { isDesktop } from './desktop.js';
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
  ctx.on('desktop', rerender);
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

  // The settings file holds the least-squares fit, not the raw axis values: show those and how close they get.
  const fit = rawAccelFit(cfg);
  const sum = rawAccelSummary(fit);
  const fitLine = $('#exp-rawaccel-fit');
  fitLine.className = `fit-quality fit-${sum.level}`;
  fitLine.textContent = sum.text;
  $('#exp-rawaccel-note').textContent = `The file sets right ${fit.right.toFixed(3)}x, left ${fit.left.toFixed(3)}x, up ${fit.up.toFixed(3)}x, down ${fit.down.toFixed(3)}x `
    + `(an output DPI of ${Math.round(1000 * fit.right)} with ratios), the four values that best match your whole profile. Diagonals are a mix of their two axes.`;
  $('#exp-rawaccel-app').hidden = !isDesktop() || ctx.desktop?.method !== 'rawaccel';
}
