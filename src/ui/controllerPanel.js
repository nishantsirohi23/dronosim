import { CONTROLLER_PROFILES } from '../config.js';
import { MODES, MODE_INFO } from '../fc/flightController.js';
import { CHANNELS, genericMapping, standardGamepadMapping } from '../input/input.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const IDENTIFY = [
  { ch: 'throttle', prompt: 'Push the THROTTLE stick fully UP and hold it.' },
  { ch: 'yaw', prompt: 'Push the YAW (rudder) stick fully RIGHT and hold it.' },
  { ch: 'pitch', prompt: 'Push the PITCH (elevator) stick fully FORWARD and hold it.' },
  { ch: 'roll', prompt: 'Push the ROLL (aileron) stick fully RIGHT and hold it.' },
];
const SWITCH_STEPS = [
  { name: 'mode', prompt: 'Flip the switch you want for FLIGHT MODE through all its positions, then return it to its first position.' },
  { name: 'arm', prompt: 'Flip the switch you want for ARM / DISARM on and off, leave it OFF.' },
  { name: 'rtl', prompt: 'Flip the switch you want for RTL on and off, leave it OFF.' },
];
const ACTIONS = { arm: 'Arm / disarm toggle', rtl: 'RTL', modeNext: 'Next mode', modePrev: 'Previous mode', capture: 'Capture overhead trail', view: 'Cycle view', clearTrail: 'Clear trail' };

// Controller selection, live channel monitor, calibration wizard and mapping editor.
export class ControllerPanel {
  constructor(sim) {
    this.sim = sim;
    this.input = sim.input;
    this.wiz = null;
    $('c-source').onchange = (e) => {
      const v = e.target.value;
      if (v === 'kb') this.input.useKeyboard();
      else this.input.selectPad(Number(v));
      this.refresh();
    };
    $('c-profiles').innerHTML = CONTROLLER_PROFILES.map((p) => `<li><span class="tag ${p.validated ? 'ok' : ''}">${p.validated ? 'Validated' : 'Profile'}</span><b>${esc(p.name)}</b><small>${esc(p.note)}</small></li>`).join('');
    window.addEventListener('gamepadconnected', () => this.isOpen() && this.refresh());
    window.addEventListener('gamepaddisconnected', () => this.isOpen() && this.refresh());
  }

  isOpen() {
    return $('dlg-controller').open;
  }

  open() {
    this.refresh();
    $('dlg-controller').showModal();
    $('dlg-controller').addEventListener('close', () => this._cancelWizard(), { once: true });
  }

  refresh() {
    const pads = this.input.listPads();
    const sel = $('c-source');
    const cur = this.input.source === 'gamepad' ? String(this.input.padIndex) : 'kb';
    sel.innerHTML = `<option value="kb">Keyboard</option>${pads.map((p) => `<option value="${p.index}">${esc(p.id.slice(0, 70))}</option>`).join('')}`;
    sel.value = pads.some((p) => String(p.index) === cur) ? cur : 'kb';
    $('c-hint').hidden = pads.length > 0;
    this._renderWizard();
    this._renderMapping();
  }

  // ------------------------------------------------------------ live monitor

  frame() {
    if (!this.isOpen()) return;
    const rc = this.input.rc;
    const chan = $('c-channels');
    const rows = [
      ['Throttle', rc.throttle, true],
      ['Yaw', rc.yaw],
      ['Pitch', rc.pitch],
      ['Roll', rc.roll],
    ];
    chan.innerHTML = rows.map(([n, v, uni]) => {
      const pct = uni ? v * 100 : (v + 1) * 50;
      return `<div class="chan"><span>${n}</span><div class="bar ${uni ? 'uni' : ''}"><i style="left:${uni ? 0 : Math.min(pct, 50)}%;width:${uni ? pct : Math.abs(pct - 50)}%"></i></div><b>${uni ? Math.round(v * 100) : Math.round(v * 100)}</b></div>`;
    }).join('') + this._switchSummary();
    const raw = this.input.raw;
    $('c-raw').innerHTML = raw.axes.length
      ? raw.axes.map((v, i) => `<div class="chan"><span>Axis ${i}</span><div class="bar"><i style="left:${Math.min((v + 1) * 50, 50)}%;width:${Math.abs(v * 50)}%"></i></div><b>${v.toFixed(2)}</b></div>`).join('')
      : '<p class="note">No controller selected.</p>';
    $('c-buttons').innerHTML = raw.buttons.map((v, i) => `<span class="${v > 0.5 ? 'on' : ''}">${i}</span>`).join('');
    if (this.wiz) this._wizardTick();
  }

