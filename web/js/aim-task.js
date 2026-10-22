// aim-task.js - the 3D flick task (SpiderShot style) on a Canvas2D pinhole camera.
//
// Centre target -> peripheral target -> back to centre -> next peripheral ...
// Every spawn starts a trial record holding the raw output counts the browser
// received, which analysis.js segments into the primary submovement.
// Input is integrated in the event handler, not per frame, so the camera and
// the recorded counts never lag behind the mouse.
import { MovementCapture } from './capture.js';

const D2R = Math.PI / 180;
const START_RADIUS = 1.5;   // deg, the first centre target of a round
const NEAR_Z = 0.08;

export const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Unit vector of (yaw, pitch): x right, y up, z forward. */
export function dirVec(yaw, pitch) {
  const y = yaw * D2R, p = pitch * D2R;
  return [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
}

/** World vector into camera space: undo camera yaw, then pitch. */
export function toCamera(cam, v) {
  const cy = Math.cos(cam.yaw * D2R), sy = Math.sin(cam.yaw * D2R);
  const x1 = v[0] * cy - v[2] * sy;
  const z1 = v[0] * sy + v[2] * cy;
  const cp = Math.cos(cam.pitch * D2R), sp = Math.sin(cam.pitch * D2R);
  return [x1, v[1] * cp - z1 * sp, v[1] * sp + z1 * cp];
}

/** Screen position [sx, sy, z] of a world direction, or null if behind the camera. */
export function project(cam, yaw, pitch, f, W, H) {
  const [x, y, z] = toCamera(cam, dirVec(yaw, pitch));
  if (z < NEAR_Z) return null;
  return [W / 2 + (f * x) / z, H / 2 - (f * y) / z, z];
}

export function angleBetween(y1, p1, y2, p2) {
  const a = dirVec(y1, p1), b = dirVec(y2, p2);
  return Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)) / D2R;
}

/** Output counts (HID axes, +y down) that turn the camera from `cam` onto (yaw, pitch). */
export function requiredCounts(cam, yaw, pitch, dpc) {
  return [wrap180(yaw - cam.yaw) / dpc, -(pitch - cam.pitch) / dpc];
}

export class AimTask {
  /**
   * rounds: [{ index, warmup, label?, targets: [{ theta, ampDeg, radiusDeg }] }]
   * getApplied(round) -> profile the adapter applies during that round, or null
   * getTransform(round) -> optional (dx, dy, tsMs) => [ox, oy] to simulate a profile in the browser
   * onEvent(type, data): 'locked' | 'paused' | 'round-end' | 'done'
   */
  constructor({ canvas, hud = {}, degPerCount, hFov = 103, rounds, timeoutMs = 3000,
    getApplied = () => null, getTransform = () => null, onEvent = () => {} }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hud = hud;
    this.dpc = degPerCount;
    this.hFov = hFov;
    this.rounds = rounds;
    this.timeoutMs = timeoutMs;
    this.getApplied = getApplied;
    this.getTransform = getTransform;
    this.onEvent = onEvent;

    this.cam = { yaw: 0, pitch: 0 };
    this.trials = [];
    this.roundPos = 0;
    this.targetPos = 0;
    this.state = 'ready';          // ready | running | paused | between | done
    this.target = null;
    this.trial = null;
    this.acc = null;
    this.spawnTs = 0;
    this.flash = null;
    this.mode = null;
    this.modes = new Set();
    this.applied = null;
    this.transform = null;
    this.expectUnlock = false;
    this.totalTargets = rounds.reduce((s, r) => s + r.targets.length, 0);

    this.capture = new MovementCapture(canvas, {
      move: (dx, dy, ts) => this.onMove(dx, dy, ts),
      button: (b, ts) => this.onButton(b, ts),
      lockchange: (locked) => this.onLockChange(locked),
    });
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
    this._loop = (now) => {
      this.raf = requestAnimationFrame(this._loop);
      this.tick(now);
    };
    this.raf = requestAnimationFrame(this._loop);
  }

  get round() { return this.rounds[this.roundPos] || null; }

  get completedTargets() {
    let n = 0;
    for (let i = 0; i < this.roundPos && i < this.rounds.length; i++) n += this.rounds[i].targets.length;
    return n + (this.state === 'done' ? 0 : this.targetPos);
  }

