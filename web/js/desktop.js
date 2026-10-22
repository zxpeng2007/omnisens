// desktop.js - talking to the omnisens desktop app when it serves this page.
//
// The app opens http://127.0.0.1:<port>/?t=<token>#/pc. The token authorises
// the /api calls; it is kept in sessionStorage (this tab only) and removed
// from the address bar so it does not end up in history or bookmarks. On the
// website there is no token and nothing here talks to the network.
import { decodeProfile, rawAccelAt, rawAccelEffectiveGains } from './export.js';
import { configGains, FLAG_ENABLED, FLAG_LINEAR } from './omni-core.js';

export const TOKEN_KEY = 'omnisens.token';
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

let token = null;
let ping = null;        // Promise<boolean> once detectDesktop() ran
let status = 'none';    // 'none' (no token) | 'checking' | 'ok' | 'failed'

function sessionStore(env) {
  try {
    return env.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads ?t= from the URL, keeps it in sessionStorage and removes it from the
 * address bar (other parameters and the hash stay). Without one in the URL a
 * token saved earlier in this tab is used. Returns the token or null.
 */
export function captureToken(env = globalThis) {
  const loc = env.location;
  const store = sessionStore(env);
  let fromUrl = null;
  if (loc && typeof loc.search === 'string' && loc.search.length > 1) {
    const params = new URLSearchParams(loc.search);
    if (params.has('t')) {
      fromUrl = params.get('t');
      // Drop only t=..., leaving the other parameters exactly as written (e.g. "?debug").
      const qs = loc.search.slice(1).split('&').filter((p) => p && new URLSearchParams(p).keys().next().value !== 't').join('&');
      try {
        env.history?.replaceState(env.history.state ?? null, '', `${loc.pathname || '/'}${qs ? `?${qs}` : ''}${loc.hash || ''}`);
      } catch {
        // the URL keeps the token; the app still works
      }
    }
  }
  if (fromUrl !== null && TOKEN_RE.test(fromUrl)) {
    token = fromUrl;
    try {
      store?.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // blocked storage: keep it in memory for this page load
    }
  } else {
    let saved = null;
    try {
      saved = store?.getItem(TOKEN_KEY) ?? null;
    } catch {
      saved = null;
    }
    token = saved && TOKEN_RE.test(saved) ? saved : null;
  }
  ping = null;
  status = token ? 'checking' : 'none';
  return token;
}

export function desktopToken() {
  return token;
}

/** 'none' (website), 'checking', 'ok' (served by the app) or 'failed' (the app did not answer). */
export function desktopStatus() {
  return status;
}

/** True when the page is served by the omnisens app and it answered /api/ping (after detectDesktop()). */
export function isDesktop() {
  return status === 'ok';
}

/** Pings the app once (cached). Resolves to isDesktop(). */
export function detectDesktop() {
  if (!ping) {
    ping = (async () => {
      if (!token) return false;
      try {
        const r = await desktopApi('/api/ping');
        return r?.ok === true;
      } catch {
        return false;
      }
    })().then((ok) => {
      status = token ? (ok ? 'ok' : 'failed') : 'none';
      return ok;
    });
  }
  return ping;
}

function apiError(httpStatus, data) {
  if (data && typeof data.error === 'string' && data.error) return data.error;
  if (httpStatus === 401 || httpStatus === 403) {
    return 'The omnisens app did not accept this page. Close this tab and start omnisens again.';
  }
  return `The omnisens app answered with HTTP ${httpStatus}.`;
}

/**
 * Calls the app's API: GET without a body, POST with a JSON body. Resolves to
 * the parsed JSON answer; throws an Error with a readable message on
 * {"error": ...}, HTTP errors and when the app is not running.
 * opts.keepalive lets a request finish while the page closes.
 */
export async function desktopApi(path, body, { keepalive = false } = {}) {
  if (!String(path).startsWith('/api/')) throw new Error(`Not an API path: ${path}`);
  if (!token) throw new Error('This page was not opened by the omnisens app.');
  const init = {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Omnisens-Token': token },
    cache: 'no-store',
    credentials: 'same-origin',
    referrerPolicy: 'no-referrer',
  };
  if (keepalive) init.keepalive = true;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('The omnisens app is not responding. Is its window still open? Start omnisens again if you closed it.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || (data && typeof data.error === 'string' && data.error)) throw new Error(apiError(res.status, data));
  if (data === null || typeof data !== 'object') throw new Error('The omnisens app sent an answer this page cannot read.');
  return data;
}

// ------------------------------------------------------------------ pure helpers for the views

/**
 * The omnisens correction currently applied on this PC, as the calibration
 * needs it: { kind: 'rawaccel'|'engine', code, paused, current: {gains, linear, rotationCdeg} },
 * or null when nothing is applied. For Raw Accel the effective profile is
 * what its four factors do (rawAccelEffectiveGains), not the omnisens profile.
 */
export function desktopCorrection(info) {
  if (!info || typeof info !== 'object') return null;
  if (info.method === 'rawaccel') {
    const ra = info.rawAccel;
    const a = ra?.applied;
    if (!a || ![a.right, a.left, a.up, a.down].every((v) => Number.isFinite(v) && v > 0)) return null;
    // Raw Accel rotates the input before scaling it (rotationDeg is clockwise positive), so a hand
    // movement at theta gets the factors' gain at theta + r. Recording r as the profile's rotation
    // lets the analysis undo it and keeps it in a refined profile.
    const r = Number.isFinite(a.rotationDeg) && a.rotationDeg !== 0 ? -a.rotationDeg : 0;
    const gains = r ? Array.from({ length: 16 }, (_, k) => rawAccelAt(a, k * 22.5 + r).gain) : rawAccelEffectiveGains(a);
    return {
      kind: 'rawaccel',
      code: typeof a.code === 'string' ? a.code : '',
      paused: !!ra.paused,
      current: { gains, linear: false, rotationCdeg: Math.round(r * 100) },
    };
  }
  if (info.method === 'engine') {
    const e = info.engine;
    if (!e?.running || typeof e.code !== 'string' || !e.code) return null;
    let cfg;
    try {
      cfg = decodeProfile(e.code);
    } catch {
      return null;
    }
    if (!(cfg.flags & FLAG_ENABLED)) return null;
    return {
      kind: 'engine',
      code: e.code,
      paused: !!e.paused,
      current: { gains: configGains(cfg), linear: !!(cfg.flags & FLAG_LINEAR), rotationCdeg: cfg.rotationCdeg },
    };
  }
  return null;
}

/** Marks the first unfinished step 'current' and the rest 'todo'. */
function withStates(steps) {
  let seen = false;
  return steps.map((s) => {
    const state = s.done ? 'done' : seen ? 'todo' : 'current';
    if (!s.done) seen = true;
    return { ...s, state };
  });
}

/** Windows set-up checklist from info.rawAccel: [{ id, label, detail, done, state }]. */
export function rawAccelSteps(ra = {}) {
  const found = !!(ra.found && ra.dir);
  const installed = !!ra.driverInstalled;
  const running = !!ra.driverRunning;
  return withStates([
    {
      id: 'files',
      label: 'Raw Accel downloaded',
      done: found,
      detail: found ? `Folder: ${ra.dir}` : 'Install it below, or point omnisens at a Raw Accel folder you already have.',
    },
    {
      id: 'driver',
      label: 'Raw Accel driver installed',
      done: installed,
      detail: installed ? 'The signed driver is installed.' : 'Install Raw Accel runs its installer, which needs a Windows administrator prompt.',
    },
    {
      id: 'restart',
      label: 'PC restarted',
      done: running,
      detail: running ? 'The driver is running.' : installed ? 'Restart your PC to load the driver, then start omnisens again.' : 'Needed once, after the driver is installed.',
    },
    {
      id: 'ready',
      label: 'Ready to apply',
      done: found && running,
      detail: found && running ? 'Pick a profile below and press Apply profile.' : 'Finish the steps above first.',
    },
  ]);
}

/** Linux permission checklist from info.engine: [{ id, label, detail, done, state }]. */
export function engineSteps(e = {}) {
  return withStates([
    {
      id: 'input',
      label: 'Read your mouse',
      done: !!e.canReadInput,
      detail: e.canReadInput ? 'omnisens can read /dev/input/event* (input group).' : 'Your user needs to be in the input group (the one-time setup below does it).',
    },
    {
      id: 'uinput',
      label: 'Create a virtual mouse',
      done: !!e.canWriteUinput,
      detail: e.canWriteUinput ? 'omnisens can write /dev/uinput.' : '/dev/uinput needs a permission rule (the one-time setup below adds it).',
    },
    {
      id: 'running',
      label: 'Correction running',
      done: !!e.running,
      detail: e.running
        ? `${e.paused ? 'Paused' : 'Running'} on ${(e.devices || []).length || 'no'} mouse device${(e.devices || []).length === 1 ? '' : 's'}.`
        : 'Pick a profile below and press Start correction.',
    },
  ]);
}

/** The one-time Linux setup command for the downloaded binary of this architecture. */
export function linuxSetupCommand(arch) {
  return `sudo ./omnisens-linux-${arch === 'arm64' ? 'arm64' : 'x64'} linux-setup --install`;
}

/** Resets module state. Tests only. */
export function _resetDesktopForTests() {
  token = null;
  ping = null;
  status = 'none';
}