  _switchSummary() {
    const s = this.input.switchState;
    const m = this.input.mapping?.switches || {};
    const parts = [];
    if (m.mode) parts.push(`Mode sw: pos ${s.mode ?? '-'}`);
    if (m.arm) parts.push(`Arm sw: ${s.arm ? 'ON' : 'OFF'}`);
    if (m.rtl) parts.push(`RTL sw: ${s.rtl ? 'ON' : 'OFF'}`);
    return parts.length ? `<p class="note">${parts.join(' | ')}</p>` : '';
  }

  // ------------------------------------------------------------ wizard

  _cancelWizard() {
    if (this.wiz) {
      this.wiz = null;
      this.input.calibrating = false;
    }
  }

  _renderWizard() {
    const el = $('wiz');
    const pad = this.input.currentPad();
    if (!pad || this.input.source !== 'gamepad') {
      el.innerHTML = '<p class="note">Select a connected controller above to calibrate it. Keyboard needs no calibration.</p>';
      return;
    }
    if (!this.wiz) {
      const m = this.input.mapping;
      el.innerHTML = `
        <p>${m?.uncalibrated ? '<b class="warn">This controller has not been calibrated.</b> ' : ''}The wizard records stick centres and end points, identifies each channel and optional switches. Takes about a minute.</p>
        <div class="row"><button type="button" class="primary" id="wz-start">Start calibration</button>
        ${pad.mapping === 'standard' ? '<button type="button" id="wz-std">Use standard gamepad preset</button>' : ''}
        <button type="button" id="wz-reset">Reset mapping</button></div>`;
      $('wz-start').onclick = () => this._startWizard();
      if ($('wz-std')) $('wz-std').onclick = () => {
        this.input.saveMapping(standardGamepadMapping(pad));
        this.refresh();
      };
      $('wz-reset').onclick = () => {
        this.input.resetMapping();
        this.refresh();
      };
      return;
    }
    const w = this.wiz;
    let html = `<div class="wz-step">Step ${w.step + 1}</div>`;
    if (w.phase === 'center') html += '<p>Centre both sticks, put the <b>throttle fully DOWN</b> and all switches in their normal (off / first) position. Then press Next.</p><div class="row"><button type="button" class="primary" id="wz-next">Next</button></div>';
    else if (w.phase === 'range') html += '<p>Move <b>both sticks around all four corners</b> several times. Then press Next.</p><div class="row"><button type="button" class="primary" id="wz-next">Next</button></div>';
    else if (w.phase === 'identify') html += `<p>${IDENTIFY[w.idx].prompt}</p><p class="note" id="wz-status">Waiting for movement...</p><div class="row"><button type="button" id="wz-skip">Skip</button></div>`;
    else if (w.phase === 'release') html += '<p>Release the stick (throttle back DOWN).</p>';
    else if (w.phase === 'switch') html += `<p>${SWITCH_STEPS[w.idx].prompt}</p><p class="note" id="wz-status">Waiting for a switch...</p><div class="row"><button type="button" id="wz-skip">Skip (no switch)</button><button type="button" class="primary" id="wz-next" disabled>Accept</button></div>`;
    else if (w.phase === 'done') html += `<p><b>Calibration complete.</b> Check the live channels: throttle 0-100 bottom to top, yaw/roll positive to the right, pitch positive forward.</p><div class="row"><button type="button" class="primary" id="wz-save">Save mapping</button><button type="button" id="wz-cancel">Discard</button></div>`;
    if (w.phase !== 'done') html += '<div class="row"><button type="button" id="wz-cancel" class="sm">Cancel</button></div>';
    el.innerHTML = html;
    const next = $('wz-next');
    if (next) next.onclick = () => this._wizNext();
    const skip = $('wz-skip');
    if (skip) skip.onclick = () => this._wizSkip();
    const cancel = $('wz-cancel');
    if (cancel) cancel.onclick = () => {
      this._cancelWizard();
      this.refresh();
    };
    const save = $('wz-save');
    if (save) save.onclick = () => {
      this.input.saveMapping(this.wiz.mapping);
      this._cancelWizard();
      this.sim.msg('Controller mapping saved', 'good');
      this.refresh();
    };
  }