  /** Call from a click handler. Locks the pointer and starts or resumes the current round. */
  async begin() {
    if (this.state === 'done' || this.state === 'running') return this.mode;
    const mode = await this.capture.lock();
    this.mode = mode;
    this.modes.add(mode);
    this.state = 'running';
    this.applied = this.getApplied(this.round) ?? null;
    this.transform = this.getTransform(this.round) ?? null;
    this.cam = { yaw: 0, pitch: 0 };
    this.target = { kind: 'centre', yaw: 0, pitch: 0, radiusDeg: START_RADIUS };
    this.trial = null;
    this.updateHud();
    this.onEvent('locked', { mode });
    return mode;
  }

  onLockChange(locked) {
    if (locked) return;
    if (this.expectUnlock) { this.expectUnlock = false; return; }
    if (this.state !== 'running') return;
    // Esc or focus loss: drop the unfinished trial; the round resumes at the same target.
    this.trial = null;
    this.target = null;
    this.state = 'paused';
    this.onEvent('paused', {});
  }

  onMove(dx, dy, ts) {
    if (this.state !== 'running') return;
    if (this.transform) [dx, dy] = this.transform(dx, dy, ts);
    if (!dx && !dy) return;
    this.cam.yaw = wrap180(this.cam.yaw + dx * this.dpc);
    this.cam.pitch = clamp(this.cam.pitch - dy * this.dpc, -89, 89);
    const tr = this.trial;
    if (!tr) return;
    const a = this.acc;
    a.x += dx;
    a.y += dy;
    const t = Math.max(a.lastT, ts - this.spawnTs);
    a.lastT = t;
    tr.t.push(r2(t));
    tr.x.push(a.x);
    tr.y.push(a.y);
  }

  onButton(button, ts) {
    if (this.state !== 'running' || button !== 0 || !this.target) return;
    if (this.trial) this.trial.clicks++;
    const t = this.target;
    if (angleBetween(this.cam.yaw, this.cam.pitch, t.yaw, t.pitch) <= t.radiusDeg) {
      this.flash = { yaw: t.yaw, pitch: t.pitch, radiusDeg: t.radiusDeg, start: performance.now(), kind: t.kind };
      this.finishTrial(true, ts);
      this.advance(ts);
    }
  }

  tick() {
    if (this.canvas.clientWidth !== this.cssW || this.canvas.clientHeight !== this.cssH) this.resize();
    if (this.state === 'running' && this.trial) {
      const now = performance.now();
      if (now - this.spawnTs > this.timeoutMs) {
        this.finishTrial(false, now);
        this.advance(now);
      }
    }
    this.draw();
  }

  advance(ts) {
    if (this.target.kind === 'centre') {
      this.spawnPeripheral(ts);
      return;
    }
    this.targetPos++;
    if (this.targetPos >= this.round.targets.length) this.endRound();
    else this.spawnCentre(ts);
    this.updateHud();
  }

  spawnPeripheral(ts) {
    const spec = this.round.targets[this.targetPos];
    const a = spec.theta * D2R;
    this.target = {
      kind: 'out', yaw: spec.ampDeg * Math.cos(a), pitch: spec.ampDeg * Math.sin(a),
      radiusDeg: spec.radiusDeg, theta: spec.theta, ampDeg: spec.ampDeg,
    };
    this.startTrial('out', ts, spec.theta, spec.ampDeg);
  }

  spawnCentre(ts) {
    const prev = this.target;
    this.target = { kind: 'centre', yaw: 0, pitch: 0, radiusDeg: prev?.radiusDeg ?? START_RADIUS };
    this.startTrial('return', ts, prev ? (prev.theta + 180) % 360 : null, prev?.ampDeg ?? null);
  }

  startTrial(kind, ts, thetaPlanned, ampDeg) {
    const t = this.target;
    const req = requiredCounts(this.cam, t.yaw, t.pitch, this.dpc);
    this.spawnTs = ts;
    this.acc = { x: 0, y: 0, lastT: 0 };
    this.trial = {
      kind,
      round: this.round.index,
      warmup: !!this.round.warmup,
      index: this.targetPos,
      thetaPlanned: thetaPlanned === null ? null : r2(thetaPlanned),
      ampDeg,
      radiusDeg: r3(t.radiusDeg),
      req: [r3(req[0]), r3(req[1])],
      t: [0], x: [0], y: [0],
      hit: false, hitMs: null, clicks: 0, timeout: false,
      applied: this.applied,
      degPerCount: this.dpc,
    };
  }

  finishTrial(hit, ts) {
    const tr = this.trial;
    if (!tr) return;
    tr.hit = hit;
    tr.timeout = !hit;
    tr.hitMs = hit ? r2(Math.max(0, ts - this.spawnTs)) : null;
    this.trials.push(tr);
    this.trial = null;
  }

