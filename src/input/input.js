import { clamp, deadband, expo } from '../util/math.js';

const STORE_KEY = 'dronosim.controllers';
export const CHANNELS = ['throttle', 'yaw', 'pitch', 'roll'];
export const SWITCHES = ['mode', 'arm', 'rtl'];

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveStore(store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable: mapping lasts for this session only */
  }
}

// W3C "standard" gamepad layout, Mode 2 (throttle + yaw on the left stick).
export function standardGamepadMapping(pad) {
  return {
    id: pad.id,
    preset: 'standard',
    throttleCentered: true,
    deadzone: 0.06,
    expo: 0.15,
    axes: {
      throttle: { index: 1, invert: true, min: -1, max: 1, center: 0 },
      yaw: { index: 0, invert: false, min: -1, max: 1, center: 0 },
      pitch: { index: 3, invert: true, min: -1, max: 1, center: 0 },
      roll: { index: 2, invert: false, min: -1, max: 1, center: 0 },
    },
    switches: { mode: null, arm: null, rtl: null },
    buttons: { arm: 9, rtl: 3, modeNext: 5, modePrev: 4, capture: 2, view: 8, clearTrail: 1 },
  };
}

// Common default for RC transmitters in USB joystick mode (AETR channel order).
export function genericMapping(pad) {
  const ax = (i) => ({ index: i, invert: false, min: -1, max: 1, center: 0 });
  return {
    id: pad.id,
    preset: 'generic',
    throttleCentered: false,
    deadzone: 0.03,
    expo: 0.1,
    axes: { roll: ax(0), pitch: { ...ax(1), invert: true }, throttle: ax(2), yaw: ax(3) },
    switches: { mode: null, arm: null, rtl: null },
    buttons: {},
    uncalibrated: true,
  };
}

export class InputManager {
  constructor() {
    this.rc = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
    this.keys = new Set();
    this.kb = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
    this.keyboardRate = 1;
    this.source = 'keyboard';
    this.padIndex = null;
    this.padId = '';
    this.mapping = null;
    this.store = loadStore();
    this.rcValid = true;
    this.padLost = false;
    this.lastButtons = [];
    this.switchState = { mode: null, arm: null, rtl: null };
    this.listeners = {};
    this.raw = { axes: [], buttons: [] };
    this.calibrating = false;
    this._bindKeyboard();
    window.addEventListener('gamepadconnected', (e) => this._onConnect(e.gamepad));
    window.addEventListener('gamepaddisconnected', (e) => this._onDisconnect(e.gamepad));
  }

  on(name, fn) {
    (this.listeners[name] ||= []).push(fn);
  }

  emit(name, arg) {
    for (const fn of this.listeners[name] || []) fn(arg);
  }

  // ------------------------------------------------------------ keyboard

  _bindKeyboard() {
    const flightKeys = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
      if (flightKeys.has(e.code) || e.code === 'Space') e.preventDefault();
      if (!e.repeat) this.emit('key', e);
      this.keys.add(e.code);
      if (e.shiftKey) this.keys.add('Shift');
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (!e.shiftKey) this.keys.delete('Shift');
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  setThrottleKeyboard(v) {
    this.kb.throttle = clamp(v, 0, 1);
  }

  _updateKeyboard(dt) {
    const k = this.keys;
    const fast = k.has('Shift') ? 2.2 : 1;
    const r = this.keyboardRate;
    const up = k.has('KeyW');
    const down = k.has('KeyS');
    if (up) this.kb.throttle += 0.45 * fast * r * dt;
    if (down) this.kb.throttle -= 0.45 * fast * r * dt;
    this.kb.throttle = clamp(this.kb.throttle, 0, 1);
    const axis = (neg, pos, cur, rate) => {
      const target = (k.has(pos) ? 1 : 0) - (k.has(neg) ? 1 : 0);
      const speed = target === 0 ? 7 : rate;
      const d = target - cur;
      const step = Math.sign(d) * Math.min(Math.abs(d), speed * dt);
      return cur + step;
    };
    this.kb.yaw = axis('KeyA', 'KeyD', this.kb.yaw, 4 * r);
    this.kb.pitch = axis('ArrowDown', 'ArrowUp', this.kb.pitch, 3.2 * r);
    this.kb.roll = axis('ArrowLeft', 'ArrowRight', this.kb.roll, 3.2 * r);
  }

  // ------------------------------------------------------------ gamepads

  listPads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return Array.from(pads).filter(Boolean);
  }

  _onConnect(pad) {
    this.emit('padconnect', pad);
    if (this.padIndex === null) this.selectPad(pad.index);
    else if (this.padLost && pad.id === this.padId) {
      this.padIndex = pad.index;
      this.padLost = false;
      this.rcValid = true;
      this.emit('padrestore', pad);
    }
  }

  _onDisconnect(pad) {
    this.emit('paddisconnect', pad);
    if (pad.index === this.padIndex) {
      this.padLost = true;
      if (this.source === 'gamepad') this.rcValid = false;
    }
  }

