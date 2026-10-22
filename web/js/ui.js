// ui.js - small DOM helpers shared by the views. Nothing runs at import time.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export { esc } from './plot.js';

/**
 * h('button', { class: 'btn', onclick: fn, disabled: true }, 'Text', child)
 * Event handlers are attached with addEventListener (no inline handlers).
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastRoot = null;

/** Short status message; kind = 'info' | 'ok' | 'warn' | 'error'. */
export function toast(message, kind = 'info', ms = 4500) {
  toastRoot ||= document.getElementById('toasts');
  if (!toastRoot) return;
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  const close = h('button', { class: 'toast-x', type: 'button', 'aria-label': 'Dismiss', onclick: () => el.remove() }, '×');
  el.append(close);
  toastRoot.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? Math.max(ms, 8000) : ms);
}

/** Runs an async action, showing a toast on failure. Returns the result or undefined. */
export async function attempt(what, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(`${what} failed: ${e?.message || e}`, 'error');
    return undefined;
  }
}

export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { class: 'sr-only', readonly: true });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export async function copyWithToast(text, label = 'Copied') {
  if (await copyText(text)) toast(`${label} to the clipboard.`, 'ok', 2500);
  else toast('Copy failed; select the text and copy it manually.', 'warn');
}

/** Reads a user-picked file as text. */
export function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('Could not read the file.'));
    r.readAsText(file);
  });
}

export const fmt = {
  gain: (v) => (Number.isFinite(v) ? `${v.toFixed(3)}x` : '-'),
  pct: (v, digits = 1) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(digits)}%` : '-'),
  ci: (c) => (c && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? `${c[0].toFixed(3)} - ${c[1].toFixed(3)}` : '-'),
  ms: (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : '-'),
  rate: (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '-'),
  hex4: (v) => (v >>> 0).toString(16).toUpperCase().padStart(4, '0'),
};

export function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
