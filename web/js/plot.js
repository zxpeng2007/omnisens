// plot.js - SVG polar charts built as strings (no libraries, no DOM at import).
//
// Angles follow the omnisens convention: degrees CCW from "mouse moves right",
// 90 = push away (cursor up). Radii are zoomed: the domain [lo, hi] maps to the
// ring between 15% and 100% of the radius so a few percent of bias is visible.
// Ring labels always state the real values.
import { DIR8 } from './omni-core.js';

const D2R = Math.PI / 180;
const SPANS = [0.04, 0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, 1.5, 2];

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const f1 = (v) => (Math.round(v * 10) / 10).toString();

/** Smallest "nice" half-span that covers a deviation. */
export function niceSpan(dev) {
  return SPANS.find((s) => s >= dev) ?? SPANS[SPANS.length - 1];
}

/** Domain [lo, hi] centred on `unit` covering every value (finite ones only). */
export function autoDomain(values, unit = 1, minSpan = 0.05) {
  let dev = 0;
  for (const v of values) if (Number.isFinite(v)) dev = Math.max(dev, Math.abs(v - unit));
  const span = niceSpan(Math.max(minSpan, dev * 1.1));
  return [Math.max(0, unit - span), unit + span];
}

export function polarScale({ size = 360, pad = 64, domain = [0.9, 1.1] } = {}) {
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - pad;
  const r0 = R * 0.15;
  const [lo, hi] = domain;
  const rad = (v) => r0 + ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (R - r0);
  const xy = (theta, v) => {
    const r = rad(v);
    return [cx + r * Math.cos(theta * D2R), cy - r * Math.sin(theta * D2R)];
  };
  return { size, cx, cy, R, r0, lo, hi, rad, xy };
}

function pathFor(sc, data, closed) {
  let d = '';
  let pen = false;
  for (const p of data) {
    if (!Number.isFinite(p.v)) { pen = false; continue; }
    const [x, y] = sc.xy(p.theta, p.v);
    d += `${pen ? 'L' : 'M'}${f1(x)} ${f1(y)}`;
    pen = true;
  }
  return closed && d ? d + 'Z' : d;
}

/**
 * opts = {
 *   title, desc, size, unit (default 1), domain ([lo,hi] or auto),
 *   series: [{ data: [{theta, v}], cls, width, dash, closed, fill }],
 *   dots: [{ theta, v, cls, r, title }],
 *   whiskers: [{ theta, lo, hi, cls }],
 *   unitLabel: label for the dashed reference ring,
 *   labels: 8 names at 0,45..315 (default DIR8) or null,
 *   needle: true to add a <line class="pc-needle"> that callers move with scale.xy()
 *   format: ring value formatter
 * }
 * Returns { svg, scale }.
 */
