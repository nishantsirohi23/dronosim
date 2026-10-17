import { MODE_INFO, RTL_PHASES } from '../fc/flightController.js';
import { ITEM_TYPES } from '../fc/mission.js';
import { RAD, bearingDeg, clamp, compassPoint, formatDuration } from '../util/math.js';

const $ = (id) => document.getElementById(id);

function setupCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// Telemetry panel, artificial horizon, heading tape, stick display and status pills.
export class Hud {
  constructor(sim) {
    this.sim = sim;
    this.t = 0;
    this.tFast = 0;
    this.att = setupCanvas($('attitude'));
    this.hdg = setupCanvas($('heading-tape'));
    this.sticks = setupCanvas($('sticks'));
    this.fields = {};
    for (const el of document.querySelectorAll('[data-tel]')) this.fields[el.dataset.tel] = el;
    this.motorBars = Array.from(document.querySelectorAll('.motor-bar > i'));
    window.addEventListener('resize', () => {
      this.att = setupCanvas($('attitude'));
      this.hdg = setupCanvas($('heading-tape'));
      this.sticks = setupCanvas($('sticks'));
    });
  }

  set(k, v) {
    const el = this.fields[k];
    if (el && el.textContent !== v) el.textContent = v;
  }

  update(dt) {
    this.t += dt;
    this.tFast += dt;
    if (this.tFast >= 1 / 30) {
      this.tFast = 0;
      this._drawAttitude();
      this._drawHeading();
      this._drawSticks();
    }
    if (this.t >= 0.1) {
      this.t = 0;
      this._text();
    }
  }

  _text() {
    const sim = this.sim;
    const fc = sim.fc;
    const q = sim.quad;
    const b = sim.battery;
    const w = sim.windAtDrone();
    this.set('alt', fc.alt.toFixed(1));
    this.set('vs', `${fc.vz >= 0 ? '+' : ''}${fc.vz.toFixed(1)}`);
    this.set('gs', fc.groundSpeed.toFixed(1));
    const air = Math.hypot(q.vel.x - sim.envState.wind.x, q.vel.z - sim.envState.wind.z);
    this.set('as', air.toFixed(1));
    this.set('hdg', `${String(Math.round(fc.heading) % 360).padStart(3, '0')}`);
    this.set('dist', fc.homeSet ? fc.distHome.toFixed(0) : '--');
    this.set('brg', fc.homeSet ? `${String(Math.round(fc.bearingHome) % 360).padStart(3, '0')} ${compassPoint(fc.bearingHome)}` : '--');
    this.set('ne', `${(-q.pos.z).toFixed(1)} N  ${q.pos.x.toFixed(1)} E`);
    this.set('volt', b.filtered.toFixed(2));
    this.set('cell', (b.filtered / b.cells).toFixed(2));
    this.set('amp', b.current.toFixed(1));
    this.set('mah', b.usedMah.toFixed(0));
    this.set('pct', b.pct.toFixed(0));
    this.set('wind', `${w.speed.toFixed(1)} m/s`);
    this.set('winddir', `from ${String(Math.round(w.from) % 360).padStart(3, '0')} ${w.cardinal}`);
    this.set('roll', `${(fc.roll * RAD).toFixed(0)}`);
    this.set('pitch', `${(fc.pitch * RAD).toFixed(0)}`);
    this.set('thr', `${Math.round(sim.input.rc.throttle * 100)}`);
    this.set('gps', sim.gps.fix ? `3D fix ${sim.gps.sats} sats` : sim.gps.sats ? `No fix (${sim.gps.sats})` : 'Searching');
    this.set('hdop', sim.gps.fix ? sim.gps.hdop.toFixed(1) : '--');
    this.set('ftime', formatDuration(fc.flightTime));
    this.set('hover', `${Math.round(fc.hoverThr * 100)}`);
    let detail = MODE_INFO[fc.mode].desc;
    if (fc.mode === 'RTL') detail = RTL_PHASES[fc.rtl.phase] || detail;
    else if (fc.mode === 'AUTO') detail = fc.autoDetail();
    this.set('modedetail', detail);
    this._mission(fc, q);
    const battEl = this.fields.pct?.closest('.tel');
    if (battEl) battEl.dataset.level = b.pct <= 10 ? 'crit' : b.pct <= 25 ? 'warn' : '';
    $('batt-fill').style.width = `${clamp(b.pct, 0, 100)}%`;
    $('batt-fill').dataset.level = b.pct <= 10 ? 'crit' : b.pct <= 25 ? 'warn' : '';
    this.motorBars.forEach((bar, i) => (bar.style.height = `${Math.round(q.out[i] * 100)}%`));

    // Status pills
    const arm = $('st-arm');
    const armTxt = q.crashed ? 'CRASHED' : fc.armed ? (fc.landed ? 'ARMED' : 'ARMED / FLYING') : 'DISARMED';
    if (arm.textContent !== armTxt) arm.textContent = armTxt;
    arm.dataset.state = q.crashed ? 'crit' : fc.armed ? 'good' : '';
    const mode = $('st-mode');
    const mt = MODE_INFO[fc.mode].label.toUpperCase();
    if (mode.textContent !== mt) mode.textContent = mt;
    mode.dataset.state = MODE_INFO[fc.mode].auto ? 'warn' : '';
    $('st-time').textContent = formatDuration(fc.flightTime);
    const gps = $('st-gps');
    gps.textContent = sim.gps.fix ? `GPS ${sim.gps.sats}` : 'NO GPS';
    gps.dataset.state = sim.gps.fix ? 'good' : 'warn';
    const fs = [];
    if (fc.fs.rc) fs.push('RADIO');
    if (fc.fs.batt === 1) fs.push('BATT LOW');
    if (fc.fs.batt === 2) fs.push('BATT CRIT');
    if (fc.fs.fence) fs.push('FENCE');
    const fsEl = $('st-fs');
    fsEl.textContent = fs.length ? `FAILSAFE: ${fs.join(' + ')}` : '';
    fsEl.hidden = !fs.length;
    const inp = $('st-input');
    const it = sim.input.source === 'gamepad' ? (sim.input.padLost ? 'CONTROLLER LOST' : 'Controller') : 'Keyboard';
    if (inp.textContent !== it) inp.textContent = it;
    inp.dataset.state = sim.input.padLost && sim.input.source === 'gamepad' ? 'crit' : '';
    for (const btn of document.querySelectorAll('[data-mode]')) btn.classList.toggle('active', btn.dataset.mode === fc.mode);
    const armBtn = $('btn-arm');
    const label = fc.armed ? 'DISARM' : 'ARM';
    if (armBtn.textContent !== label) armBtn.textContent = label;
    armBtn.classList.toggle('armed', fc.armed);
  }

