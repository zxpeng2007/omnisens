// view-pc.js - "This PC". On the website it explains the omnisens app; served
// by the app it shows the set-up checklist, applies a profile to this computer
// (Raw Accel on Windows, the built-in engine on Linux) and shows what is applied.
import { configGains, FLAG_LINEAR } from './omni-core.js';
import {
  encodeProfile, decodeProfile, rawAccelFit, rawAccelRows, rawAccelSummary, headlineGains,
} from './export.js';
import { profileFromFit } from './report.js';
import {
  desktopStatus, isDesktop, desktopApi, rawAccelSteps, engineSteps, linuxSetupCommand,
} from './desktop.js';
import { $, $$, h, toast, attempt, copyWithToast, fmt } from './ui.js';

const POLL_MS = 4000;
const VC_REDIST = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const OS_NAMES = { windows: 'Windows', linux: 'Linux', darwin: 'macOS' };
const ACTION_IDS = ['#pc-apply', '#pc-remove', '#pc-resume', '#pc-autostart', '#pc-install', '#pc-dir-go', '#pc-refresh', '#pc-quit'];

let ctx;
let source = null;      // 'result' | 'device' | 'paste'
let picked = false;     // source chosen by the user (else the best available one, re-chosen on every render)
let pasted = null;      // decoded config from the paste box
let lastApply = null;   // answer of the last apply from this page
let busy = false;
let quit = false;       // the app was quit from this page
let timer = 0;

export function init(c) {
  ctx = c;
  for (const r of $$('input[name="pc-src"]')) {
    r.addEventListener('change', () => { source = r.value; picked = true; renderProfile(); });
  }
  $('#pc-paste-go').addEventListener('click', () => {
    try {
      pasted = decodeProfile($('#pc-paste-text').value);
      picked = true;
      toast('Profile loaded.', 'ok', 2000);
    } catch (e) {
      pasted = null;
      toast(e.message, 'error');
    }
    renderProfile();
  });
  $('#pc-refresh').addEventListener('click', () => attempt('Checking this PC', () => ctx.refreshDesktop()));
  $('#pc-install').addEventListener('click', openInstall);
  // The dialog's form uses method="dialog": submitting closes it; only the install button starts anything.
  $('#pc-install-dialog form').addEventListener('submit', (e) => {
    if (e.submitter?.value === 'install') install();
  });
  $('#pc-dir-toggle').addEventListener('click', (e) => {
    const form = $('#pc-dir-form');
    form.hidden = !form.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) $('#pc-dir').focus();
  });
  $('#pc-dir-form').addEventListener('submit', (e) => {
    e.preventDefault();
    setDir();
  });
  $('#pc-apply').addEventListener('click', apply);
  $('#pc-remove').addEventListener('click', remove);
  $('#pc-resume').addEventListener('click', () => run('Resuming', async () => {
    await desktopApi('/api/resume', {});
    toast('The correction is back on.', 'ok');
  }));
  $('#pc-autostart').addEventListener('change', (e) => setAutostart(e.target.checked));
  $('#pc-quit').addEventListener('click', quitApp);

  const rerender = () => { if (ctx.route === 'pc') render(); };
  ctx.on('desktop', rerender);
  ctx.on('fit', rerender);
  ctx.on('device', rerender);
}

export function show() {
  if (ctx.pcPick) {
    source = ctx.pcPick;
    picked = true;
    ctx.pcPick = null;
  }
  render();
  if (isDesktop() && !quit) ctx.refreshDesktop().catch(() => {});
}

export function hide() {
  stopPolling();
}

function startPolling() {
  if (timer || quit) return;
  timer = setInterval(() => {
    if (ctx.route !== 'pc' || !isDesktop() || quit) {
      stopPolling();
      return;
    }
    if (document.visibilityState === 'visible' && !busy) ctx.refreshDesktop().catch(() => {});
  }, POLL_MS);
}

function stopPolling() {
  clearInterval(timer);
  timer = 0;
}

// ------------------------------------------------------------------ render

const applies = (info) => info?.method === 'rawaccel' || info?.method === 'engine';
const warn = (...kids) => h('p', { class: 'warn-line' }, ...kids);