  endRound() {
    const finished = this.round;
    this.roundPos++;
    this.targetPos = 0;
    this.target = null;
    this.trial = null;
    const done = this.roundPos >= this.rounds.length;
    this.state = done ? 'done' : 'between';
    this.expectUnlock = this.capture.locked;
    this.capture.unlock();
    this.updateHud();
    this.onEvent(done ? 'done' : 'round-end', { round: finished, next: this.round });
  }

  /** Outward-flick stats for a set of trials (default: one round). */
  statsFor(filter) {
    const outs = this.trials.filter((t) => t.kind === 'out' && filter(t));
    const hits = outs.filter((t) => t.hit).length;
    const shots = outs.reduce((s, t) => s + t.clicks, 0);
    return { flicks: outs.length, hits, timeouts: outs.length - hits, shots, hitRate: outs.length ? hits / outs.length : 0, accuracy: shots ? hits / shots : 0 };
  }

  updateHud() {
    const { label, bar, count } = this.hud;
    const r = this.round;
    if (label) label.textContent = r ? (r.label || (r.warmup ? 'Warm-up' : `Round ${r.index}`)) : 'Done';
    if (count) count.textContent = r ? `${Math.min(this.targetPos + 1, r.targets.length)} / ${r.targets.length}` : '';
    if (bar) bar.style.width = `${((100 * this.completedTargets) / Math.max(1, this.totalTargets)).toFixed(1)}%`;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.cssW = this.canvas.clientWidth || 1;
    this.cssH = this.canvas.clientHeight || 1;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw() {
    const ctx = this.ctx, W = this.cssW, H = this.cssH, cam = this.cam;
    const f = W / 2 / Math.tan((this.hFov / 2) * D2R);
    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, W, H);

    // Reference grid every 10 degrees so motion and orientation stay visible.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(150, 180, 210, 0.09)';
    ctx.beginPath();
    for (let yaw = -180; yaw < 180; yaw += 10) {
      let pen = false;
      for (let p = -80; p <= 80; p += 4) pen = this.lineTo(ctx, project(cam, yaw, p, f, W, H), pen);
    }
    for (let p = -80; p <= 80; p += 10) {
      if (p === 0) continue;
      let pen = false;
      for (let yaw = -180; yaw <= 180; yaw += 3) pen = this.lineTo(ctx, project(cam, yaw, p, f, W, H), pen);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(150, 180, 210, 0.28)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let pen = false;
    for (let yaw = -180; yaw <= 180; yaw += 2) pen = this.lineTo(ctx, project(cam, yaw, 0, f, W, H), pen);
    ctx.stroke();

    if (this.target) this.drawTarget(ctx, this.target, f, W, H);
    if (this.flash) {
      const age = performance.now() - this.flash.start;
      if (age > 180) this.flash = null;
      else {
        const pt = project(cam, this.flash.yaw, this.flash.pitch, f, W, H);
        if (pt) {
          const r = (f * Math.tan(this.flash.radiusDeg * D2R)) / pt[2];
          ctx.strokeStyle = `rgba(255, 255, 255, ${0.7 * (1 - age / 180)})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(pt[0], pt[1], r * (1 + age / 90), 0, 2 * Math.PI);
          ctx.stroke();
        }
      }
    }

    // Crosshair.
    const cx = W / 2, cy = H / 2;
    ctx.lineCap = 'butt';
    for (const [w, col] of [[4, 'rgba(0,0,0,0.75)'], [2, '#ffffff']]) {
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(cx - 9, cy); ctx.lineTo(cx - 3, cy);
      ctx.moveTo(cx + 3, cy); ctx.lineTo(cx + 9, cy);
      ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy - 3);
      ctx.moveTo(cx, cy + 3); ctx.lineTo(cx, cy + 9);
      ctx.stroke();
    }
  }

  lineTo(ctx, pt, pen) {
    if (!pt) return false;
    if (pen) ctx.lineTo(pt[0], pt[1]);
    else ctx.moveTo(pt[0], pt[1]);
    return true;
  }

  drawTarget(ctx, t, f, W, H) {
    const pt = project(this.cam, t.yaw, t.pitch, f, W, H);
    if (!pt) return;
    const r = Math.max(1.5, (f * Math.tan(t.radiusDeg * D2R)) / pt[2]);
    ctx.beginPath();
    ctx.arc(pt[0], pt[1], r, 0, 2 * Math.PI);
    ctx.fillStyle = t.kind === 'centre' ? '#ffb547' : '#2ee6c8';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.stroke();
  }

  /** Stops input and rendering. Recorded trials stay readable. */
  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this._onResize);
    this.expectUnlock = this.capture.locked;
    this.capture.destroy();
    if (this.state !== 'done') this.state = 'stopped';
  }
}