  _startWizard() {
    const pad = this.input.currentPad();
    if (!pad) return;
    this.input.calibrating = true;
    const base = pad.mapping === 'standard' ? standardGamepadMapping(pad) : genericMapping(pad);
    base.switches = { mode: null, arm: null, rtl: null };
    this.wiz = { phase: 'center', step: 0, idx: 0, rest: [], min: [], max: [], assigned: new Set(), mapping: base, hold: 0, swObs: null };
    this._renderWizard();
  }

  _wizNext() {
    const w = this.wiz;
    const pad = this.input.currentPad();
    if (!pad) return;
    const ax = Array.from(pad.axes);
    if (w.phase === 'center') {
      w.rest = ax;
      w.min = [...ax];
      w.max = [...ax];
      w.btnRest = pad.buttons.map((b) => b.pressed);
      w.phase = 'range';
    } else if (w.phase === 'range') {
      w.phase = 'identify';
      w.idx = 0;
    } else if (w.phase === 'switch') {
      this._acceptSwitch();
      return;
    }
    w.step += 1;
    this._renderWizard();
  }

  _wizSkip() {
    const w = this.wiz;
    if (w.phase === 'identify') {
      w.idx += 1;
      w.step += 1;
      if (w.idx >= IDENTIFY.length) this._toSwitches();
    } else if (w.phase === 'switch') {
      w.mapping.switches[SWITCH_STEPS[w.idx].name] = null;
      this._nextSwitch();
    }
    this._renderWizard();
  }

  _toSwitches() {
    const w = this.wiz;
    w.phase = 'switch';
    w.idx = 0;
    w.swObs = null;
    this._finaliseAxes();
  }

  _nextSwitch() {
    const w = this.wiz;
    w.idx += 1;
    w.step += 1;
    w.swObs = null;
    if (w.idx >= SWITCH_STEPS.length) {
      w.phase = 'done';
      this.input.calibrating = false;
      // Preview the new mapping live before saving.
      this.input.mapping = w.mapping;
    }
  }

  _finaliseAxes() {
    const w = this.wiz;
    const m = w.mapping;
    for (const ch of CHANNELS) {
      const a = m.axes[ch];
      if (!a || a.index === null || a.index === undefined) continue;
      const i = a.index;
      a.min = w.min[i] ?? -1;
      a.max = w.max[i] ?? 1;
      a.center = w.rest[i] ?? 0;
    }
    const t = m.axes.throttle;
    if (t) {
      const mid = (t.min + t.max) / 2;
      // A throttle that rests near the middle of its travel is a spring-centred gamepad stick.
      m.throttleCentered = Math.abs(t.center - mid) < 0.2 * Math.max(t.max - t.min, 0.1);
      m.deadzone = m.throttleCentered ? 0.06 : 0.03;
    }
  }

