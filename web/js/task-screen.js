// task-screen.js - the fullscreen flick screen shared by calibration and the A/B test:
// owns the #task overlay DOM and one AimTask at a time.
import { AimTask } from './aim-task.js';
import { $, h } from './ui.js';

export class TaskScreen {
  constructor() {
    this.root = $('#task');
    this.canvas = $('#task-canvas');
    this.overlay = $('#task-overlay');
    this.titleEl = $('#ov-title');
    this.bodyEl = $('#ov-body');
    this.errEl = $('#ov-error');
    this.goBtn = $('#ov-go');
    this.quitBtn = $('#ov-quit');
    this.warnEl = $('#hud-warn');
    this.hud = { label: $('#hud-label'), bar: $('#hud-fill'), count: $('#hud-count') };
    this.task = null;
    this.opts = null;
    this.wentFullscreen = false;
    this.goBtn.addEventListener('click', () => this.onGo());
    this.quitBtn.addEventListener('click', () => this.onQuit());
  }

  get active() { return !!this.task; }

  /**
   * opts: { rounds, degPerCount, hFov, fullscreen, intro: {title, body, button},
   *   getApplied(round), getTransform(round),
   *   beforeBegin(task) -> promise|null   (e.g. switch the adapter; runs inside the click)
   *   onPause(task) -> promise|null, pauseView(task) -> {title, body, button},
   *   onRoundEnd(task, info) -> {title, body, button, busy}, onDone(task), onQuit(task), quitText }
   * Call from a click handler so fullscreen is allowed.
   */
  open(opts) {
    if (this.task) this.close();
    this.opts = opts;
    this.root.hidden = false;
    document.body.classList.add('task-open');
    this.warnEl.hidden = true;
    if (opts.fullscreen && document.documentElement.requestFullscreen && !document.fullscreenElement) {
      this.wentFullscreen = true;
      document.documentElement.requestFullscreen().catch(() => { this.wentFullscreen = false; });
    }
    this.task = new AimTask({
      canvas: this.canvas,
      hud: this.hud,
      degPerCount: opts.degPerCount,
      hFov: opts.hFov,
      rounds: opts.rounds,
      getApplied: opts.getApplied,
      getTransform: opts.getTransform,
      onEvent: (type, data) => this.onEvent(type, data),
    });
    this.task.updateHud();
    this.show(opts.intro);
  }

  /** Shows the overlay card. busy: a promise that keeps the button disabled until it settles. */
  show({ title, body = [], button = 'Continue', busy = null } = {}) {
    this.overlay.hidden = false;
    this.titleEl.textContent = title || '';
    const parts = (Array.isArray(body) ? body : [body]).filter(Boolean);
    this.bodyEl.replaceChildren(...parts.map((b) => (typeof b === 'string' ? h('p', {}, b) : b)));
    this.errEl.textContent = '';
    this.goBtn.textContent = button;
    if (busy && typeof busy.then === 'function') {
      this.goBtn.disabled = true;
      busy.catch(() => {}).finally(() => {
        this.goBtn.disabled = false;
        this.goBtn.focus();
      });
    } else {
      this.goBtn.disabled = false;
      this.goBtn.focus();
    }
  }

  async onGo() {
    const task = this.task;
    if (!task || this.goBtn.disabled) return;
    this.errEl.textContent = '';
    try {
      // Only await when there is work: some browsers drop the click's user
      // activation across an await, and pointer lock needs it.
      const pending = this.opts.beforeBegin?.(task);
      if (pending && typeof pending.then === 'function') await pending;
      await task.begin();
    } catch (e) {
      this.errEl.textContent = e?.message || String(e);
    }
  }

  onEvent(type, data) {
    const o = this.opts;
    if (type === 'locked') {
      this.overlay.hidden = true;
      if (data.mode === 'accel') {
        this.warnEl.hidden = false;
        this.warnEl.textContent = 'Raw input is not available in this browser, so OS pointer acceleration may distort the measurement. '
          + 'Windows: turn off "Enhance pointer precision". Best: Chrome or Edge on Windows/macOS.';
      }
    } else if (type === 'paused') {
      const busy = o.onPause?.(this.task) || null;
      this.show({ ...(o.pauseView?.(this.task) || { title: 'Paused', button: 'Continue' }), busy });
    } else if (type === 'round-end') {
      this.show(o.onRoundEnd?.(this.task, data) || { title: 'Round complete', button: 'Continue' });
    } else if (type === 'done') {
      o.onDone?.(this.task);
    }
  }

  onQuit() {
    if (!this.task) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(this.opts.quitText || 'Quit this session?')) return;
    this.opts.onQuit?.(this.task);
  }

  close() {
    this.task?.destroy();
    this.task = null;
    this.root.hidden = true;
    this.overlay.hidden = true;
    document.body.classList.remove('task-open');
    if (this.wentFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.wentFullscreen = false;
  }
}
