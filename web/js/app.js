// app.js - boot, hash routing, shared state and the adapter connection.
// Views live in view-*.js; each exports init(ctx) (once) and show(ctx) (on every visit).
import { OmniDevice, webHidSupported } from './device.js';
import { loadSettings, saveSettings } from './settings.js';
import { analysedTrials, analyzeTrials, fitResults, parseSession } from './report.js';
import { TaskScreen } from './task-screen.js';
import { captureToken, detectDesktop, isDesktop, desktopApi } from './desktop.js';
import { $, $$, toast } from './ui.js';
import * as calibrateView from './view-calibrate.js';
import * as resultsView from './view-results.js';
import * as deviceView from './view-device.js';
import * as exportView from './view-export.js';
import * as verifyView from './view-verify.js';
import * as pcView from './view-pc.js';

const VIEWS = {
  calibrate: { mod: calibrateView, title: 'Calibrate' },
  results: { mod: resultsView, title: 'Results' },
  pc: { mod: pcView, title: 'This PC' },
  device: { mod: deviceView, title: 'Adapter' },
  export: { mod: exportView, title: 'Export' },
  verify: { mod: verifyView, title: 'Verify' },
  about: { mod: null, title: 'About' },
};
const DEFAULT_ROUTE = 'calibrate';
// The example session: published copy first, then the test fixture (local checkouts).
const SAMPLE_URLS = ['assets/sample-session.json', 'test/fixtures/sample-session.json'];

const bus = new EventTarget();
let deviceQueue = Promise.resolve();

export const ctx = {
  settings: loadSettings(),
  route: null,
  dev: null,            // OmniDevice
  devStatus: null,
  devConfig: null,
  session: null,        // see report.makeSession()
  trials: null,         // analysed (non warm-up) trials of the session
  results: null,        // analyzeTrial() output per trial; kept by identity so fits are cached
  fit: null,            // normalised fit, see report.normalizeFit()
  force: false,         // "Apply anyway" for the current session
  adapterGuard: null,   // { restore(): Promise } while a session changes the adapter state
  task: null,           // TaskScreen
  desktop: null,        // GET /api/info while the omnisens app serves this page, else null
  desktopError: null,   // why the last /api/info failed (the app was closed?)
  pcPick: null,         // profile source to preselect on This PC ('result')

  on(type, fn) { bus.addEventListener(type, fn); },
  emit(type) { bus.dispatchEvent(new Event(type)); },
  saveSettings() { saveSettings(this.settings); },
  navigate(route) { location.hash = `#/${route}`; },

  /** Serialises adapter access: feature reports from polling and commands must not interleave. */
  withDevice(fn) {
    const run = deviceQueue.then(() => {
      if (!this.dev) throw new Error('No adapter connected.');
      return fn(this.dev);
    });
    deviceQueue = run.catch(() => {});
    return run;
  },

  async connect() {
    if (!webHidSupported()) throw new Error('WebHID is not available in this browser.');
    const dev = await OmniDevice.request();
    if (!dev) return null;
    await attachDevice(dev);
    toast(`Connected to ${dev.name}.`, 'ok');
    return dev;
  },

  async refreshDevice() {
    if (!this.dev) return;
    const [status, config] = await this.withDevice(async (d) => [await d.readStatus(), await d.readConfig()]);
    this.devStatus = status;
    this.devConfig = config;
    this.emit('device');
  },

  async disconnect() {
    const d = this.dev;
    if (!d) return;
    this.dev = null;
    this.devStatus = null;
    this.devConfig = null;
    try { await d.close(); } catch { /* already gone */ }
    this.emit('device');
  },

  /** Installs a recorded session and analyses it. */
  setSession(session) {
    this.session = session;
    this.trials = analysedTrials(session);
    this.results = analyzeTrials(this.trials, session.degPerCount);
    this.force = false;
    this.refit();
    this.emit('session');
  },

  refit() {
    if (!this.session) return;
    const s = this.settings;
    this.fit = fitResults(this.results, {
      nPoints: s.nPoints,
      strength: s.strength,
      symmetric: s.symmetric,
      force: this.force,
      bootstrap: 200,
      seed: (this.session.seed >>> 0) || 12345,
    }, this.session.current || null);
    this.emit('fit');
  },

  /** Re-reads the app's state; emits 'desktop' when it changed. No-op on the website. */
  async refreshDesktop() {
    if (!isDesktop()) return null;
    let info;
    try {
      info = await desktopApi('/api/info');
    } catch (e) {
      if (this.desktopError !== e.message) {
        this.desktopError = e.message;
        this.emit('desktop');
      }
      throw e;
    }
    const changed = this.desktopError !== null || JSON.stringify(info) !== JSON.stringify(this.desktop);
    this.desktop = info;
    this.desktopError = null;
    if (changed) this.emit('desktop');
    return info;
  },

  async loadSessionText(text) {
    const session = parseSession(text);
    this.setSession(session);
    this.navigate('results');
  },

  async loadSample() {
    let res = null;
    for (const url of SAMPLE_URLS) {
      res = await fetch(url).catch(() => null);
      if (res?.ok) break;
    }
    if (!res?.ok) throw new Error('the example session is not available on this server');
    await this.loadSessionText(await res.text());
    toast('Loaded an example session from a simulated player (it overshoots to the right).', 'info', 6000);
  },
};