  _mission(fc, q) {
    const m = fc.mission;
    const a = fc.auto;
    if (!m) {
      this.set('mis', 'None uploaded');
      this.set('wpd', '--');
      this.set('wpb', '');
      return;
    }
    const n = m.items.length;
    let txt = `Complete (${n} items)`;
    if (!a.complete && a.index < n) {
      txt = `${a.index + 1}/${n} ${ITEM_TYPES[m.items[a.index].type].label}`;
      if (fc.mode !== 'AUTO') txt += fc.armed && a.index > 0 ? ' (paused)' : ' (ready)';
    }
    this.set('mis', txt);
    const wp = a.complete ? null : fc.nextWaypoint();
    if (!wp) {
      this.set('wpd', '--');
      this.set('wpb', '');
      return;
    }
    const dx = wp.x - q.pos.x;
    const dz = wp.z - q.pos.z;
    const d = Math.hypot(dx, dz);
    this.set('wpd', d < 100 ? d.toFixed(1) : d.toFixed(0));
    this.set('wpb', `m to ${wp.home ? 'home' : `#${wp.index + 1}`}, brg ${String(Math.round(bearingDeg(dx, dz)) % 360).padStart(3, '0')}`);
  }

  _drawAttitude() {
    const { ctx, w, h } = this.att;
    const fc = this.sim.fc;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2 - 2;
    const ppd = r / 30; // pixels per degree of pitch
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-fc.roll);
    ctx.translate(0, fc.pitch * RAD * ppd);
    ctx.fillStyle = '#2f6fb3';
    ctx.fillRect(-2 * r, -4 * r, 4 * r, 4 * r);
    ctx.fillStyle = '#7a5230';
    ctx.fillRect(-2 * r, 0, 4 * r, 4 * r);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-2 * r, 0);
    ctx.lineTo(2 * r, 0);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let p = -40; p <= 40; p += 10) {
      if (p === 0) continue;
      const y = -p * ppd;
      const half = p % 20 === 0 ? r * 0.32 : r * 0.18;
      ctx.beginPath();
      ctx.moveTo(-half, y);
      ctx.lineTo(half, y);
      ctx.stroke();
      if (p % 20 === 0) ctx.fillText(String(Math.abs(p)), -half - 3, y);
    }
    ctx.restore();

    // Roll scale
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const ang = (a * Math.PI) / 180 - Math.PI / 2;
      const len = a % 30 === 0 ? 9 : 5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * (r - 1), Math.sin(ang) * (r - 1));
      ctx.lineTo(Math.cos(ang) * (r - 1 - len), Math.sin(ang) * (r - 1 - len));
      ctx.stroke();
    }
    ctx.rotate(-fc.roll);
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.moveTo(0, -r + 11);
    ctx.lineTo(-6, -r + 21);
    ctx.lineTo(6, -r + 21);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Fixed aircraft symbol
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.55, cy);
    ctx.lineTo(cx - r * 0.18, cy);
    ctx.lineTo(cx - r * 0.1, cy + 7);
    ctx.moveTo(cx + r * 0.55, cy);
    ctx.lineTo(cx + r * 0.18, cy);
    ctx.lineTo(cx + r * 0.1, cy + 7);
    ctx.stroke();
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  _drawHeading() {
    const { ctx, w, h } = this.hdg;
    const fc = this.sim.fc;
    const hdg = fc.heading;
    const ppd = w / 90;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.fillStyle = '#e6edf6';
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '600 10px system-ui, sans-serif';
    const start = Math.floor((hdg - 50) / 5) * 5;
    for (let d = start; d <= hdg + 50; d += 5) {
      const x = w / 2 + (d - hdg) * ppd;
      const dd = ((d % 360) + 360) % 360;
      const major = dd % 15 === 0;
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x, h - (major ? 8 : 4));
      ctx.stroke();
      if (dd % 45 === 0) {
        const lbl = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }[dd];
        ctx.fillStyle = dd === 0 ? '#f43f5e' : '#e6edf6';
        ctx.fillText(lbl, x, 2);
      } else if (dd % 30 === 0) {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(String(dd / 10), x, 3);
      }
    }
    // Next mission waypoint bearing marker
    const wp = fc.mode === 'AUTO' && !fc.auto.complete ? fc.nextWaypoint() : null;
    const q = this.sim.quad;
    if (wp && !wp.home && Math.hypot(wp.x - q.pos.x, wp.z - q.pos.z) > 2) {
      let rel = ((bearingDeg(wp.x - q.pos.x, wp.z - q.pos.z) - hdg + 540) % 360) - 180;
      rel = clamp(rel, -45, 45);
      const x = w / 2 + rel * ppd;
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.moveTo(x, 1);
      ctx.lineTo(x - 5, 8);
      ctx.lineTo(x + 5, 8);
      ctx.closePath();
      ctx.fill();
    }
    // Home bearing marker
    if (fc.homeSet && fc.distHome > 2) {
      let rel = ((fc.bearingHome - hdg + 540) % 360) - 180;
      rel = clamp(rel, -45, 45);
      const x = w / 2 + rel * ppd;
      ctx.fillStyle = '#4ade80';
      ctx.beginPath();
      ctx.moveTo(x, h - 1);
      ctx.lineTo(x - 5, h - 8);
      ctx.lineTo(x + 5, h - 8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#facc15';
    ctx.fillRect(w / 2 - 1, 0, 2, h);
  }

  _drawSticks() {
    const { ctx, w, h } = this.sticks;
    const rc = this.sim.input.rc;
    ctx.clearRect(0, 0, w, h);
    const size = Math.min(h - 8, w / 2 - 14);
    const boxes = [
      { x: w / 2 - size - 8, y: 4, sx: rc.yaw, sy: rc.throttle * 2 - 1, label: 'THR / YAW' },
      { x: w / 2 + 8, y: 4, sx: rc.roll, sy: rc.pitch, label: 'PIT / ROLL' },
    ];
    for (const b of boxes) {
      ctx.strokeStyle = 'rgba(148,163,184,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, size, size);
      ctx.beginPath();
      ctx.moveTo(b.x + size / 2, b.y);
      ctx.lineTo(b.x + size / 2, b.y + size);
      ctx.moveTo(b.x, b.y + size / 2);
      ctx.lineTo(b.x + size, b.y + size / 2);
      ctx.strokeStyle = 'rgba(148,163,184,0.25)';
      ctx.stroke();
      const px = b.x + size / 2 + (b.sx * size) / 2;
      const py = b.y + size / 2 - (b.sy * size) / 2;
      ctx.fillStyle = '#22d3ee';
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