  _wizardTick() {
    const w = this.wiz;
    const pad = this.input.currentPad();
    if (!pad) return;
    const ax = Array.from(pad.axes);
    for (let i = 0; i < ax.length; i++) {
      if (w.min.length) {
        w.min[i] = Math.min(w.min[i] ?? ax[i], ax[i]);
        w.max[i] = Math.max(w.max[i] ?? ax[i], ax[i]);
      }
    }
    if (w.phase === 'identify') {
      let best = -1;
      let bestD = 0;
      for (let i = 0; i < ax.length; i++) {
        if (w.assigned.has(i)) continue;
        const d = ax[i] - (w.rest[i] ?? 0);
        if (Math.abs(d) > Math.abs(bestD)) {
          bestD = d;
          best = i;
        }
      }
      const st = $('wz-status');
      if (best >= 0 && Math.abs(bestD) > 0.45) {
        w.hold += 1 / 60;
        if (st) st.textContent = `Detected axis ${best} (${bestD > 0 ? '+' : '-'})...`;
        if (w.hold > 0.6) {
          const ch = IDENTIFY[w.idx].ch;
          w.mapping.axes[ch] = { index: best, invert: bestD < 0, min: -1, max: 1, center: 0 };
          w.assigned.add(best);
          w.hold = 0;
          w.lastAxis = best;
          w.phase = 'release';
          this._renderWizard();
        }
      } else {
        w.hold = 0;
      }
    } else if (w.phase === 'release') {
      const i = w.lastAxis;
      if (Math.abs(ax[i] - (w.rest[i] ?? 0)) < 0.2) {
        w.idx += 1;
        w.step += 1;
        if (w.idx >= IDENTIFY.length) this._toSwitches();
        else w.phase = 'identify';
        this._renderWizard();
      }
    } else if (w.phase === 'switch') {
      w.swObs ||= { axMin: [...ax], axMax: [...ax], mids: new Array(ax.length).fill(false), btn: null };
      const o = w.swObs;
      for (let i = 0; i < ax.length; i++) {
        if (w.assigned.has(i)) continue;
        o.axMin[i] = Math.min(o.axMin[i], ax[i]);
        o.axMax[i] = Math.max(o.axMax[i], ax[i]);
        if (Math.abs(ax[i]) < 0.3) o.mids[i] = true;
      }
      pad.buttons.forEach((b, i) => {
        if (b.pressed !== (w.btnRest?.[i] ?? false) && !w.usedButtons?.has(i)) o.btn = i;
      });
      let best = -1;
      let range = 0;
      for (let i = 0; i < ax.length; i++) {
        if (w.assigned.has(i)) continue;
        const r = o.axMax[i] - o.axMin[i];
        if (r > range) {
          range = r;
          best = i;
        }
      }
      const st = $('wz-status');
      const next = $('wz-next');
      if (best >= 0 && range > 1.0) {
        o.result = { type: 'axis', index: best, positions: SWITCH_STEPS[w.idx].name === 'mode' && o.mids[best] && (w.rest[best] ?? 0) !== 0 ? 3 : 2 };
        if (st) st.textContent = `Detected axis ${best} (${o.result.positions}-position). Press Accept.`;
        if (next) next.disabled = false;
      } else if (o.btn !== null) {
        o.result = { type: 'button', index: o.btn };
        if (st) st.textContent = `Detected button ${o.btn}. Press Accept.`;
        if (next) next.disabled = false;
      }
    }
  }

  _acceptSwitch() {
    const w = this.wiz;
    const o = w.swObs;
    if (!o?.result) return;
    const name = SWITCH_STEPS[w.idx].name;
    const r = o.result;
    if (r.type === 'axis') {
      const rest = w.rest[r.index] ?? 0;
      w.mapping.switches[name] = { type: 'axis', index: r.index, positions: r.positions, invert: rest > 0.33, modes: name === 'mode' ? ['STABILIZE', 'ALT_HOLD', 'LOITER'] : undefined };
      w.assigned.add(r.index);
    } else {
      w.mapping.switches[name] = { type: 'button', index: r.index };
      w.usedButtons ||= new Set();
      w.usedButtons.add(r.index);
    }
    this._nextSwitch();
    this._renderWizard();
  }

  // ------------------------------------------------------------ mapping editor