function render() {
  const st = desktopStatus();
  const info = ctx.desktop;
  const app = st === 'ok';
  const offline = st === 'failed' || (app && (quit || !!ctx.desktopError));
  $('#pc-checking').hidden = !(st === 'checking' || (app && !info && !offline));
  $('#pc-offline').hidden = !offline;
  if (offline) {
    $('#pc-offline-text').textContent = quit
      ? 'omnisens has quit. You can close this tab; start omnisens again to come back.'
      : 'This page was opened by the omnisens app, but the app does not respond. If you closed its window, start omnisens again: it opens a fresh page.';
  }
  $('#pc-web').hidden = app || st === 'checking';
  $('#pc-desk').hidden = !app || !info || quit;
  if (!app) {
    $('#pc-lead').textContent = 'Use your profile without the adapter: the omnisens app applies it to the computer it runs on.';
    return;
  }
  if (!info || quit) return;
  startPolling();

  const m = info.method;
  $('#pc-lead').textContent = {
    rawaccel: 'The omnisens app applies your profile to this PC through Raw Accel, a free, signed mouse driver.',
    engine: 'The omnisens app applies your full profile to this PC itself, while it runs.',
  }[m] || 'Calibration works here as usual; applying a profile to this PC does not.';
  $('#pc-none').hidden = applies(info);
  for (const id of ['#pc-setup', '#pc-profile', '#pc-now']) $(id).hidden = !applies(info);
  $('#pc-ra-controls').hidden = m !== 'rawaccel';
  if (m === 'rawaccel') renderRawAccelSetup(info);
  else if (m === 'engine') renderEngineSetup(info);
  else renderNone(info);
  if (applies(info)) {
    renderProfile();
    renderNow();
  }
  const os = OS_NAMES[info.os] || info.os || 'this system';
  const quitNote = m === 'engine'
    ? 'Quitting stops the correction and your mouse goes back to normal.'
    : m === 'rawaccel'
      ? 'Quitting does not remove the profile: Raw Accel keeps it until Windows shuts down (and applies it again at login if you turned that on).'
      : '';
  $('#pc-app-info').textContent = `omnisens ${info.version || 'dev'} on ${os}${info.arch ? ` (${info.arch})` : ''}. Keep its window open while you use this page. ${quitNote}`.trim();
  setBusy(busy);
}

function renderNone(info) {
  const os = OS_NAMES[info.os] || info.os || 'this system';
  $('#pc-none-text').textContent = `The omnisens app cannot apply a profile on ${os}. Calibration works here as usual. To use your profile, use the USB adapter (any system) or the omnisens app on Windows or Linux; the profile code on Results or Export takes it along.`;
}

function checklist(steps) {
  const said = { done: 'done', current: 'next step', todo: 'to do' };
  return h('ol', { class: 'checklist' }, ...steps.map((s, i) => h('li', { 'data-state': s.state },
    h('span', { class: 'check-mark', 'aria-hidden': 'true' }, s.state === 'done' ? '✓' : String(i + 1)),
    h('div', {},
      h('b', {}, s.label),
      h('span', { class: 'sr-only' }, ` (${said[s.state]})`),
      h('small', {}, s.detail)))));
}

function renderRawAccelSetup(info) {
  const ra = info.rawAccel || {};
  $('#pc-setup-h').textContent = 'Raw Accel on this PC';
  const kids = [
    h('p', {}, 'Raw Accel can scale moving right, left, up and down separately. omnisens fits those four values to your profile and multiplies them into Raw Accel\'s settings; everything else you set there stays as it is.'),
    checklist(rawAccelSteps(ra)),
  ];
  if (ra.error) kids.push(warn(ra.error));
  if (ra.vcRuntime === false) {
    kids.push(warn('Raw Accel needs the Microsoft Visual C++ runtime, which is missing on this PC. ',
      h('a', { href: VC_REDIST, target: '_blank', rel: 'noopener' }, 'Get it from Microsoft (vc_redist.x64.exe)'),
      ', install it, then press Check again.'));
  }
  if (ra.guiRunning) {
    kids.push(warn('Raw Accel\'s own window is open. Close it without pressing its Apply button, or it may overwrite the omnisens settings.'));
  }
  if (ra.found && ra.settingsFound === false) {
    kids.push(h('p', { class: 'muted small' }, 'Raw Accel has no settings.json yet; omnisens creates one (no acceleration) when you apply.'));
  }
  $('#pc-setup-body').replaceChildren(...kids);

  const install = $('#pc-install');
  install.hidden = !!(ra.found && ra.driverInstalled) || !ra.download?.url;
  $('#pc-dir-toggle').textContent = ra.found ? 'Use a different Raw Accel folder' : 'Use an existing Raw Accel folder';
  const dir = $('#pc-dir');
  if (ra.dir && !dir.value && document.activeElement !== dir) dir.value = ra.dir;
}

