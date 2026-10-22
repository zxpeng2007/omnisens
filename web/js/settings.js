// settings.js - user settings persisted in localStorage (every access guarded:
// private windows and blocked storage throw or return nothing).
import { GAMES, defaultFov, R6_DEFAULT_MULTIPLIER } from './games.js';

const KEY = 'omnisens.settings.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  dpi: 800,
  game: 'cs2',
  sens: 1.0,
  customYaw: 0.022,
  r6Multiplier: R6_DEFAULT_MULTIPLIER,
  cm360: 40,
  hFov: defaultFov('cs2'),
  preset: 'standard',        // 'quick' | 'standard' | 'custom'
  customRounds: 4,
  fullscreen: true,
  adapterMode: 'fresh',      // 'fresh' | 'refine' (only used with an adapter)
  nPoints: 16,               // profile resolution sent to the adapter (8 or 16)
  strength: 0.7,
  symmetric: false,
});

const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Returns a complete, clamped settings object. Unknown keys are dropped. */
export function sanitizeSettings(raw = {}) {
  const d = DEFAULT_SETTINGS;
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    dpi: Math.round(num(r.dpi, 50, 64000, d.dpi)),
    game: GAMES.some((g) => g.id === r.game) ? r.game : d.game,
    sens: num(r.sens, 0.0001, 100000, d.sens),
    customYaw: num(r.customYaw, 0.000001, 10, d.customYaw),
    r6Multiplier: num(r.r6Multiplier, 0.000001, 10, d.r6Multiplier),
    cm360: num(r.cm360, 1, 1000, d.cm360),
    hFov: num(r.hFov, 40, 170, d.hFov),
    preset: ['quick', 'standard', 'custom'].includes(r.preset) ? r.preset : d.preset,
    customRounds: Math.round(num(r.customRounds, 2, 10, d.customRounds)),
    fullscreen: typeof r.fullscreen === 'boolean' ? r.fullscreen : d.fullscreen,
    adapterMode: r.adapterMode === 'refine' ? 'refine' : 'fresh',
    nPoints: Number(r.nPoints) === 8 ? 8 : 16,
    strength: num(r.strength, 0, 1, d.strength),
    symmetric: typeof r.symmetric === 'boolean' ? r.symmetric : d.symmetric,
  };
}

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadSettings(store = storage()) {
  try {
    const text = store?.getItem(KEY);
    return sanitizeSettings(text ? JSON.parse(text) : {});
  } catch {
    return sanitizeSettings({});
  }
}

export function saveSettings(settings, store = storage()) {
  try {
    store?.setItem(KEY, JSON.stringify(sanitizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

export function resetSettings(store = storage()) {
  try {
    store?.removeItem(KEY);
  } catch {
    // ignore: nothing persisted
  }
  return sanitizeSettings({});
}
