// omni-core.js - JS mirror of firmware/src/omni_core.c (see docs/ALGORITHM.md).
// Keep the two in sync; web/test/core.test.mjs checks them against shared vectors.
//
// Conventions: deltas use HID/browser axes (+x right, +y down). Direction angle
// theta = atan2(-dy, dx) in degrees CCW: 0 right, 90 up/away, 180 left, 270 down.

export const CONFIG_VERSION = 1;
export const CONFIG_SIZE = 63;
export const MAX_POINTS = 16;
export const GAIN_ONE = 4096;
export const GAIN_MIN = 410;
export const GAIN_MAX = 32767;
export const ROTATION_LIMIT = 4500;
export const LABEL_LEN = 16;

export const FLAG_ENABLED = 1 << 0;
export const FLAG_LINEAR = 1 << 1;
export const FLAG_CHORD_TOGGLE = 1 << 2;
const FLAGS_KNOWN = FLAG_ENABLED | FLAG_LINEAR | FLAG_CHORD_TOGGLE;

const DEFAULT_RESET = 40;
const DEFAULT_SMOOTH = 32;
const MAX_SMOOTH = 4096;
const MAX_RESET = 2000;

/** Compass labels for the classic 8-direction layout (index k at k*45 deg). */
export const DIR8 = ['Right', 'Up-right', 'Up', 'Up-left', 'Left', 'Down-left', 'Down', 'Down-right'];

/** Human name for direction point k of an n-point table. */
export function directionName(k, n) {
  if (n === 8) return DIR8[k];
  if (n === 4) return ['Right', 'Up', 'Left', 'Down'][k];
  return `${Math.round((k * 360) / n)}°`;
}

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    flags: FLAG_ENABLED | FLAG_CHORD_TOGGLE,
    nPoints: 8,
    smoothingCounts: DEFAULT_SMOOTH,
    resetMs: DEFAULT_RESET,
    rotationCdeg: 0,
    calibDpi: 0,
    gainsQ12: new Array(MAX_POINTS).fill(GAIN_ONE),
    label: '',
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Returns a sanitized copy, clamped exactly like omni_config_sanitize(). */
export function sanitizeConfig(cfg) {
  const c = { ...defaultConfig(), ...cfg, gainsQ12: [...(cfg.gainsQ12 || [])] };
  c.version = CONFIG_VERSION;
  c.flags = (c.flags | 0) & FLAGS_KNOWN;
  c.nPoints = clamp(c.nPoints | 0, 1, MAX_POINTS);
  c.smoothingCounts = clamp(c.smoothingCounts | 0, 0, MAX_SMOOTH);
  c.resetMs = (c.resetMs | 0) === 0 ? DEFAULT_RESET : clamp(c.resetMs | 0, 1, MAX_RESET);
  c.rotationCdeg = clamp(c.rotationCdeg | 0, -ROTATION_LIMIT, ROTATION_LIMIT);
  c.calibDpi = clamp(c.calibDpi | 0, 0, 0xffff);
  for (let i = 0; i < MAX_POINTS; i++) {
    const g = c.gainsQ12[i] ?? GAIN_ONE;
    c.gainsQ12[i] = i >= c.nPoints ? GAIN_ONE : clamp(Math.round(g), GAIN_MIN, GAIN_MAX);
  }
  let label = '';
  for (const ch of String(c.label ?? '')) {
    if (label.length >= LABEL_LEN || ch === '\0') break;
    const code = ch.charCodeAt(0);
    label += code >= 0x20 && code <= 0x7e ? ch : '?';
  }
  c.label = label;
  return c;
}

/** 63-byte little-endian layout shared by the WebHID protocol and flash. */
export function packConfig(cfgIn) {
  const cfg = sanitizeConfig(cfgIn);
  const out = new Uint8Array(CONFIG_SIZE);
  const dv = new DataView(out.buffer);
  out[0] = cfg.version;
  out[1] = cfg.flags;
  out[2] = cfg.nPoints;
  dv.setUint16(4, cfg.smoothingCounts, true);
  dv.setUint16(6, cfg.resetMs, true);
  dv.setInt16(8, cfg.rotationCdeg, true);
  dv.setUint16(10, cfg.calibDpi, true);
  for (let i = 0; i < MAX_POINTS; i++) dv.setUint16(12 + 2 * i, cfg.gainsQ12[i], true);
  for (let i = 0; i < cfg.label.length; i++) out[44 + i] = cfg.label.charCodeAt(i);
  return out;
}