function renderEngineSetup(info) {
  const e = info.engine || {};
  $('#pc-setup-h').textContent = 'Linux engine';
  const kids = [
    h('p', {}, 'omnisens reads your mouse, corrects each movement with the full profile and passes it on through a virtual mouse called "omnisens: <your mouse>". Buttons and the wheel pass through unchanged.'),
  ];
  if (e.supported === false) kids.push(warn(`The engine cannot run on this system${e.error ? `: ${e.error}` : '.'}`));
  kids.push(checklist(engineSteps(e)));
  if (!e.canReadInput || !e.canWriteUinput) {
    const cmd = linuxSetupCommand(info.arch);
    kids.push(
      h('h3', {}, 'One-time setup'),
      h('p', {}, 'Run this in a terminal, in the folder where you saved omnisens (with the file name you downloaded), then log out and back in and start omnisens again:'),
      h('div', { class: 'cmd' },
        h('pre', { class: 'code' }, cmd),
        h('button', { class: 'btn small', type: 'button', onclick: () => copyWithToast(cmd, 'Command copied') }, 'Copy')),
      h('p', { class: 'muted small' }, 'It adds a udev rule for /dev/uinput and adds your user to the input group. Without sudo and --install, "linux-setup" only prints what it would change.'),
    );
  }
  if (e.error && e.supported !== false) kids.push(warn(e.error));
  $('#pc-setup-body').replaceChildren(...kids);
}

// ------------------------------------------------------------------ profile

function resultCfg() {
  if (!ctx.fit || !ctx.fit.ok || ctx.fit.error) return null;
  return profileFromFit(ctx.fit, ctx.session, ctx.devConfig);
}

function currentCfg() {
  if (source === 'result') return resultCfg();
  if (source === 'device') return ctx.devConfig || null;
  if (source === 'paste') return pasted;
  return null;
}

function profileLabel(code) {
  try {
    const cfg = decodeProfile(code);
    return `"${cfg.label || 'unnamed'}", ${cfg.nPoints} points`;
  } catch {
    return 'unknown profile';
  }
}