async function attachDevice(dev) {
  if (ctx.dev && ctx.dev !== dev) await ctx.disconnect();
  ctx.dev = dev;
  dev.addEventListener('disconnect', () => {
    if (ctx.dev !== dev) return;
    ctx.dev = null;
    ctx.devStatus = null;
    ctx.devConfig = null;
    toast('Adapter disconnected.', 'warn');
    ctx.emit('device');
  });
  try {
    await ctx.refreshDevice();
  } catch (e) {
    toast(`Connected, but reading the adapter failed: ${e.message}`, 'error');
    ctx.emit('device');
  }
}

// ------------------------------------------------------------------ routing

function currentRoute() {
  const m = /^#\/([a-z]+)/.exec(location.hash);
  return m && m[1] in VIEWS ? m[1] : null;
}

function route() {
  const hash = location.hash;
  // In-page anchors such as the skip link are not routes.
  if (hash && !hash.startsWith('#/')) return;
  const name = currentRoute() || DEFAULT_ROUTE;
  const prev = ctx.route;
  if (prev && prev !== name) VIEWS[prev].mod?.hide?.(ctx);
  ctx.route = name;
  for (const sec of $$('.view')) sec.hidden = sec.dataset.view !== name;
  for (const a of $$('.mainnav a')) {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${VIEWS[name].title} - omnisens`;
  VIEWS[name].mod?.show?.(ctx);
  if (prev && prev !== name) {
    window.scrollTo(0, 0);
    $(`#view-${name} h1`)?.focus({ preventScroll: true });
  }
}

function renderPill() {
  const pill = $('#device-pill');
  const text = $('#device-pill-text');
  if (!ctx.dev) {
    pill.dataset.state = 'off';
    text.textContent = webHidSupported() ? 'No adapter' : 'Adapter: needs Chrome/Edge';
    return;
  }
  const st = ctx.devStatus;
  pill.dataset.state = st && !st.enabled ? 'bypass' : 'on';
  text.textContent = st ? `Adapter ${st.enabled ? 'on' : 'bypassed'}` : 'Adapter';
}

// ------------------------------------------------------------------ boot

function boot() {
  // First, so the token leaves the address bar before anything else runs.
  captureToken();
  ctx.task = new TaskScreen();
  for (const { mod } of Object.values(VIEWS)) mod?.init?.(ctx);
  ctx.on('device', renderPill);
  renderPill();
  // Opt-in hook for development and automated UI tests: index.html?debug
  if (new URLSearchParams(location.search).has('debug')) window.omnisens = ctx;
  window.addEventListener('hashchange', route);
  route();

  $('#skip-link').addEventListener('click', (e) => {
    e.preventDefault();
    $('#main').focus();
  });

  // Put the adapter back the way the user had it if the page closes mid-session.
  window.addEventListener('pagehide', () => {
    ctx.adapterGuard?.restore().catch(() => {});
  });

  if (webHidSupported()) {
    navigator.hid.addEventListener('connect', async () => {
      if (ctx.dev) return;
      const dev = await OmniDevice.reconnect().catch(() => null);
      if (dev) {
        await attachDevice(dev);
        toast('Adapter connected.', 'ok');
      }
    });
    OmniDevice.reconnect().then((dev) => dev && attachDevice(dev)).catch(() => {});
  }

  detectDesktop().then(async (ok) => {
    if (ok) await ctx.refreshDesktop().catch(() => {});
    ctx.emit('desktop');
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
