// export.js - share/import profiles as text.
import {
  packConfig, unpackConfig, sanitizeConfig, configGains, directionName, gainAt, GAIN_ONE,
  gainsToQ12, DIR8, FLAG_ENABLED, FLAG_LINEAR,
} from './omni-core.js';

const PREFIX = 'omni1.';

const b64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fromB64url(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** Compact, copy-pasteable profile code, e.g. "omni1.AQUIAC..." (the 63-byte config). */
export function encodeProfile(cfg) {
  return PREFIX + b64url(packConfig(cfg));
}

/** Parses a profile code or the JSON produced by profileJson(). Throws with a readable message. */
export function decodeProfile(text) {
  const s = String(text).trim();
  if (s.startsWith(PREFIX)) {
    let bytes;
    try { bytes = fromB64url(s.slice(PREFIX.length)); } catch { throw new Error('Profile code is not valid base64.'); }
    const cfg = bytes.length >= 63 ? unpackConfig(bytes) : null;
    if (!cfg) throw new Error('Profile code is damaged or from a newer version.');
    return sanitizeConfig(cfg);
  }
  if (s.startsWith('{')) {
    const j = JSON.parse(s);
    if (!Array.isArray(j.gains) || !j.gains.length) throw new Error('JSON profile needs a "gains" array.');
    if (j.gains.length > 16) throw new Error(`A profile has at most 16 directions; this one has ${j.gains.length}.`);
    j.gains.forEach((g, k) => {
      if (typeof g !== 'number' || !Number.isFinite(g) || g < 0.1 || g > 8) {
        throw new Error(`Gain ${k + 1} (${JSON.stringify(g)}) must be a number between 0.1 and 8.`);
      }
    });
    return sanitizeConfig({
      flags: (j.enabled === false ? 0 : 1) | (j.interpolation === 'linear' ? 2 : 0) | (j.chordToggle === false ? 0 : 4),
      nPoints: j.gains.length,
      smoothingCounts: j.smoothingCounts,
      resetMs: j.resetMs,
      rotationCdeg: Math.round((j.rotationDeg || 0) * 100),
      calibDpi: j.dpi || 0,
      gainsQ12: j.gains.map((g) => Math.round(g * GAIN_ONE)),
      label: j.label || '',
    });
  }
  throw new Error('Paste a profile code starting with "omni1." or a JSON profile.');
}

/** Human-readable JSON with directions spelled out. */
export function profileJson(cfgIn) {
  const cfg = sanitizeConfig(cfgIn);
  const gains = configGains(cfg);
  return JSON.stringify({
    format: 'omnisens-profile',
    version: 1,
    label: cfg.label,
    dpi: cfg.calibDpi || undefined,
    enabled: !!(cfg.flags & 1),
    interpolation: cfg.flags & 2 ? 'linear' : 'cubic',
    chordToggle: !!(cfg.flags & 4),
    smoothingCounts: cfg.smoothingCounts,
    resetMs: cfg.resetMs,
    rotationDeg: cfg.rotationCdeg / 100,
    directions: gains.map((g, k) => ({
      angleDeg: +((k * 360) / gains.length).toFixed(2),
      name: directionName(k, gains.length),
      gain: +g.toFixed(4),
    })),
    gains: gains.map((g) => +g.toFixed(4)),
  }, null, 2);
}

/**
 * Raw Accel (Windows, no hardware) approximation. Raw Accel v1.7 can only scale
 * right/left/down/up separately per axis (plus an overall multiplier), so this
 * takes the profile's gains at 0/180/270/90 degrees. Diagonals become a blend of
 * the two axes and their direction skews slightly; it is an approximation.
 * Format from RawAccelOfficial/rawaccel v1.7.1 (wrapper/wrapper.cpp, common/rawaccel-base.hpp).
 */
export function rawAccelSettings(cfgIn) {
  const cfg = sanitizeConfig(cfgIn);
  const gains = configGains(cfg);
  const linear = !!(cfg.flags & 2);
  const g = (deg) => gainAt(gains, deg, linear);
  const right = g(0), up = g(90), left = g(180), down = g(270);
  const noaccel = () => ({
    mode: 'noaccel', 'Gain / Velocity': true, inputOffset: 0.0, outputOffset: 0.0, acceleration: 0.005,
    decayRate: 0.1, gamma: 1.0, motivity: 1.5, exponentClassic: 2.0, scale: 1.0, exponentPower: 0.05,
    limit: 1.5, syncSpeed: 5.0, smooth: 0.5, 'Cap / Jump': { x: 15.0, y: 1.5 }, 'Cap mode': 'output', data: [],
  });
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return JSON.stringify({
    '### Accel modes ###': 'classic | jump | natural | synchronous | power | lut | noaccel',
    '### Cap modes ###': 'in_out | input | output',
    version: '1.7.0',
    defaultDeviceConfig: {
      disable: false,
      'Use constant time interval based on polling rate': false,
      'DPI (normalizes input speed unit: counts/ms -> in/s)': 0,
      'Polling rate Hz (keep at 0 for automatic adjustment)': 0,
    },
    profiles: [{
      name: cfg.label || 'omnisens',
      'Stretches domain for horizontal vs vertical inputs': { x: 1.0, y: 1.0 },
      'Stretches accel range for horizontal vs vertical inputs': { x: 1.0, y: 1.0 },
      'Whole or horizontal accel parameters': noaccel(),
      'Vertical accel parameters': noaccel(),
      'Input speed calculation parameters': {
        "Whole/combined accel (set false for 'by component' mode)": true,
        lpNorm: 2.0,
        'Time in ms after which an input is weighted at half its original value.': 0.0,
        'Time in ms after which scale is weighted at half its original value.': 0.0,
        'Time in ms after which an output is weighted at half its original value.': 0.0,
      },
      'Output DPI': r4(1000 * right),
      'Y/X output DPI ratio (vertical sens multiplier)': r4(down / right),
      'L/R output DPI ratio (left sens multiplier)': r4(left / right),
      'U/D output DPI ratio (up sens multiplier)': r4(up / down),
      // Raw Accel rotates clockwise for positive values; omnisens is counter-clockwise.
      'Degrees of rotation': r4(-cfg.rotationCdeg / 100),
      'Degrees of angle snapping': 0.0,
      'Input Speed Cap': 0.0,
    }],
    devices: [],
  }, null, 2);
}

/** Header that bakes a profile into the firmware as its factory default (firmware/src/profile_default.h). */
export function profileHeader(cfgIn) {
  const cfg = sanitizeConfig(cfgIn);
  const g = cfg.gainsQ12.slice(0, cfg.nPoints);
  return [
    '// Generated by the omnisens calibration tool.',
    '// Copy to firmware/src/profile_default.h and rebuild to make this the factory default.',
    '#pragma once',
    `#define OMNI_DEFAULT_FLAGS ${cfg.flags}`,
    `#define OMNI_DEFAULT_N_POINTS ${cfg.nPoints}`,
    `#define OMNI_DEFAULT_GAINS_Q12 {${g.join(', ')}}`,
    `#define OMNI_DEFAULT_SMOOTHING ${cfg.smoothingCounts}`,
    `#define OMNI_DEFAULT_RESET_MS ${cfg.resetMs}`,
    `#define OMNI_DEFAULT_ROTATION_CDEG ${cfg.rotationCdeg}`,
    `#define OMNI_DEFAULT_CALIB_DPI ${cfg.calibDpi}`,
    `#define OMNI_DEFAULT_LABEL "${cfg.label.replace(/["\\]/g, '')}"`,
    '',
  ].join('\n');
}

/** Direction smoothing for a DPI: about 0.5 mm of travel, round(DPI * 0.02) clamped to 8..256. */
export function smoothingForDpi(dpi) {
  const d = Number(dpi);
  if (!(d > 0)) return 32;
  return Math.min(256, Math.max(8, Math.round(d * 0.02)));
}

/**
 * Config from float gains spaced evenly from 0 deg. `base` supplies what a
 * calibration does not decide (rotation, reset time, chord toggle); the result
 * is always enabled. With a DPI, smoothing and calibDpi follow it.
 */
export function profileFromGains(gains, { dpi = 0, base = null, label = '', linear } = {}) {
  const b = sanitizeConfig(base || {});
  let flags = b.flags | FLAG_ENABLED;
  if (linear === true) flags |= FLAG_LINEAR;
  if (linear === false) flags &= ~FLAG_LINEAR;
  return sanitizeConfig({
    ...b,
    flags,
    nPoints: gains.length,
    gainsQ12: gainsToQ12(gains),
    smoothingCounts: dpi > 0 ? smoothingForDpi(dpi) : b.smoothingCounts,
    calibDpi: dpi > 0 ? Math.round(dpi) : b.calibDpi,
    label: label || b.label,
  });
}

/** The 8 headline values of a config: the gain at 0, 45, ... 315 deg. */
export function headlineGains(cfgIn) {
  const cfg = sanitizeConfig(cfgIn);
  const gains = configGains(cfg);
  const linear = !!(cfg.flags & FLAG_LINEAR);
  return DIR8.map((name, k) => ({ name, theta: k * 45, gain: gainAt(gains, k * 45, linear) }));
}

/** Plain text table of headline rows ({name, theta, gain}), tab separated for spreadsheets. */
export function headlineText(rows) {
  return ['Direction\tAngle\tMultiplier', ...rows.map((r) => `${r.name}\t${r.theta}\t${r.gain.toFixed(3)}`)].join('\n');
}
