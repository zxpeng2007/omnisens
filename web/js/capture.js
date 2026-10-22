// capture.js - pointer lock + raw mouse movement.
//
// Uses pointermove + getCoalescedEvents() so every mouse report the browser
// received is seen, with its own timestamp. pointerrawupdate is deliberately
// not used as well: listening to both would count movement twice.

const SETTLE_MS = 50;      // browsers emit junk deltas right after lock changes
const SPIKE_LIMIT = 2000;  // counts per event; only filtered in accelerated mode

export const pointerLockSupported = () =>
  typeof document !== 'undefined' && typeof Element !== 'undefined' && 'requestPointerLock' in Element.prototype;

/**
 * Whether a lock granted with { unadjustedMovement: true } really delivers raw
 * counts. Chromium, Safari and Firefox 152+ reject the option with
 * NotSupportedError where they cannot honour it (e.g. on Linux); older Firefox
 * returns a promise but silently ignores the option.
 */
export const rawInputLikely = () => {
  if (typeof navigator === 'undefined') return false;
  const ff = /Firefox\/(\d+)/.exec(navigator.userAgent || '');
  return !ff || Number(ff[1]) >= 152;
};

export class LockError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LockError';
    this.code = code; // 'too-soon' | 'refused' | 'unsupported'
  }
}

export class MovementCapture {
  /**
   * el: element to lock. handlers: { move(dx, dy, ts), button(button, ts), lockchange(locked) }
   */
  constructor(el, handlers = {}) {
    this.el = el;
    this.h = handlers;
    this.mode = null;        // 'raw' | 'accel'
    this.ignoreUntil = 0;
    this._onMove = (e) => this.handleMove(e);
    this._onDown = (e) => {
      if (!this.locked) return;
      e.preventDefault();
      this.h.button?.(e.button, e.timeStamp);
    };
    this._onLockChange = () => {
      this.ignoreUntil = performance.now() + SETTLE_MS;
      this.h.lockchange?.(this.locked);
    };
    this._onContext = (e) => { if (this.locked) e.preventDefault(); };
    document.addEventListener('pointermove', this._onMove);
    document.addEventListener('pointerlockchange', this._onLockChange);
    el.addEventListener('mousedown', this._onDown);
    el.addEventListener('contextmenu', this._onContext);
  }

  get locked() {
    return document.pointerLockElement === this.el;
  }

  handleMove(e) {
    if (!this.locked) return;
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    let sx = 0, sy = 0;
    for (const c of list) { sx += c.movementX; sy += c.movementY; }
    // Firefox sometimes reports zero coalesced movement while the parent has it.
    if (!list.length || (sx === 0 && sy === 0 && (e.movementX || e.movementY))) {
      this.emit(e.movementX, e.movementY, e.timeStamp);
      return;
    }
    for (const c of list) this.emit(c.movementX, c.movementY, c.timeStamp || e.timeStamp);
  }

  emit(dx, dy, ts) {
    if (!dx && !dy) return;
    if (ts < this.ignoreUntil) return;
    if (this.mode === 'accel' && (Math.abs(dx) > SPIKE_LIMIT || Math.abs(dy) > SPIKE_LIMIT)) return;
    this.h.move?.(dx, dy, ts);
  }

  /** Must run inside a user gesture (click). Resolves to 'raw' or 'accel'. */
  async lock() {
    if (!pointerLockSupported()) throw new LockError('This browser does not support pointer lock.', 'unsupported');
    if (this.locked) return this.mode;
    try {
      const p = this.el.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.then === 'function') {
        await p;
        this.mode = rawInputLikely() ? 'raw' : 'accel';
      } else {
        // Older API: no promise and the option is ignored, so movement is accelerated.
        await this.waitForLock();
        this.mode = 'accel';
      }
    } catch (e) {
      if (e.name === 'NotSupportedError') {
        try {
          const p = this.el.requestPointerLock();
          if (p && typeof p.then === 'function') await p; else await this.waitForLock();
        } catch (e2) {
          throw toLockError(e2);
        }
        this.mode = 'accel';
      } else {
        throw toLockError(e);
      }
    }
    this.ignoreUntil = performance.now() + SETTLE_MS;
    return this.mode;
  }

  waitForLock() {
    return new Promise((resolve, reject) => {
      const done = (fn) => {
        clearTimeout(timer);
        document.removeEventListener('pointerlockchange', onChange);
        document.removeEventListener('pointerlockerror', onError);
        fn();
      };
      const onChange = () => { if (this.locked) done(resolve); };
      const onError = () => done(() => reject(new LockError('Pointer lock was refused. Click again in a second.', 'too-soon')));
      const timer = setTimeout(() => done(() => reject(new LockError('Pointer lock did not start. Click again.', 'refused'))), 2500);
      document.addEventListener('pointerlockchange', onChange);
      document.addEventListener('pointerlockerror', onError);
    });
  }

  unlock() {
    if (this.locked) document.exitPointerLock();
  }

  destroy() {
    this.unlock();
    document.removeEventListener('pointermove', this._onMove);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this.el.removeEventListener('mousedown', this._onDown);
    this.el.removeEventListener('contextmenu', this._onContext);
  }
}

function toLockError(e) {
  if (e instanceof LockError) return e;
  // Chrome refuses a new lock for about a second after the user pressed Esc.
  if (e && e.name === 'WrongDocumentError') {
    return new LockError('This page is embedded somewhere that does not allow mouse capture. Open it in its own browser tab.', 'refused');
  }
  if (e && (e.name === 'SecurityError' || e.name === 'NotAllowedError' || e.name === 'InvalidStateError')) {
    return new LockError('The browser needs a moment after Esc. Click again in a second.', 'too-soon');
  }
  return new LockError(`Pointer lock failed: ${e?.message || e}`, 'refused');
}