export function polarChart(opts = {}) {
  const {
    title = '', desc = '', size = 360, unit = 1, series = [], dots = [], whiskers = [],
    unitLabel = null, labels = DIR8, needle = false, format = (v) => v.toFixed(2),
  } = opts;
  const all = [unit];
  for (const s of series) for (const p of s.data) all.push(p.v);
  for (const d of dots) all.push(d.v);
  for (const w of whiskers) all.push(w.lo, w.hi);
  const domain = opts.domain || autoDomain(all, unit);
  const sc = polarScale({ size, domain });
  const { cx, cy, R, r0, lo, hi } = sc;
  const out = [];
  const id = `pc${Math.floor(Math.random() * 1e9).toString(36)}`;
  out.push(`<svg class="polar" viewBox="0 0 ${size} ${size}" role="img" aria-labelledby="${id}t ${id}d" xmlns="http://www.w3.org/2000/svg">`);
  out.push(`<title id="${id}t">${esc(title)}</title><desc id="${id}d">${esc(desc)}</desc>`);

  // Rings: inner, halfway, unit, halfway, outer.
  const rings = [lo, (lo + unit) / 2, (unit + hi) / 2, hi];
  out.push(`<circle class="pc-hole" cx="${cx}" cy="${cy}" r="${f1(r0)}"/>`);
  for (const v of rings) {
    out.push(`<circle class="pc-ring" cx="${cx}" cy="${cy}" r="${f1(sc.rad(v))}"/>`);
  }
  for (let k = 0; k < 8; k++) {
    const a = k * 45 * D2R;
    out.push(`<line class="pc-spoke" x1="${f1(cx + r0 * Math.cos(a))}" y1="${f1(cy - r0 * Math.sin(a))}" x2="${f1(cx + R * Math.cos(a))}" y2="${f1(cy - R * Math.sin(a))}"/>`);
  }
  out.push(`<circle class="pc-unit" cx="${cx}" cy="${cy}" r="${f1(sc.rad(unit))}"/>`);

  // Ring value labels along the 112.5 deg gap (between Up and Up-left).
  const la = 112.5 * D2R;
  for (const v of [lo, unit, hi]) {
    const r = sc.rad(v);
    const text = v === unit && unitLabel ? unitLabel : format(v);
    out.push(`<text class="pc-tick" x="${f1(cx + r * Math.cos(la))}" y="${f1(cy - r * Math.sin(la))}" text-anchor="middle" dominant-baseline="middle">${esc(text)}</text>`);
  }

  if (labels) {
    labels.forEach((name, k) => {
      const a = k * 45 * D2R;
      const lx = cx + (R + 14) * Math.cos(a), ly = cy - (R + 14) * Math.sin(a);
      const c = Math.cos(a);
      const anchor = Math.abs(c) < 0.3 ? 'middle' : c > 0 ? 'start' : 'end';
      out.push(`<text class="pc-label" x="${f1(lx)}" y="${f1(ly)}" text-anchor="${anchor}" dominant-baseline="middle">${esc(name)}</text>`);
    });
  }

  for (const s of series) {
    const d = pathFor(sc, s.data, s.closed !== false);
    if (!d) continue;
    const dash = s.dash ? ` stroke-dasharray="${s.dash}"` : '';
    const fill = s.fill ? '' : ' fill="none"';
    out.push(`<path class="pc-series ${esc(s.cls || '')}" d="${d}" stroke-width="${s.width || 2}"${dash}${fill}/>`);
  }

  for (const w of whiskers) {
    if (!Number.isFinite(w.lo) || !Number.isFinite(w.hi)) continue;
    const [x1, y1] = sc.xy(w.theta, w.lo);
    const [x2, y2] = sc.xy(w.theta, w.hi);
    const nx = -Math.sin(w.theta * D2R) * 4, ny = -Math.cos(w.theta * D2R) * 4;
    out.push(`<g class="pc-whisker ${esc(w.cls || '')}"><line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/>`
      + `<line x1="${f1(x1 - nx)}" y1="${f1(y1 - ny)}" x2="${f1(x1 + nx)}" y2="${f1(y1 + ny)}"/>`
      + `<line x1="${f1(x2 - nx)}" y1="${f1(y2 - ny)}" x2="${f1(x2 + nx)}" y2="${f1(y2 + ny)}"/></g>`);
  }

  for (const d of dots) {
    if (!Number.isFinite(d.v)) continue;
    const [x, y] = sc.xy(d.theta, d.v);
    const tip = d.title ? `<title>${esc(d.title)}</title>` : '';
    out.push(`<circle class="pc-dot ${esc(d.cls || '')}" cx="${f1(x)}" cy="${f1(y)}" r="${d.r || 4.5}">${tip}</circle>`);
  }

  if (needle) {
    out.push(`<line class="pc-needle" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy}"/><circle class="pc-needle-hub" cx="${cx}" cy="${cy}" r="4"/>`);
  }
  out.push('</svg>');
  return { svg: out.join(''), scale: sc };
}

/** Samples a gain function every `step` degrees into chart data. */
export function sampleCurve(fn, step = 3) {
  const data = [];
  for (let a = 0; a < 360; a += step) data.push({ theta: a, v: fn(a) });
  return data;
}

/** Legend as an HTML string: items = [{ cls, label, kind: 'line'|'dash'|'dot' }]. */
export function legend(items) {
  return `<ul class="legend">${items.map((it) => `<li><span class="key key-${esc(it.kind || 'line')} ${esc(it.cls || '')}" aria-hidden="true"></span>${esc(it.label)}</li>`).join('')}</ul>`;
}