function renderProfile() {
  const info = ctx.desktop;
  if (!applies(info)) return;
  const m = info.method;
  const hasResult = !!resultCfg();
  const hasDevice = !!ctx.devConfig;
  // The app opens on this page before there is a result: until the user picks, follow the best source.
  if (!picked || (source === 'result' && !hasResult) || (source === 'device' && !hasDevice)) {
    source = hasResult ? 'result' : hasDevice ? 'device' : 'paste';
    picked = false;
  }
  for (const r of $$('input[name="pc-src"]')) {
    r.checked = r.value === source;
    r.disabled = (r.value === 'result' && !hasResult) || (r.value === 'device' && !hasDevice);
  }
  $('#pc-src-result').textContent = hasResult
    ? `${ctx.fit.applied ? '' : 'flat (no reliable bias), '}${ctx.fit.nPoints} points`
    : 'none yet';
  $('#pc-src-device').textContent = hasDevice ? `"${ctx.devConfig.label || 'unnamed'}", ${ctx.devConfig.nPoints} points` : 'not connected';
  $('#pc-src-h').textContent = m === 'engine' ? 'Profile to run' : 'Profile to apply';
  $('#pc-paste').hidden = source !== 'paste';

  const cfg = currentCfg();
  $('#pc-empty').hidden = !!cfg;
  $('#pc-preview').replaceChildren(...(!cfg ? [] : m === 'rawaccel' ? rawAccelPreview(cfg) : enginePreview(cfg)));

  const btn = $('#pc-apply');
  const hint = $('#pc-apply-hint');
  const code = cfg ? encodeProfile(cfg) : '';
  const flat = cfg && configGains(cfg).every((g) => Math.abs(g - 1) < 1e-3) && !cfg.rotationCdeg;
  let ready;
  let text;
  if (m === 'rawaccel') {
    const ra = info.rawAccel || {};
    ready = !!(ra.found && ra.driverRunning);
    btn.textContent = 'Apply profile';
    if (!ready) text = 'Finish the set-up steps above first.';
    else if (ra.guiRunning) text = 'Close Raw Accel\'s window first, without pressing its Apply button.';
    else if (ra.applied?.code && ra.applied.code === code) text = 'This profile is applied already.';
    else if (ra.applied) text = 'Replaces the profile applied now. The old factors are taken out first, so they never stack.';
    else text = 'Multiplies the four factors into Raw Accel\'s settings.json (the original is kept as settings.before-omnisens.json) and loads them into the driver.';
  } else {
    const e = info.engine || {};
    ready = e.supported !== false && !!e.canReadInput && !!e.canWriteUinput;
    btn.textContent = e.running ? 'Switch to this profile' : 'Start correction';
    if (!ready) text = 'Finish the one-time setup above first.';
    else if (e.running && e.code === code) text = 'This profile is running already.';
    else if (e.running) text = 'Swaps the profile without stopping the correction.';
    else text = 'Grabs your mice and applies the profile while omnisens runs. Close omnisens and your mouse is back to normal.';
  }
  if (cfg && flat && ready) text = `This profile is flat (1.000x everywhere), so it changes nothing. ${text}`;
  btn.disabled = busy || !cfg || !ready || !!ctx.desktopError;
  hint.textContent = cfg ? text : '';
}

function rawAccelPreview(cfg) {
  const fit = rawAccelFit(cfg);
  const rows = rawAccelRows(cfg, fit);
  const sum = rawAccelSummary(fit);
  const bend = (b) => (Math.abs(b) < 0.05 ? '0°' : `${Math.abs(b).toFixed(1)}°`);
  const table = h('table', { class: 'values compact' },
    h('caption', { class: 'sr-only' }, 'Your profile and what Raw Accel does, by direction'),
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'Direction'),
      h('th', { scope: 'col' }, 'Your profile'),
      h('th', { scope: 'col' }, 'Raw Accel'),
      h('th', { scope: 'col' }, 'Difference'),
      h('th', { scope: 'col' }, 'Direction bend'))),
    h('tbody', {}, ...rows.map((r) => h('tr', {},
      h('th', { scope: 'row' }, r.name),
      h('td', { class: 'mult' }, fmt.gain(r.target)),
      h('td', { class: 'mult' }, fmt.gain(r.gain)),
      h('td', {}, fmt.pct(r.errorPct)),
      h('td', {}, bend(r.bendDeg))))));
  const rot = -cfg.rotationCdeg / 100;
  return [
    h('h3', {}, 'How close Raw Accel gets'),
    h('div', { class: 'table-wrap' }, table),
    h('p', { class: `fit-quality fit-${sum.level}` }, sum.text),
    h('p', { class: 'muted small' }, `Raw Accel will scale moving right by ${fmt.gain(fit.right)}, left ${fmt.gain(fit.left)}, up ${fmt.gain(fit.up)} and down ${fmt.gain(fit.down)}${rot ? `, and rotate input ${Math.abs(rot).toFixed(2)}° ${rot > 0 ? 'clockwise' : 'counter-clockwise'}` : ''}, on top of your current Raw Accel settings.`),
  ];
}

