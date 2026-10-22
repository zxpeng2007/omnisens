// device.js - WebHID client for the omnisens adapter (docs/PROTOCOL.md).
import { CONFIG_SIZE, packConfig, unpackConfig } from './omni-core.js';

// pid.codes test PID (not unique, testing only) until omnisens gets its own; keep in sync with firmware/src/omnisens.h.
export const USB_VID = 0x1209;
export const USB_PID = 0x0001;
export const VENDOR_USAGE_PAGE = 0xff00;

const REPORT_CONFIG = 1;
const REPORT_STATUS = 2;
const REPORT_LIVE = 3;

export const CMD = {
  SAVE: 0x01,
  LOAD: 0x02,
  DEFAULTS: 0x03,
  SET_ENABLED: 0x04,
  BOOTLOADER: 0x05,
  REBOOT: 0x06,
  RESET_COUNTERS: 0x07,
};

const CMD_RESULT = ['ok', 'unknown command', 'flash error', 'bad arguments'];

export const webHidSupported = () => typeof navigator !== 'undefined' && 'hid' in navigator;

const FILTERS = [{ vendorId: USB_VID, productId: USB_PID, usagePage: VENDOR_USAGE_PAGE }];

const isConfigCollection = (d) =>
  d.collections?.some((c) => c.usagePage === VENDOR_USAGE_PAGE) ?? false;

export class OmniDevice extends EventTarget {
  constructor(hid) {
    super();
    this.hid = hid;
    this._onDisconnect = (e) => {
      if (e.device === this.hid) this.dispatchEvent(new Event('disconnect'));
    };
    navigator.hid.addEventListener('disconnect', this._onDisconnect);
  }

  /** Asks the user to pick the adapter (must be called from a click handler). */
  static async request() {
    const picked = await navigator.hid.requestDevice({ filters: FILTERS });
    const dev = picked.find(isConfigCollection);
    return dev ? OmniDevice._open(dev) : null;
  }

  /** Reconnects to an adapter the user already granted, without a prompt. */
  static async reconnect() {
    if (!webHidSupported()) return null;
    const devs = await navigator.hid.getDevices();
    const dev = devs.find((d) => d.vendorId === USB_VID && d.productId === USB_PID && isConfigCollection(d));
    return dev ? OmniDevice._open(dev) : null;
  }

  static async _open(dev) {
    if (!dev.opened) await dev.open();
    return new OmniDevice(dev);
  }

  get name() { return this.hid.productName || 'omnisens adapter'; }

  async close() {
    navigator.hid.removeEventListener('disconnect', this._onDisconnect);
    if (this.hid.opened) await this.hid.close();
  }

  // Some platforms include the report ID as the first byte of a feature report, others don't.
  async _get(id) {
    const dv = await this.hid.receiveFeatureReport(id);
    let u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    if (u8.length === CONFIG_SIZE + 1 && u8[0] === id) u8 = u8.subarray(1);
    if (u8.length < CONFIG_SIZE) throw new Error(`report ${id}: expected ${CONFIG_SIZE} bytes, got ${u8.length}`);
    return u8;
  }

  async _set(id, payload) {
    const buf = new Uint8Array(CONFIG_SIZE);
    buf.set(payload.subarray(0, CONFIG_SIZE));
    await this.hid.sendFeatureReport(id, buf);
  }

  async readConfig() {
    const cfg = unpackConfig(await this._get(REPORT_CONFIG));
    if (!cfg) throw new Error('Adapter speaks a newer config version; update this page.');
    return cfg;
  }

  /** Applies immediately in RAM. Call save() to keep it across power cycles. */
  async writeConfig(cfg) {
    await this._set(REPORT_CONFIG, packConfig(cfg));
  }

  async command(cmd, arg = 0) {
    const p = new Uint8Array(CONFIG_SIZE);
    p[0] = cmd;
    p[1] = arg;
    await this._set(REPORT_STATUS, p);
    if (cmd === CMD.BOOTLOADER || cmd === CMD.REBOOT) return 'ok';
    const st = await this.readStatus();
    if (st.lastResult !== 0) throw new Error(`Adapter refused command: ${CMD_RESULT[st.lastResult] || st.lastResult}`);
    return 'ok';
  }

  save() { return this.command(CMD.SAVE); }
  revert() { return this.command(CMD.LOAD); }
  loadDefaults() { return this.command(CMD.DEFAULTS); }
  setEnabled(on) { return this.command(CMD.SET_ENABLED, on ? 1 : 0); }
  enterBootloader() { return this.command(CMD.BOOTLOADER); }
  reboot() { return this.command(CMD.REBOOT); }
  resetCounters() { return this.command(CMD.RESET_COUNTERS); }

  async readStatus() {
    const u8 = await this._get(REPORT_STATUS);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const f = u8[4];
    let board = '';
    for (let i = 22; i < 38 && u8[i]; i++) board += String.fromCharCode(u8[i]);
    return {
      protocol: u8[0],
      firmware: `${u8[1]}.${u8[2]}.${u8[3]}`,
      mouseAttached: !!(f & 1),
      enabled: !!(f & 2),
      dirty: !!(f & 4),
      saved: !!(f & 8),
      keyboardAttached: !!(f & 16),
      bootFallback: !!(f & 32),
      lastResult: u8[5],
      mouseVid: dv.getUint16(6, true),
      mousePid: dv.getUint16(8, true),
      reportRate: dv.getUint16(10, true),
      boardId: u8[13],
      uptimeMs: dv.getUint32(14, true),
      saveCount: dv.getUint32(18, true),
      board,
    };
  }

  async readLive() {
    const u8 = await this._get(REPORT_LIVE);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return {
      reports: dv.getUint32(0, true),
      inX: dv.getInt32(4, true),
      inY: dv.getInt32(8, true),
      outX: dv.getInt32(12, true),
      outY: dv.getInt32(16, true),
      angleDeg: dv.getUint16(20, true) / 100,
      gain: dv.getUint16(22, true) / 4096,
      buttons: dv.getUint16(24, true),
    };
  }
}
