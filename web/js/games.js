// games.js - game yaw table and cm/360 math. Pure, no DOM.
//
// yaw = degrees the camera turns per mouse count at in-game sensitivity 1.0.
// Values that are community measurements rather than documented engine
// constants carry a note so the user can double-check them in game.

export const GAMES = [
  { id: 'cs2', name: 'Counter-Strike 2', yaw: 0.022, fov: 106.26 },
  { id: 'valorant', name: 'Valorant', yaw: 0.07, fov: 103 },
  { id: 'apex', name: 'Apex Legends', yaw: 0.022, fov: 110,
    note: 'The in-game FOV slider may not equal the true horizontal FOV (unverified). Adjust the FOV field if targets look off.' },
  { id: 'ow2', name: 'Overwatch 2', yaw: 0.0066, fov: 103 },
  { id: 'cod', name: 'Call of Duty (MW3 / BO6)', yaw: 0.0066, fov: 103 },
  { id: 'fortnite', name: 'Fortnite', yaw: 0.005555, fov: 103, sensLabel: 'X sensitivity (%)',
    note: 'Enter the X-axis slider percent, e.g. 8.0 (= 0.0444 deg/count).' },
  { id: 'r6', name: 'Rainbow Six Siege', yaw: 0.00572957795, fov: 103, multiplier: true,
    note: 'Uses MouseSensitivityMultiplierUnit from GameSettings.ini (default 0.02).' },
  { id: 'quake', name: 'Quake Champions', yaw: 0.022, fov: 103 },
  { id: 'marvel', name: 'Marvel Rivals', yaw: 0.0175, fov: 103,
    note: 'Community value; published conversions conflict. Verify with a 360 test.' },
  { id: 'deadlock', name: 'Deadlock', yaw: 0.044, fov: 103,
    note: 'Community value. Game files show m_yaw 0.022; the extra factor 2 is unverified.' },
  { id: 'finals', name: 'The Finals', yaw: 0.001, fov: 103, note: 'Unverified community value.' },
  { id: 'custom', name: 'Custom yaw (deg/count)', yaw: null, fov: 103,
    note: 'Degrees per count at sensitivity 1.0, e.g. 0.022 for Source-engine games.' },
  { id: 'cm360', name: 'cm/360 directly', yaw: null, fov: 103,
    note: 'Centimetres of mouse travel for a full 360 degree turn.' },
];

export const DEFAULT_FOV = 103;
export const R6_DEFAULT_MULTIPLIER = 0.02;

export function gameById(id) {
  return GAMES.find((g) => g.id === id) || null;
}

/** Default horizontal FOV for a game id. */
export function defaultFov(id) {
  return gameById(id)?.fov ?? DEFAULT_FOV;
}

/**
 * Degrees of camera rotation per mouse count. `game` is an id or a GAMES entry.
 * Returns NaN when it cannot be computed (unknown game, cm/360 mode, bad input).
 */
export function degPerCount(game, sens, customYaw = null, r6Multiplier = R6_DEFAULT_MULTIPLIER) {
  const g = typeof game === 'string' ? gameById(game) : game;
  const s = Number(sens);
  if (!g || !(s > 0)) return NaN;
  if (g.id === 'cm360') return NaN;
  if (g.id === 'custom') return Number(customYaw) > 0 ? Number(customYaw) * s : NaN;
  if (g.multiplier) {
    const m = Number(r6Multiplier) > 0 ? Number(r6Multiplier) : R6_DEFAULT_MULTIPLIER;
    return g.yaw * s * (m / R6_DEFAULT_MULTIPLIER);
  }
  return g.yaw * s;
}

/** cm of mouse travel for a 360 degree turn. */
export function cm360(dpc, dpi) {
  return (360 / (dpc * dpi)) * 2.54;
}

export function degPerCountFromCm360(cm, dpi) {
  return 360 / ((cm / 2.54) * dpi);
}

/**
 * Resolves the settings object (see settings.js) into the numbers the aim task
 * needs. Returns { ok, degPerCount, cm360, error }.
 */
export function resolveSensitivity(s) {
  const dpi = Number(s.dpi);
  if (!(dpi >= 50 && dpi <= 64000)) return { ok: false, error: 'Enter your mouse DPI (CPI), e.g. 800 or 1600.' };
  let dpc;
  if (s.game === 'cm360') {
    const cm = Number(s.cm360);
    if (!(cm > 0)) return { ok: false, error: 'Enter your cm/360.' };
    dpc = degPerCountFromCm360(cm, dpi);
  } else {
    dpc = degPerCount(s.game, s.sens, s.customYaw, s.r6Multiplier);
    if (!(dpc > 0)) {
      return { ok: false, error: s.game === 'custom' ? 'Enter a yaw value and a sensitivity.' : 'Enter your in-game sensitivity.' };
    }
  }
  const cm = cm360(dpc, dpi);
  if (!(cm >= 2 && cm <= 500)) {
    return { ok: false, degPerCount: dpc, cm360: cm, error: `That works out to ${cm.toFixed(1)} cm/360, which looks wrong. Check DPI and sensitivity.` };
  }
  return { ok: true, degPerCount: dpc, cm360: cm };
}