  selectPad(index) {
    const pad = this.listPads().find((p) => p.index === index);
    if (!pad) return;
    this.padIndex = index;
    this.padId = pad.id;
    this.padLost = false;
    this.mapping = this.store[pad.id] || (pad.mapping === 'standard' ? standardGamepadMapping(pad) : genericMapping(pad));
    this.lastButtons = pad.buttons.map((b) => b.pressed);
    this.switchState = { mode: null, arm: null, rtl: null };
    this.source = 'gamepad';
    this.rcValid = true;
    this.emit('padselect', { pad, mapping: this.mapping });
  }

  useKeyboard() {
    this.source = 'keyboard';
    this.rcValid = true;
    this.emit('padselect', { pad: null, mapping: null });
  }

  saveMapping(mapping) {
    delete mapping.uncalibrated;
    this.mapping = mapping;
    this.store[mapping.id] = mapping;
    saveStore(this.store);
  }

  resetMapping() {
    const pad = this.currentPad();
    if (!pad) return;
    delete this.store[pad.id];
    saveStore(this.store);
    this.mapping = pad.mapping === 'standard' ? standardGamepadMapping(pad) : genericMapping(pad);
  }

  currentPad() {
    if (this.padIndex === null) return null;
    return this.listPads().find((p) => p.index === this.padIndex) || null;
  }

  static readAxis(pad, a) {
    if (!a || a.index === undefined || a.index === null) return 0;
    const v = pad.axes[a.index] ?? 0;
    return a.invert ? -v : v;
  }

  // Normalise a calibrated stick axis to -1..1.
  static normCentered(pad, a) {
    if (!a) return 0;
    const v = pad.axes[a.index] ?? 0;
    let n = v >= a.center ? (v - a.center) / Math.max(a.max - a.center, 1e-3) : (v - a.center) / Math.max(a.center - a.min, 1e-3);
    n = clamp(n, -1, 1);
    return a.invert ? -n : n;
  }

  // Normalise a calibrated non-centring axis to 0..1.
  static normRange(pad, a) {
    if (!a) return 0;
    const v = pad.axes[a.index] ?? 0;
    let n = clamp((v - a.min) / Math.max(a.max - a.min, 1e-3), 0, 1);
    return a.invert ? 1 - n : n;
  }

  _readPad(pad) {
    const m = this.mapping;
    const dz = m.deadzone ?? 0.04;
    const ex = m.expo ?? 0;
    const stick = (name) => expo(deadband(InputManager.normCentered(pad, m.axes[name]), dz), ex);
    let throttle;
    if (m.throttleCentered) {
      throttle = (deadband(InputManager.normCentered(pad, m.axes.throttle), dz) + 1) / 2;
    } else {
      throttle = InputManager.normRange(pad, m.axes.throttle);
      if (throttle < 0.02) throttle = 0;
    }
    return { throttle, yaw: stick('yaw'), pitch: stick('pitch'), roll: stick('roll') };
  }

  _switchPosition(pad, sw) {
    if (!sw) return null;
    if (sw.type === 'button') return pad.buttons[sw.index]?.pressed ? 1 : 0;
    const v = pad.axes[sw.index] ?? 0;
    const n = sw.invert ? -v : v;
    const count = sw.positions || 2;
    if (count === 3) return n < -0.33 ? 0 : n > 0.33 ? 2 : 1;
    return n > 0 ? 1 : 0;
  }

  _pollPad(active) {
    const pad = this.currentPad();
    this.raw.axes = pad ? Array.from(pad.axes) : [];
    this.raw.buttons = pad ? pad.buttons.map((b) => b.value) : [];
    if (!pad || !active || this.calibrating || !this.mapping) return null;
    const vals = this._readPad(pad);

    // Momentary buttons (edge triggered).
    const pressed = pad.buttons.map((b) => b.pressed);
    const b = this.mapping.buttons || {};
    for (const [action, idx] of Object.entries(b)) {
      if (idx === null || idx === undefined) continue;
      if (pressed[idx] && !this.lastButtons[idx]) this.emit('action', { action, source: 'controller' });
    }
    this.lastButtons = pressed;

    // Latched switches (edge on position change).
    for (const name of SWITCHES) {
      const sw = this.mapping.switches?.[name];
      const pos = this._switchPosition(pad, sw);
      if (pos === null) continue;
      if (pos !== this.switchState[name]) {
        const first = this.switchState[name] === null;
        this.switchState[name] = pos;
        this.emit('switch', { name, pos, first, sw });
      }
    }
    return vals;
  }

  update(dt) {
    this._updateKeyboard(dt);
    const padVals = this._pollPad(this.source === 'gamepad');
    if (this.source === 'gamepad' && padVals) {
      // Keyboard can still nudge the sticks while a controller is active.
      this.rc.throttle = padVals.throttle;
      this.rc.yaw = clamp(padVals.yaw + this.kb.yaw, -1, 1);
      this.rc.pitch = clamp(padVals.pitch + this.kb.pitch, -1, 1);
      this.rc.roll = clamp(padVals.roll + this.kb.roll, -1, 1);
    } else if (this.source === 'gamepad' && this.padLost) {
      // Hold last values; the flight controller handles the failsafe.
    } else {
      this.rc.throttle = this.kb.throttle;
      this.rc.yaw = this.kb.yaw;
      this.rc.pitch = this.kb.pitch;
      this.rc.roll = this.kb.roll;
    }
    return this.rc;
  }
}