function enginePreview(cfg) {
  const rows = headlineGains(cfg);
  const table = h('table', { class: 'values compact' },
    h('caption', { class: 'sr-only' }, 'Profile multipliers by direction'),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Direction'), h('th', { scope: 'col' }, 'Multiplier'))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, h('th', { scope: 'row' }, r.name), h('td', { class: 'mult' }, fmt.gain(r.gain))))));
  const extra = cfg.rotationCdeg ? `, rotated ${(cfg.rotationCdeg / 100).toFixed(2)}°` : '';
  return [
    h('div', { class: 'table-wrap' }, table),
    h('p', { class: 'muted small' }, `Linux applies all ${cfg.nPoints} points of this profile exactly (${cfg.flags & FLAG_LINEAR ? 'linear' : 'smooth'} interpolation${extra}), like the adapter.`),
  ];
}

// ------------------------------------------------------------------ applied state

function renderNow() {
  const info = ctx.desktop;
  const kids = [];
  const remove = $('#pc-remove');
  const resume = $('#pc-resume');
  const auto = $('#pc-autostart');
  if (info.method === 'rawaccel') {
    const ra = info.rawAccel || {};
    const a = ra.applied;
    if (!a) {
      kids.push(h('p', {}, 'No omnisens profile is applied. Raw Accel, if installed, runs with its own settings.'));
    } else {
      kids.push(h('p', {}, ra.paused
        ? 'An omnisens profile is applied but paused: a calibration turned it off for measuring. Resume it if that calibration was interrupted.'
        : 'An omnisens profile is applied through Raw Accel.'));
      const rows = [
        ['Profile', profileLabel(a.code)],
        ['Right', fmt.gain(a.right)],
        ['Left', fmt.gain(a.left)],
        ['Up', fmt.gain(a.up)],
        ['Down', fmt.gain(a.down)],
      ];
      const rot = Number(a.rotationDeg);   // Raw Accel's sign: clockwise positive
      if (rot) rows.push(['Rotation', `${Math.abs(rot).toFixed(2)}° ${rot > 0 ? 'clockwise' : 'counter-clockwise'}`]);
      if (a.at && !Number.isNaN(Date.parse(a.at))) rows.push(['Applied', new Date(a.at).toLocaleString()]);
      kids.push(h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
    }
    remove.hidden = !a;
    remove.textContent = 'Remove';
    resume.hidden = !(a && ra.paused);
    auto.checked = !!ra.autostart;
    auto.disabled = busy || !ra.found;
    $('#pc-autostart-text').textContent = 'Raw Accel forgets its settings when Windows shuts down. This adds a startup entry that runs Raw Accel\'s own writer.exe with your settings at login; omnisens itself does not need to run.';
  } else {
    const e = info.engine || {};
    if (!e.running) {
      kids.push(h('p', {}, 'The correction is not running. Your mouse works as usual.'));
    } else {
      kids.push(h('p', {}, e.paused
        ? 'Running but paused: a calibration turned it off for measuring, so movement passes through unchanged. Resume it if that calibration was interrupted.'
        : 'The correction is running.'));
      const devices = Array.isArray(e.devices) ? e.devices : [];
      kids.push(h('dl', { class: 'kv' },
        h('dt', {}, 'Profile'), h('dd', {}, e.code ? profileLabel(e.code) : '-'),
        h('dt', {}, 'Mice'), h('dd', {}, devices.length
          ? h('ul', { class: 'plain' }, ...devices.map((d) => h('li', {}, d)))
          : 'none found yet: plug in a mouse (omnisens looks every 2 seconds)')));
    }
    remove.hidden = !e.running;
    remove.textContent = 'Stop';
    resume.hidden = !(e.running && e.paused);
    const on = !!(e.autostart ?? info.autostart);
    auto.checked = on;
    auto.disabled = busy || (!on && !e.code);
    $('#pc-autostart-text').textContent = e.code || on
      ? 'Starts omnisens with the running profile when you log in (an entry in ~/.config/autostart).'
      : 'Start the correction first; the login entry runs omnisens with that profile.';
  }
  if (lastApply?.warning) kids.push(warn(lastApply.warning));
  if (lastApply?.fit && info.method === 'rawaccel') {
    const f = lastApply.fit;
    kids.push(h('p', { class: 'muted small' }, `Last written from this page: right ${fmt.gain(f.right)}, left ${fmt.gain(f.left)}, up ${fmt.gain(f.up)}, down ${fmt.gain(f.down)}${Number.isFinite(f.maxErrorPct) ? `, within ${f.maxErrorPct.toFixed(1)}% of the profile` : ''}.`));
  }
  if (lastApply?.message) kids.push(h('p', { class: 'muted small' }, lastApply.message));
  $('#pc-now-body').replaceChildren(...kids);
}

// ------------------------------------------------------------------ actions

/** While an action runs every button is off; afterwards render() decides (apply and autostart have their own rules). */
function setBusy(on) {
  $('#pc-desk').setAttribute('aria-busy', String(on));
  if (on) {
    for (const id of ACTION_IDS) $(id).disabled = true;
    return;
  }
  $('#pc-refresh').disabled = false;
  for (const id of ['#pc-install', '#pc-dir-go', '#pc-quit', '#pc-remove', '#pc-resume']) $(id).disabled = !!ctx.desktopError;
}

/** Runs one API action at a time, then re-reads the app's state. */
async function run(what, fn) {
  if (busy) return undefined;
  busy = true;
  setBusy(true);
  try {
    return await attempt(what, fn);
  } finally {
    busy = false;
    await ctx.refreshDesktop().catch(() => {});
    if (ctx.route === 'pc') render();
  }
}

function apply() {
  const cfg = currentCfg();
  if (!cfg) return;
  const engine = ctx.desktop?.method === 'engine';
  run(engine ? 'Starting the correction' : 'Applying', async () => {
    const r = await desktopApi('/api/apply', { code: encodeProfile(cfg) });
    lastApply = r;
    if (r.warning) toast(r.warning, 'warn', 12000);
    toast(r.message || (engine ? 'The correction is running.' : 'Applied: Raw Accel uses the new factors now.'), 'ok', 7000);
  });
}

function remove() {
  const engine = ctx.desktop?.method === 'engine';
  run(engine ? 'Stopping' : 'Removing', async () => {
    const r = await desktopApi('/api/remove', {});
    lastApply = null;
    toast(r.message || (engine ? 'Stopped. Your mouse works as usual.' : 'Removed. Raw Accel is back to your own settings.'), 'ok', 6000);
  });
}

function setAutostart(enabled) {
  run('Changing the login setting', async () => {
    const r = await desktopApi('/api/autostart', { enabled });
    toast(r.message || (enabled ? 'Your profile is applied at every login now.' : 'Nothing runs at login any more.'), 'ok', 5000);
  });
}

function setDir() {
  const dir = $('#pc-dir').value.trim();
  if (!dir) {
    toast('Type the path of the folder that contains writer.exe and rawaccel.exe.', 'warn');
    $('#pc-dir').focus();
    return;
  }
  run('Setting the Raw Accel folder', async () => {
    const r = await desktopApi('/api/rawaccel/dir', { dir });
    $('#pc-dir-form').hidden = true;
    $('#pc-dir-toggle').setAttribute('aria-expanded', 'false');
    toast(r.message || 'omnisens uses this Raw Accel folder now.', 'ok');
  });
}

function openInstall() {
  const dl = ctx.desktop?.rawAccel?.download;
  if (!dl?.url) return;
  $('#pc-dl-version').textContent = dl.version || '';
  $('#pc-dl-url').textContent = dl.url;
  $('#pc-dl-size').textContent = Number.isFinite(dl.sizeBytes)
    ? `${(dl.sizeBytes / 1048576).toFixed(1)} MB (${dl.sizeBytes.toLocaleString('en-US')} bytes)`
    : '-';
  $('#pc-dl-sha').textContent = dl.sha256 || '-';
  $('#pc-install-dialog').showModal();
}

function install() {
  run('Installing Raw Accel', async () => {
    toast('Downloading Raw Accel and checking it...', 'info', 5000);
    const r = await desktopApi('/api/rawaccel/install', {});
    toast(r.message || 'Raw Accel\'s installer is open. Approve the Windows prompt, then restart your PC.', 'ok', 20000);
  });
}

function quitApp() {
  const engine = ctx.desktop?.method === 'engine';
  // eslint-disable-next-line no-alert
  if (!window.confirm(`Quit omnisens?${engine ? ' The correction stops and your mouse goes back to normal.' : ''} This page stops working until you start omnisens again.`)) return;
  run('Quitting', async () => {
    await desktopApi('/api/quit', {});
    quit = true;
    stopPolling();
  });
}