/** Accepts a Uint8Array or DataView of at least 63 bytes. Returns null on unknown version. */
export function unpackConfig(bytes) {
  const u8 = bytes instanceof DataView
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : bytes;
  if (u8.length < CONFIG_SIZE || u8[0] !== CONFIG_VERSION) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, CONFIG_SIZE);
  const gainsQ12 = [];
  for (let i = 0; i < MAX_POINTS; i++) gainsQ12.push(dv.getUint16(12 + 2 * i, true));
  let label = '';
  for (let i = 0; i < LABEL_LEN && u8[44 + i] !== 0; i++) label += String.fromCharCode(u8[44 + i]);
  return {
    version: u8[0],
    flags: u8[1],
    nPoints: u8[2],
    smoothingCounts: dv.getUint16(4, true),
    resetMs: dv.getUint16(6, true),
    rotationCdeg: dv.getInt16(8, true),
    calibDpi: dv.getUint16(10, true),
    gainsQ12,
    label,
  };
}

/** Gain table interpolation, identical to omni_engine_gain_at(). */
export function gainAt(gains, angleDeg, linear = false) {
  const n = gains.length;
  if (n <= 1) return gains[0] ?? 1;
  let u = (angleDeg * n) / 360;
  u %= n;
  if (u < 0) u += n;
  let k = Math.floor(u);
  if (k >= n) k = n - 1;
  const t = u - k;
  const p1 = gains[k];
  const p2 = gains[(k + 1) % n];
  if (linear) return p1 + (p2 - p1) * t;
  const p0 = gains[(k + n - 1) % n];
  const p3 = gains[(k + 2) % n];
  const g = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  let lo = Infinity, hi = -Infinity;
  for (const v of gains) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return clamp(g, lo, hi);
}

/** Float gains (length nPoints) from a config. */
export function configGains(cfg) {
  const c = sanitizeConfig(cfg);
  return c.gainsQ12.slice(0, c.nPoints).map((q) => q / GAIN_ONE);
}

/** Q12 encoding of float gains, clamped to the firmware's legal range. */
export function gainsToQ12(gains) {
  return gains.map((g) => clamp(Math.round(g * GAIN_ONE), GAIN_MIN, GAIN_MAX));
}

const roundAway = (v) => (v >= 0 ? Math.floor(v + 0.5) : -Math.floor(-v + 0.5));

/** Stateful engine, same behaviour as omni_engine_process() (double precision). */
export class Engine {
  constructor(cfg = defaultConfig()) {
    const c = sanitizeConfig(cfg);
    this.gains = configGains(c);
    this.enabled = (c.flags & FLAG_ENABLED) !== 0;
    this.linear = (c.flags & FLAG_LINEAR) !== 0;
    this.smoothing = c.smoothingCounts;
    this.resetUs = c.resetMs * 1000;
    const rad = (c.rotationCdeg * Math.PI) / 18000;
    this.rotate = c.rotationCdeg !== 0;
    this.rotC = Math.cos(rad);
    this.rotS = Math.sin(rad);
    this.lastAngle = 0;
    this.lastGain = 1;
    this.reset();
  }

  reset() {
    this.sx = 0; this.sy = 0;
    this.remX = 0; this.remY = 0;
    this.active = false;
    this.lastMotionUs = 0;
  }

  gainAt(angleDeg) {
    return gainAt(this.gains, angleDeg, this.linear);
  }

  /** Returns [outX, outY] integer counts. */
  process(dx, dy, nowUs) {
    if (!this.enabled) return [dx, dy];
    if (dx === 0 && dy === 0) return [0, 0];
    if (!this.active || nowUs - this.lastMotionUs > this.resetUs) this.reset();
    this.active = true;
    this.lastMotionUs = nowUs;
    if (this.smoothing > 0) {
      const keep = this.smoothing / (this.smoothing + Math.hypot(dx, dy));
      this.sx = this.sx * keep + dx;
      this.sy = this.sy * keep + dy;
    } else {
      this.sx = dx; this.sy = dy;
    }
    let ang = (Math.atan2(-this.sy, this.sx) * 180) / Math.PI;
    if (ang < 0) ang += 360;
    const g = this.gainAt(ang);
    this.lastAngle = ang;
    this.lastGain = g;
    let vx = dx * g, vy = dy * g;
    if (this.rotate) {
      const rx = vx * this.rotC + vy * this.rotS;
      const ry = -vx * this.rotS + vy * this.rotC;
      vx = rx; vy = ry;
    }
    vx += this.remX; vy += this.remY;
    const ix = roundAway(vx), iy = roundAway(vy);
    this.remX = vx - ix; this.remY = vy - iy;
    return [ix, iy];
  }
}

/** Angle (deg, CCW screen-up) of a HID-axes vector. */
export function vecAngle(dx, dy) {
  let a = (Math.atan2(-dy, dx) * 180) / Math.PI;
  if (a < 0) a += 360;
  return a;
}