  _renderMapping() {
    const el = $('c-map');
    const pad = this.input.currentPad();
    const m = this.input.mapping;
    if (!pad || !m || this.input.source !== 'gamepad') {
      el.innerHTML = '';
      return;
    }
    const axisOpts = (sel) => pad.axes.map((_, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>Axis ${i}</option>`).join('');
    const btnOpts = (sel) => `<option value="">None</option>${pad.buttons.map((_, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>Button ${i}</option>`).join('')}`;
    let html = '<div class="map-row head"><span>Channel</span><span>Source</span><span>Invert</span></div>';
    for (const ch of CHANNELS) {
      const a = m.axes[ch] || {};
      html += `<div class="map-row"><span>${ch}</span><select data-axis="${ch}">${axisOpts(a.index)}</select><input type="checkbox" data-inv="${ch}" ${a.invert ? 'checked' : ''}></div>`;
    }
    html += `<label class="chk"><input type="checkbox" id="m-centered" ${m.throttleCentered ? 'checked' : ''}> Spring-centred throttle (gamepad: centre = 50%)</label>`;
    html += `<label>Deadzone <output>${Math.round((m.deadzone ?? 0.04) * 100)}%</output><input type="range" id="m-dz" min="0" max="0.2" step="0.01" value="${m.deadzone ?? 0.04}"></label>`;
    html += `<label>Expo <output>${Math.round((m.expo ?? 0) * 100)}%</output><input type="range" id="m-expo" min="0" max="0.8" step="0.05" value="${m.expo ?? 0}"></label>`;
    const ms = m.switches?.mode;
    if (ms && ms.type === 'axis') {
      const modes = ms.modes || ['STABILIZE', 'ALT_HOLD', 'LOITER'];
      html += '<h4>Flight mode switch positions</h4><div class="row wrap">';
      for (let p = 0; p < (ms.positions || 2); p++) {
        html += `<label>Pos ${p + 1} <select data-swmode="${p}">${MODES.filter((x) => !MODE_INFO[x].auto || x === 'RTL' || x === 'AUTO').map((x) => `<option value="${x}" ${modes[p] === x ? 'selected' : ''}>${MODE_INFO[x].label}</option>`).join('')}</select></label>`;
      }
      html += '</div>';
    }
    html += '<h4>Button actions</h4>';
    for (const [k, label] of Object.entries(ACTIONS)) {
      html += `<div class="map-row"><span>${label}</span><select data-btn="${k}">${btnOpts(m.buttons?.[k])}</select><span></span></div>`;
    }
    html += '<div class="row"><button type="button" class="primary" id="m-save">Save mapping</button></div>';
    el.innerHTML = html;
    el.querySelectorAll('[data-axis]').forEach((s) => (s.onchange = () => {
      m.axes[s.dataset.axis] = { ...(m.axes[s.dataset.axis] || { min: -1, max: 1, center: 0 }), index: Number(s.value) };
    }));
    el.querySelectorAll('[data-inv]').forEach((c) => (c.onchange = () => {
      m.axes[c.dataset.inv].invert = c.checked;
    }));
    el.querySelectorAll('[data-btn]').forEach((s) => (s.onchange = () => {
      m.buttons ||= {};
      m.buttons[s.dataset.btn] = s.value === '' ? null : Number(s.value);
    }));
    el.querySelectorAll('[data-swmode]').forEach((s) => (s.onchange = () => {
      ms.modes ||= ['STABILIZE', 'ALT_HOLD', 'LOITER'];
      ms.modes[Number(s.dataset.swmode)] = s.value;
    }));
    $('m-centered').onchange = (e) => (m.throttleCentered = e.target.checked);
    $('m-dz').oninput = (e) => {
      m.deadzone = Number(e.target.value);
      e.target.previousElementSibling.textContent = `${Math.round(m.deadzone * 100)}%`;
    };
    $('m-expo').oninput = (e) => {
      m.expo = Number(e.target.value);
      e.target.previousElementSibling.textContent = `${Math.round(m.expo * 100)}%`;
    };
    $('m-save').onclick = () => {
      this.input.saveMapping(m);
      this.sim.msg('Controller mapping saved', 'good');
    };
  }
}

