import { Vector3, Euler } from 'three';
import { PID } from '../physics/pid.js';
import { G, DEG, clamp, wrapPi, expo, headingFromYaw, bearingDeg } from '../util/math.js';
import { ITEM_TYPES } from './mission.js';

export const MODES = ['STABILIZE', 'ALT_HOLD', 'LOITER', 'ACRO', 'RTL', 'LAND', 'AUTO'];

export const MODE_INFO = {
  STABILIZE: { label: 'Stabilize', short: 'STAB', key: '1', gps: false, alt: false, auto: false, desc: 'Self-levelling attitude, manual throttle' },
  ALT_HOLD: { label: 'Alt Hold', short: 'ALT', key: '2', gps: false, alt: true, auto: false, desc: 'Self-levelling, throttle stick commands climb rate' },
  LOITER: { label: 'Loiter', short: 'LOIT', key: '3', gps: true, alt: true, auto: false, desc: 'GPS position + altitude hold, sticks command velocity' },
  ACRO: { label: 'Acro', short: 'ACRO', key: '4', gps: false, alt: false, auto: false, desc: 'Rate mode, no self-levelling, manual throttle' },
  RTL: { label: 'RTL', short: 'RTL', key: '5', gps: true, alt: true, auto: true, desc: 'Climb, return home, descend and land automatically' },
  LAND: { label: 'Land', short: 'LAND', key: '6', gps: false, alt: true, auto: true, desc: 'Descend and land at current position' },
  AUTO: { label: 'Auto', short: 'AUTO', key: '7', gps: true, alt: true, auto: true, desc: 'Fly the uploaded waypoint mission' },
};

export const RTL_PHASES = {
  CLIMB: 'Climbing to RTL altitude',
  RETURN: 'Returning home',
  LOITER: 'Loitering over home',
  DESCEND: 'Final descent',
  DONE: 'Landed',
};

const _euler = new Euler(0, 0, 0, 'YXZ');
const _fwd = new Vector3();
const _right = new Vector3();
const _desVel = new Vector3();
const _tmp = new Vector3();

// Training-oriented flight controller modelled on the cascaded ArduCopter architecture:
// position -> velocity -> acceleration -> lean angle -> body rate -> torque -> motor mix.
export class FlightController {
  constructor(quad, params, gains, emit) {
    this.quad = quad;
    this.spec = quad.spec;
    this.params = { ...params };
    this.emit = emit || (() => {});
    this.mode = 'STABILIZE';
    this.armed = false;
    this.landed = true;
    this.home = new Vector3();
    this.homeHeading = 0;
    this.homeSet = false;
    this.time = 0;
    this.flightTime = 0;
    this.hoverThr = (this.spec.mass * G) / (4 * this.spec.maxThrustPerMotor);

    this.ratePID = { pitch: new PID(), yaw: new PID(), roll: new PID() };
    this.altVelPID = new PID();
    this.velPIDx = new PID();
    this.velPIDz = new PID();
    this.setGains(gains);

    this.ctl = {
      rateMode: false,
      rollT: 0,
      pitchT: 0,
      yawT: 0,
      yawRateFF: 0,
      bodyRateT: new Vector3(),
      rateT: new Vector3(),
      collective: 0,
      spoolIdle: true,
      climbT: 0,
    };
    this.torque = new Vector3();
    this.limits = { rp: false, yaw: false, thrHigh: false, thrLow: false };
    this.altTarget = 0;
    this.posTarget = new Vector3();
    this.velTarget = new Vector3();
    this.rtl = { phase: 'CLIMB', alt: 0, timer: 0 };
    // AUTO mission state. index is the current item; it is kept when the pilot takes over so
    // the mission resumes there when AUTO is selected again (ArduPilot MIS_RESTART = 0).
    this.mission = null;
    this.auto = { index: 0, phase: 'IDLE', timer: 0, hold: 0, speed: 0, endSpeed: 0, dist: NaN, distH: NaN, complete: false, origin: null, target: null, prev: null };
    this.autoArmed = false;
    this.fs = { rc: false, batt: 0, fence: false, fenceType: '' };
    this.timers = { arm: 0, disarm: 0, land: 0, air: 0, autoDisarm: 0 };

    // Navigation state read once per tick.
    this.roll = 0; // positive = right wing down
    this.pitch = 0; // positive = nose up
    this.yaw = 0; // three.js yaw (CCW)
    this.heading = 0;
    this.alt = 0;
    this.vz = 0;
    this.groundSpeed = 0;
    this.distHome = 0;
    this.bearingHome = 0;
    this.sens = { gpsFix: true, battPct: 100, rcValid: true, fence: { enabled: false } };
    this.rc = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
  }

  setGains(g) {
    this.gains = JSON.parse(JSON.stringify(g));
    for (const ax of ['roll', 'pitch', 'yaw']) this.ratePID[ax].setGains(g.rate[ax]);
    this.altVelPID.setGains({ p: g.alt.velP, i: g.alt.velI, d: 0, imax: g.alt.imax });
    const pg = { p: g.pos.velP, i: g.pos.velI, d: g.pos.velD, imax: g.pos.imax };
    this.velPIDx.setGains(pg);
    this.velPIDz.setGains(pg);
  }

  msg(text, severity = 'info') {
    this.emit('msg', { text, severity });
  }

  get modeInfo() {
    return MODE_INFO[this.mode];
  }

  get isManualThrottle() {
    return !MODE_INFO[this.mode].alt;
  }

  // ---------------------------------------------------------------- state

  _readState() {
    const q = this.quad;
    _euler.setFromQuaternion(q.quat, 'YXZ');
    this.pitch = _euler.x;
    this.yaw = _euler.y;
    this.roll = -_euler.z;
    this.heading = headingFromYaw(this.yaw);
    this.alt = q.pos.y - this.spec.gearHeight;
    this.vz = q.vel.y;
    this.groundSpeed = Math.hypot(q.vel.x, q.vel.z);
    const dx = this.home.x - q.pos.x;
    const dz = this.home.z - q.pos.z;
    this.distHome = Math.hypot(dx, dz);
    this.bearingHome = bearingDeg(dx, dz);
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  // ---------------------------------------------------------------- arming

  prearmChecks() {
    const f = [];
    const p = this.params;
    if (this.quad.crashed) f.push('Vehicle crashed - reset required');
    if (this.mode === 'AUTO') f.push('Auto mode not armable: arm in Loiter, then switch to Auto');
    else if (MODE_INFO[this.mode].auto) f.push(`Mode ${MODE_INFO[this.mode].label} not armable`);
    if (MODE_INFO[this.mode].gps && !this.sens.gpsFix) f.push('Need 3D GPS fix');
    if (!this.sens.rcValid) f.push('RC not available');
    if (this.isManualThrottle ? this.rc.throttle > 0.08 : this.rc.throttle > 0.5 + p.thrDeadband) f.push('Throttle too high');
    if (Math.acos(clamp(Math.cos(this.roll) * Math.cos(this.pitch), -1, 1)) > p.maxArmTilt) f.push('Leaning');
    if (this.sens.battPct <= p.battLowPct) f.push(`Battery ${this.sens.battPct.toFixed(0)}% below arming minimum`);
    if (this.sens.fence.enabled && this.homeSet && this._fenceBreach()) f.push('Vehicle outside fence');
    return f;
  }

  arm(source = 'button') {
    if (this.armed) return true;
    this._readState();
    const fails = this.prearmChecks();
    if (fails.length) {
      for (const t of fails) this.msg(`PreArm: ${t}`, 'warn');
      this.emit('armfail', fails);
      return false;
    }
    this.armed = true;
    this.landed = true;
    this.home.set(this.quad.pos.x, 0, this.quad.pos.z);
    this.homeHeading = this.yaw;
    this.homeSet = true;
    this.flightTime = 0;
    this.fs.batt = 0;
    this.fs.fence = false;
    this.timers.autoDisarm = 0;
    this.auto.index = 0;
    this.auto.complete = false;
    this.autoArmed = false;
    this._resetControllers();
    this.msg(`Arming motors (${source})`, 'good');
    this.emit('armed', { source });
    return true;
  }

  disarm(reason = 'Disarming motors', severity = 'info') {
    if (!this.armed) return;
    this.armed = false;
    this.quad.cmd.fill(0);
    this.msg(reason, severity);
    this.emit('disarmed', { reason });
  }

  requestDisarm(source = 'button') {
    if (!this.armed) return false;
    if (!this.landed && !this.quad.contact) {
      this.msg('Disarm refused: vehicle airborne (use EMERGENCY STOP)', 'warn');
      return false;
    }
    this.disarm(`Disarming motors (${source})`);
    return true;
  }

  emergencyStop() {
    if (!this.armed) return;
    this.disarm('EMERGENCY MOTOR STOP', 'crit');
  }

  // ---------------------------------------------------------------- modes

  setMode(mode, reason = 'pilot') {
    if (!MODE_INFO[mode]) return false;
    if (mode === this.mode) return true;
    const info = MODE_INFO[mode];
    if (info.gps && !this.sens.gpsFix) {
      this.msg(`Mode change to ${info.label} failed: need GPS fix`, 'warn');
      return false;
    }
    if (reason === 'pilot' && this.fs.fence && (!info.auto || mode === 'AUTO')) {
      this.msg('Fence breached: return inside the fence first', 'warn');
      return false;
    }
    if (reason === 'pilot' && this.fs.rc && !this.sens.rcValid) {
      this.msg('Radio failsafe active: mode change refused', 'warn');
      return false;
    }
    if (mode === 'AUTO') {
      if (!this.mission) {
        this.msg('Mode change to Auto failed: no mission uploaded', 'warn');
        return false;
      }
      if (this.landed && this.mission.items[0].type !== 'TAKEOFF') {
        this.msg('Mode change to Auto failed: on the ground the mission must start with TAKEOFF', 'warn');
        return false;
      }
    }
    const prev = this.mode;
    this.mode = mode;
    this._enterMode(prev);
    this.msg(`Mode ${info.label}${reason !== 'pilot' ? ` (${reason})` : ''}`, info.auto ? 'warn' : 'info');
    this.emit('mode', { mode, prev, reason });
    return true;
  }

  _enterMode(prev) {
    this._readState();
    const q = this.quad;
    this.ctl.yawT = this.yaw;
    this.ctl.yawRateFF = 0;
    // Bumpless transfer into altitude control: preload the velocity integrator so the
    // collective output continues from the current value.
    if (MODE_INFO[this.mode].alt && !MODE_INFO[prev].alt) {
      this.altTarget = this.alt;
      const cosT = Math.max(Math.cos(this.roll) * Math.cos(this.pitch), 0.5);
      const pre = (this.ctl.collective * cosT / this.hoverThr - 1) * G;
      this.altVelPID.reset(this.landed ? 0 : clamp(pre, -this.gains.alt.imax, this.gains.alt.imax));
    }
    this.posTarget.set(q.pos.x, 0, q.pos.z);
    this.velTarget.set(q.vel.x, 0, q.vel.z);
    this.velPIDx.reset();
    this.velPIDz.reset();
    if (this.mode === 'RTL') this._enterRTL();
    if (this.mode === 'AUTO') this._enterAuto();
  }

  _enterRTL() {
    const p = this.params;
    this.rtl.timer = 0;
    this.rtl.alt = Math.max(p.rtlAlt, this.alt);
    if (this.sens.fence.enabled) this.rtl.alt = Math.min(this.rtl.alt, Math.max(this.sens.fence.maxAlt - 2, 3));
    this.posTarget.set(this.quad.pos.x, 0, this.quad.pos.z);
    if (this.distHome < p.rtlConeDist) {
      this.rtl.alt = this.alt;
      this.rtl.phase = 'LOITER';
    } else {
      this.rtl.phase = this.alt < this.rtl.alt - 0.5 ? 'CLIMB' : 'RETURN';
    }
    this.msg(`RTL: ${RTL_PHASES[this.rtl.phase]} (RTL alt ${this.rtl.alt.toFixed(0)} m)`, 'warn');
  }

  _resetControllers() {
    for (const k of ['pitch', 'yaw', 'roll']) this.ratePID[k].reset();
    this.altVelPID.reset();
    this.velPIDx.reset();
    this.velPIDz.reset();
    this.ctl.yawT = this.yaw;
    this.ctl.yawRateFF = 0;
    this.ctl.rollT = 0;
    this.ctl.pitchT = 0;
    this.altTarget = this.alt;
    this.posTarget.set(this.quad.pos.x, 0, this.quad.pos.z);
    this.velTarget.set(0, 0, 0);
  }

  // ---------------------------------------------------------------- main update

  update(dt, rc, sens) {
    this.time += dt;
    this.rc = rc;
    this.sens = sens;
    this._readState();

    if (this.quad.crashed && this.armed) this.disarm(`CRASH: ${this.quad.crashReason}. Disarming`, 'crit');

    this._stickGestures(dt, rc);
    this._failsafes();
    this._landDetector(dt, rc);
    this._autoDisarm(dt, rc);

    if (!this.armed) {
      this.quad.cmd.fill(0);
      this.ctl.collective = 0;
      this.ctl.spoolIdle = true;
      return;
    }
    if (!this.landed) this.flightTime += dt;
    // ArduPilot auto_armed: an AUTO takeoff from the ground waits until the throttle is raised.
    if (rc.throttle > 0.1 && this.sens.rcValid) this.autoArmed = true;

    this.ctl.spoolIdle = false;
    this.ctl.rateMode = false;
    switch (this.mode) {
      case 'STABILIZE': this._modeStabilize(dt, rc); break;
      case 'ACRO': this._modeAcro(dt, rc); break;
      case 'ALT_HOLD': this._modeAltHold(dt, rc); break;
      case 'LOITER': this._modeLoiter(dt, rc); break;
      case 'RTL': this._modeRTL(dt); break;
      case 'LAND': this._modeLand(dt, rc); break;
      case 'AUTO': this._modeAuto(dt, rc); break;
      default: break;
    }

    if (this.ctl.spoolIdle) {
      for (const k of ['pitch', 'yaw', 'roll']) this.ratePID[k].reset();
      this.ctl.yawT = this.yaw;
      this.quad.cmd.fill(this.spec.idle);
      this.torque.set(0, 0, 0);
      return;
    }
    this._attitudeController();
    this._rateController(dt);
    this._mix();
  }

  // ---------------------------------------------------------------- pilot input helpers

  _throttleCurve(s) {
    const h = clamp(this.hoverThr, 0.2, 0.8);
    return s < 0.5 ? (s / 0.5) * h : h + ((s - 0.5) / 0.5) * (1 - h);
  }

  _pilotClimb(thr) {
    const p = this.params;
    const x = thr - 0.5;
    if (Math.abs(x) <= p.thrDeadband) return 0;
    const n = (Math.abs(x) - p.thrDeadband) / (0.5 - p.thrDeadband);
    return x > 0 ? n * p.climbMax : -n * p.descentMax;
  }

  _pilotAngles(rc) {
    const p = this.params;
    let r = expo(rc.roll, p.rpExpo);
    let pt = expo(rc.pitch, p.rpExpo);
    const mag = Math.hypot(r, pt);
    if (mag > 1) {
      r /= mag;
      pt /= mag;
    }
    this.ctl.rollT = r * p.angleMax;
    this.ctl.pitchT = -pt * p.angleMax;
  }

  _yawInput(rate, dt) {
    this.ctl.yawT = wrapPi(this.ctl.yawT + rate * dt);
    this.ctl.yawRateFF = rate;
    const err = wrapPi(this.ctl.yawT - this.yaw);
    if (Math.abs(err) > 0.6) this.ctl.yawT = wrapPi(this.yaw + Math.sign(err) * 0.6);
  }

  _yawToward(targetYaw, dt) {
    const maxStep = this.params.rtlYawRate * dt;
    const diff = clamp(wrapPi(targetYaw - this.ctl.yawT), -maxStep, maxStep);
    this.ctl.yawT = wrapPi(this.ctl.yawT + diff);
    this.ctl.yawRateFF = diff / dt;
  }

  _pilotYaw(rc, dt) {
    this._yawInput(-expo(rc.yaw, this.params.yawExpo) * this.params.pilotYawRate, dt);
  }

  // ---------------------------------------------------------------- flight modes

  _modeStabilize(dt, rc) {
    if (this.landed && rc.throttle < 0.04) {
      this.ctl.spoolIdle = true;
      return;
    }
    this._pilotAngles(rc);
    this._pilotYaw(rc, dt);
    const cosT = Math.max(Math.cos(this.roll) * Math.cos(this.pitch), 0.6);
    this.ctl.collective = clamp(this._throttleCurve(rc.throttle) / cosT, 0, 1);
  }

  _modeAcro(dt, rc) {
    if (this.landed && rc.throttle < 0.04) {
      this.ctl.spoolIdle = true;
      return;
    }
    const p = this.params;
    this.ctl.rateMode = true;
    this.ctl.bodyRateT.set(
      -expo(rc.pitch, p.acroExpo) * p.acroRate,
      -expo(rc.yaw, p.acroExpo) * p.acroYawRate,
      -expo(rc.roll, p.acroExpo) * p.acroRate,
    );
    this.ctl.collective = this._throttleCurve(rc.throttle);
  }

  _modeAltHold(dt, rc) {
    const climb = this._pilotClimb(rc.throttle);
    if (this.landed) {
      if (climb <= 0) {
        this.ctl.spoolIdle = true;
        this.altTarget = this.alt;
        this.altVelPID.reset();
        return;
      }
      this._takeoff();
    }
    this._pilotAngles(rc);
    this._pilotYaw(rc, dt);
    this._altController(dt, climb);
  }

  _modeLoiter(dt, rc) {
    const p = this.params;
    const climb = this._pilotClimb(rc.throttle);
    if (this.landed) {
      if (climb <= 0) {
        this.ctl.spoolIdle = true;
        this.altTarget = this.alt;
        this.altVelPID.reset();
        this._holdHere();
        return;
      }
      this._takeoff();
      this._holdHere();
    }
    this._pilotYaw(rc, dt);
    const f = expo(rc.pitch, p.rpExpo) * p.loiterSpeed;
    const r = expo(rc.roll, p.rpExpo) * p.loiterSpeed;
    _desVel.copy(_fwd).multiplyScalar(f).addScaledVector(_right, r);
    if (_desVel.length() > p.loiterSpeed) _desVel.setLength(p.loiterSpeed);
    const active = Math.abs(rc.pitch) > 0.02 || Math.abs(rc.roll) > 0.02;
    this._posController(dt, _desVel, active ? p.loiterAccel : p.loiterBrake, p.loiterSpeed, p.loiterAngleMax);
    this._altController(dt, climb);
  }

  _modeLand(dt, rc) {
    const p = this.params;
    if (this.landed) {
      this.ctl.spoolIdle = true;
      return;
    }
    const climb = -(this.alt > p.landAltLow ? p.landSpeedHigh : p.landSpeed);
    if (this.sens.gpsFix) {
      const f = this.sens.rcValid ? rc.pitch * p.landReposition : 0;
      const r = this.sens.rcValid ? rc.roll * p.landReposition : 0;
      _desVel.copy(_fwd).multiplyScalar(f).addScaledVector(_right, r);
      this._posController(dt, _desVel, p.loiterAccel, p.landReposition, p.loiterAngleMax);
    } else {
      this.ctl.rollT = 0;
      this.ctl.pitchT = 0;
    }
    if (this.sens.rcValid) this._pilotYaw(rc, dt);
    else this._yawInput(0, dt);
    this._altController(dt, climb);
  }

  _modeRTL(dt) {
    const p = this.params;
    const r = this.rtl;
    const q = this.quad;
    let climb = 0;
    _desVel.set(0, 0, 0);
    let accel = p.loiterBrake;
    switch (r.phase) {
      case 'CLIMB':
        climb = p.rtlClimbRate;
        this._yawInput(0, dt);
        if (this.alt >= r.alt - 0.4) this._rtlPhase('RETURN');
        break;
      case 'RETURN': {
        _tmp.set(this.home.x - q.pos.x, 0, this.home.z - q.pos.z);
        const dist = _tmp.length();
        const speed = Math.min(p.rtlSpeed, Math.sqrt(2 * p.loiterAccel * 0.6 * dist));
        if (dist > 0.01) _desVel.copy(_tmp).multiplyScalar(speed / dist);
        accel = p.loiterAccel;
        if (dist > 4) this._yawToward(Math.atan2(-_tmp.x, -_tmp.z), dt);
        else this._yawInput(0, dt);
        this.altTarget = r.alt;
        if (dist < 1.2 && this.groundSpeed < 0.7) this._rtlPhase('LOITER');
        break;
      }
      case 'LOITER':
        r.timer += dt;
        this._pullTargetHome(dt);
        this._yawToward(this.homeHeading, dt);
        if (r.timer >= p.rtlLoiterTime) this._rtlPhase('DESCEND');
        break;
      case 'DESCEND':
        this._pullTargetHome(dt);
        this._yawInput(0, dt);
        climb = -(this.alt > p.landAltLow ? p.landSpeedHigh : p.landSpeed);
        break;
      case 'DONE':
      default:
        this.ctl.spoolIdle = true;
        return;
    }
    if (this.landed) {
      this.ctl.spoolIdle = true;
      return;
    }
    this._posController(dt, _desVel, accel, p.rtlSpeed, p.loiterAngleMax);
    this._altController(dt, climb);
  }

  _rtlPhase(phase) {
    this.rtl.phase = phase;
    this.rtl.timer = 0;
    this.msg(`RTL: ${RTL_PHASES[phase]}`, 'info');
  }

  // ---------------------------------------------------------------- AUTO missions

  // Load a normalised mission (see mission.js). Replacing it during AUTO restarts at item 1.
  setMission(mission) {
    this.mission = mission && mission.items && mission.items.length ? mission : null;
    const a = this.auto;
    a.index = 0;
    a.complete = false;
    a.prev = null;
    if (this.mode !== 'AUTO') return;
    if (!this.mission) this.setMode(this.sens.gpsFix ? 'LOITER' : 'ALT_HOLD', 'mission cleared');
    else if (this.landed && this.mission.items[0].type !== 'TAKEOFF') this.setMode('LOITER', 'mission has no takeoff');
    else {
      this.msg('Mission replaced in flight: restarting at item 1', 'warn');
      this._autoStart(0);
    }
  }

  _enterAuto() {
    const a = this.auto;
    if (this.landed || a.complete || a.index >= this.mission.items.length) a.index = 0;
    a.complete = false;
    a.prev = null;
    if (a.index > 0) this.msg(`Mission: resuming at item ${a.index + 1}`, 'info');
    this._autoStart(a.index);
  }

  _autoStart(i) {
    const p = this.params;
    const a = this.auto;
    const items = this.mission.items;
    const n = items.length;
    const q = this.quad;
    const here = { x: q.pos.x, z: q.pos.z, alt: this.alt };
    a.index = i;
    a.timer = 0;
    a.hold = 0;
    a.speed = p.wpSpeed;
    a.endSpeed = 0;
    a.dist = NaN;
    a.distH = NaN;
    a.origin = a.prev || here;
    a.prev = null;
    a.target = here;
    this.emit('missionitem', { index: i });
    if (i >= n) {
      a.phase = 'DONE';
      a.complete = true;
      this.emit('missioncomplete', { landed: false });
      this.msg('Mission complete: holding position. Change mode to take over', 'good');
      return;
    }
    const it = items[i];
    const tag = `Mission ${i + 1}/${n}`;
    switch (it.type) {
      case 'TAKEOFF':
        a.phase = 'TAKEOFF';
        a.target = { x: here.x, z: here.z, alt: it.alt };
        this.msg(`${tag}: takeoff to ${it.alt} m`, 'info');
        if (this.armed && this.landed && !this.autoArmed) this.msg('AUTO: raise the throttle to start the mission', 'warn');
        break;
      case 'WAYPOINT':
        a.phase = 'GO';
        a.target = { x: it.x, z: it.z, alt: it.alt };
        a.speed = it.speed;
        a.hold = it.hold;
        a.endSpeed = this._cornerSpeed(i);
        break;
      case 'LOITER_TIME':
        a.phase = 'GO';
        if (it.x !== null) a.target = { x: it.x, z: it.z, alt: it.alt ?? this.alt };
        a.hold = it.time;
        this.msg(`${tag}: loiter ${it.time} s`, 'info');
        break;
      case 'RTL':
        a.phase = 'RTL';
        this.msg(`${tag}: return to launch`, 'info');
        this._enterRTL();
        break;
      case 'LAND':
        a.phase = it.x !== null ? 'GO' : 'LAND';
        if (it.x !== null) a.target = { x: it.x, z: it.z, alt: this.alt };
        this.msg(`${tag}: land${it.x !== null ? ' at position' : ''}`, 'info');
        break;
      default:
        this._autoNext();
        break;
    }
  }

  _autoNext() {
    this.auto.prev = this.auto.target;
    this._autoStart(this.auto.index + 1);
  }

  _autoReached() {
    const a = this.auto;
    const it = this.mission.items[a.index];
    this.emit('wp', { index: a.index, dist: a.dist, t: this.time });
    if (it.type === 'LAND') {
      a.phase = 'LAND';
      return;
    }
    this.msg(`Reached ${it.type === 'WAYPOINT' ? 'waypoint' : 'item'} ${a.index + 1} (${a.dist.toFixed(1)} m)`, 'info');
    if (a.hold > 0) {
      a.phase = 'HOLD';
      a.timer = 0;
    } else {
      this._autoNext();
    }
  }

  // Speed to carry through a waypoint: full speed on a straight line, slowing for sharper
  // turns and stopping where the next item is not a pass-through waypoint.
  _cornerSpeed(i) {
    const items = this.mission.items;
    const it = items[i];
    const nx = items[i + 1];
    if (it.hold > 0 || !nx || nx.type !== 'WAYPOINT') return 0;
    const o = this.auto.origin;
    const ax = it.x - o.x;
    const az = it.z - o.z;
    const bx = nx.x - it.x;
    const bz = nx.z - it.z;
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    if (la < 0.5 || lb < 0.5) return 0;
    const cos = (ax * bx + az * bz) / (la * lb);
    return Math.min(it.speed, nx.speed) * Math.max(0, (1 + cos) / 2);
  }

  // Climb rate that moves the altitude target to `alt`, limited to `rate`.
  _climbToward(alt, rate) {
    const e = alt - this.altTarget;
    return Math.sign(e) * Math.min(Math.abs(e) * 1.5, rate);
  }

  _returningOrLanding() {
    if (this.mode === 'RTL' || this.mode === 'LAND') return true;
    if (this.mode !== 'AUTO' || !this.mission) return false;
    const it = this.mission.items[this.auto.index];
    return !!it && (it.type === 'RTL' || it.type === 'LAND');
  }

  _modeAuto(dt, rc) {
    const p = this.params;
    const a = this.auto;
    const q = this.quad;
    if (!this.sens.gpsFix) {
      this.setMode('LAND', 'GPS lost');
      this._modeLand(dt, rc);
      return;
    }
    if (a.phase === 'RTL') {
      this._modeRTL(dt);
      return;
    }
    if (this.landed) {
      if (a.phase !== 'TAKEOFF' || !this.autoArmed) {
        this.ctl.spoolIdle = true;
        this.altTarget = this.alt;
        this.altVelPID.reset();
        this._holdHere();
        return;
      }
      this._takeoff();
      this._holdHere();
    }
    const t = a.target;
    let climb = 0;
    let accel = p.loiterBrake;
    _desVel.set(0, 0, 0);
    switch (a.phase) {
      case 'TAKEOFF':
        this._pullTargetTo(t.x, t.z, dt);
        this._yawInput(0, dt);
        climb = this._climbToward(t.alt, p.wpSpeedUp);
        if (this.alt >= t.alt - 0.5) this._autoNext();
        break;
      case 'GO': {
        const o = a.origin;
        const dx = t.x - q.pos.x;
        const dz = t.z - q.pos.z;
        const distH = Math.hypot(dx, dz);
        const dAlt = t.alt - this.alt;
        a.distH = distH;
        a.dist = Math.hypot(distH, dAlt);
        // Pure-pursuit carrot on the straight track from the leg origin to the waypoint.
        let cx = t.x;
        let cz = t.z;
        const lx = t.x - o.x;
        const lz = t.z - o.z;
        const len = Math.hypot(lx, lz);
        if (len > 0.5) {
          const ux = lx / len;
          const uz = lz / len;
          const along = clamp((q.pos.x - o.x) * ux + (q.pos.z - o.z) * uz, 0, len);
          const ahead = Math.min(along + Math.max(a.speed, 3), len);
          cx = o.x + ux * ahead;
          cz = o.z + uz * ahead;
        }
        // Cruise speed, braking for the corner (or stop) at the waypoint, slowed so a climb or
        // descent finishes together with the horizontal leg.
        const vUp = dAlt > 0 ? p.wpSpeedUp : p.wpSpeedDn;
        let v = Math.min(a.speed, Math.sqrt(a.endSpeed * a.endSpeed + 2 * p.wpAccel * 0.6 * distH));
        if (Math.abs(dAlt) > 0.5) v = Math.min(v, Math.max((distH * vUp) / Math.abs(dAlt), 0.3));
        _tmp.set(cx - q.pos.x, 0, cz - q.pos.z);
        const cl = _tmp.length();
        if (cl > 0.01) _desVel.copy(_tmp).multiplyScalar(v / cl);
        const vz = Math.min(vUp, Math.abs(dAlt) / Math.max(distH / Math.max(v, 0.3), 0.1));
        climb = this._climbToward(t.alt, Math.max(vz, 0.2));
        accel = p.wpAccel;
        if (distH > 3) this._yawToward(Math.atan2(-dx, -dz), dt);
        else this._yawInput(0, dt);
        if (a.dist <= p.wpRadius) this._autoReached();
        break;
      }
      case 'HOLD':
        a.timer += dt;
        this._pullTargetTo(t.x, t.z, dt);
        this._yawInput(0, dt);
        climb = this._climbToward(t.alt, p.wpSpeedUp);
        if (a.timer >= a.hold) this._autoNext();
        break;
      case 'LAND':
        this._pullTargetTo(t.x, t.z, dt);
        this._yawInput(0, dt);
        climb = -(this.alt > p.landAltLow ? p.landSpeedHigh : p.landSpeed);
        break;
      case 'DONE':
      default:
        this._yawInput(0, dt);
        break;
    }
    if (a.phase === 'RTL') {
      // The mission reached its RTL item this tick; RTL control takes over from the next one.
      _desVel.set(0, 0, 0);
      climb = 0;
    }
    this._posController(dt, _desVel, accel, Math.max(a.speed, p.wpSpeed), p.loiterAngleMax);
    this._altController(dt, climb);
  }

  // Next mission position the drone is heading for (for telemetry), also while another mode
  // has control. Returns null when there is no mission or no position ahead.
  nextWaypoint() {
    const m = this.mission;
    if (!m) return null;
    const a = this.auto;
    const items = m.items;
    for (let k = a.index; k < items.length; k++) {
      const it = items[k];
      if (it.type === 'WAYPOINT') return { index: k, x: it.x, z: it.z, alt: it.alt };
      if (it.type === 'RTL') return { index: k, x: this.home.x, z: this.home.z, alt: 0, home: true };
      if ((it.type === 'LOITER_TIME' || it.type === 'LAND') && it.x !== null) return { index: k, x: it.x, z: it.z, alt: it.alt ?? null };
      if (it.type === 'LAND') return null;
    }
    return null;
  }

  autoDetail() {
    const a = this.auto;
    const m = this.mission;
    if (!m) return 'No mission uploaded';
    const n = m.items.length;
    if (a.phase === 'DONE' || a.index >= n) return 'Mission complete: holding position';
    const it = m.items[a.index];
    const tag = `${a.index + 1}/${n} ${ITEM_TYPES[it.type].label}`;
    if (this.landed && this.armed) return this.autoArmed ? `${tag}: starting` : 'Raise the throttle to start the mission';
    switch (a.phase) {
      case 'TAKEOFF': return `${tag}: climbing to ${a.target.alt} m`;
      case 'GO': return it.type === 'LAND' ? `${tag}: flying to landing point` : `${tag}: ${a.target.alt} m at ${a.speed.toFixed(1)} m/s`;
      case 'HOLD': return `${tag}: holding ${Math.max(0, a.hold - a.timer).toFixed(0)} s`;
      case 'LAND': return `${tag}: descending`;
      case 'RTL': return `${tag}: ${RTL_PHASES[this.rtl.phase] || ''}`;
      default: return tag;
    }
  }

  _pullTargetHome(dt) {
    this._pullTargetTo(this.home.x, this.home.z, dt);
  }

  _pullTargetTo(x, z, dt) {
    _tmp.set(x - this.posTarget.x, 0, z - this.posTarget.z);
    const d = _tmp.length();
    const step = Math.min(d, 1.0 * dt);
    if (d > 1e-4) this.posTarget.addScaledVector(_tmp, step / d);
  }

  _holdHere() {
    this.posTarget.set(this.quad.pos.x, 0, this.quad.pos.z);
    this.velTarget.set(0, 0, 0);
    this.velPIDx.reset();
    this.velPIDz.reset();
  }

  _takeoff() {
    this.landed = false;
    this.altTarget = this.alt;
    this.altVelPID.reset();
    this.ctl.yawT = this.yaw;
    this.msg('Takeoff', 'info');
  }

  // ---------------------------------------------------------------- position / altitude control

  _altController(dt, climbRate) {
    const g = this.gains.alt;
    const fence = this.sens.fence;
    if (fence.enabled && climbRate > 0 && this.altTarget >= fence.maxAlt - 1.5) {
      climbRate = 0;
      this.altTarget = Math.min(this.altTarget, fence.maxAlt - 1.5);
    }
    this.ctl.climbT = climbRate;
    this.altTarget += climbRate * dt;
    this.altTarget = clamp(this.altTarget, this.alt - 3, this.alt + 3);
    const velT = clamp(g.posP * (this.altTarget - this.alt) + climbRate, -3, 3);
    const holdI = this.limits.thrHigh && velT > this.vz;
    const accT = clamp(this.altVelPID.update(velT - this.vz, dt, holdI || this.landed), -6, 6);
    const cosT = Math.max(Math.cos(this.roll) * Math.cos(this.pitch), 0.6);
    const col = clamp((this.hoverThr * (G + accT)) / G / cosT, 0, 1);
    this.ctl.collective = col;
    // Learn hover throttle while hovering steadily (ArduCopter MOT_THST_HOVER behaviour).
    if (!this.landed && Math.abs(this.vz) < 0.4 && Math.abs(climbRate) < 0.1 && !this.quad.contact) {
      this.hoverThr += (col * cosT - this.hoverThr) * dt * 0.08;
      this.hoverThr = clamp(this.hoverThr, 0.2, 0.8);
    }
  }

  _posController(dt, desVel, maxAccel, maxSpeed, angleMax) {
    const g = this.gains.pos;
    const q = this.quad;
    // Shape target velocity with an acceleration limit.
    _tmp.copy(desVel).sub(this.velTarget);
    _tmp.y = 0;
    const dvMax = maxAccel * dt;
    if (_tmp.length() > dvMax) _tmp.setLength(dvMax);
    this.velTarget.add(_tmp);
    const ffAx = _tmp.x / dt;
    const ffAz = _tmp.z / dt;
    this.posTarget.addScaledVector(this.velTarget, dt);
    // Leash: keep the target reachable.
    _tmp.set(this.posTarget.x - q.pos.x, 0, this.posTarget.z - q.pos.z);
    if (_tmp.length() > this.params.posLeash) {
      _tmp.setLength(this.params.posLeash);
      this.posTarget.set(q.pos.x + _tmp.x, 0, q.pos.z + _tmp.z);
    }
    let vcx = g.posP * _tmp.x + this.velTarget.x;
    let vcz = g.posP * _tmp.z + this.velTarget.z;
    const vcm = Math.hypot(vcx, vcz);
    const vlim = maxSpeed + 2;
    if (vcm > vlim) {
      vcx *= vlim / vcm;
      vcz *= vlim / vcm;
    }
    const aLim = G * Math.tan(angleMax);
    const hold = this.limits.rp;
    let ax = this.velPIDx.update(vcx - q.vel.x, dt, hold) + ffAx;
    let az = this.velPIDz.update(vcz - q.vel.z, dt, hold) + ffAz;
    const am = Math.hypot(ax, az);
    if (am > aLim) {
      ax *= aLim / am;
      az *= aLim / am;
    }
    const aF = ax * _fwd.x + az * _fwd.z;
    const aR = ax * _right.x + az * _right.z;
    this.ctl.pitchT = -Math.atan2(aF, G);
    this.ctl.rollT = Math.atan2(aR * Math.cos(this.ctl.pitchT), G);
    // Skids on the ground: do not lean (avoids tip-over and lets the land detector settle).
    if (q.contact) {
      this.ctl.pitchT = 0;
      this.ctl.rollT = 0;
      this._holdHere();
    }
  }

  // ---------------------------------------------------------------- attitude / rate / mixer

  _attitudeController() {
    const p = this.params;
    const rt = this.ctl.rateT;
    if (this.ctl.rateMode) {
      rt.copy(this.ctl.bodyRateT);
      return;
    }
    const k = this.gains.angle;
    // Euler angles in three.js YXZ convention: phi (about Z, + = left wing down).
    const phi = -this.roll;
    const theta = this.pitch;
    const phiT = -this.ctl.rollT;
    const phiDot = clamp(k.roll * (phiT - phi), -p.angleRateMax, p.angleRateMax);
    const thetaDot = clamp(k.pitch * (this.ctl.pitchT - theta), -p.angleRateMax, p.angleRateMax);
    const psiDot = clamp(k.yaw * wrapPi(this.ctl.yawT - this.yaw) + this.ctl.yawRateFF, -2.5, 2.5);
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    rt.set(cp * thetaDot + sp * ct * psiDot, -sp * thetaDot + cp * ct * psiDot, phiDot - st * psiDot);
  }

  _rateController(dt) {
    const w = this.quad.omega;
    const rt = this.ctl.rateT;
    const I = this.spec.inertia;
    const holdRP = this.limits.rp || this.landed;
    const holdY = this.limits.yaw || this.landed;
    const ax = this.ratePID.pitch.update(rt.x - w.x, dt, holdRP);
    const ay = this.ratePID.yaw.update(rt.y - w.y, dt, holdY);
    const az = this.ratePID.roll.update(rt.z - w.z, dt, holdRP);
    this.torque.set(ax * I.pitch, ay * I.yaw, az * I.roll);
  }

  _mix() {
    const s = this.spec;
    const d = s.armLength / Math.SQRT2;
    const tm = s.maxThrustPerMotor;
    const idle = s.idle;
    const p = this.torque.x / (4 * d * tm);
    const r = -this.torque.z / (4 * d * tm);
    let y = -this.torque.y / (4 * s.yawTorqueCoeff * tm);
    // M1 FR, M2 RL, M3 FL, M4 RR
    const rp = [-r + p, r - p, r + p, -r - p];
    const ys = [1, 1, -1, -1];
    let mx = Math.max(...rp);
    let mn = Math.min(...rp);
    const range = 1 - idle;
    this.limits.rp = false;
    if (mx - mn > range) {
      const k = range / (mx - mn);
      for (let i = 0; i < 4; i++) rp[i] *= k;
      mx *= k;
      mn *= k;
      this.limits.rp = true;
    }
    let col = this.ctl.collective;
    this.limits.thrHigh = col + mx > 1;
    this.limits.thrLow = col + mn < idle;
    col = clamp(col, idle - mn, 1 - mx);
    // Yaw gets whatever headroom remains.
    let yMax = Infinity;
    let yMin = -Infinity;
    for (let i = 0; i < 4; i++) {
      const base = col + rp[i];
      if (ys[i] > 0) {
        yMax = Math.min(yMax, 1 - base);
        yMin = Math.max(yMin, idle - base);
      } else {
        yMax = Math.min(yMax, base - idle);
        yMin = Math.max(yMin, base - 1);
      }
    }
    const yc = clamp(y, Math.min(yMin, 0), Math.max(yMax, 0));
    this.limits.yaw = Math.abs(yc - y) > 1e-6;
    y = yc;
    for (let i = 0; i < 4; i++) this.quad.cmd[i] = clamp(col + rp[i] + ys[i] * y, idle, 1);
  }

  // ---------------------------------------------------------------- safety logic

  _stickGestures(dt, rc) {
    const p = this.params;
    const low = rc.throttle < 0.06;
    if (!this.armed && low && rc.yaw > 0.85) {
      this.timers.arm += dt;
      if (this.timers.arm >= p.armGestureTime) {
        this.timers.arm = -10;
        this.arm('stick');
      }
    } else if (this.timers.arm > 0 || !(low && rc.yaw > 0.85)) {
      this.timers.arm = 0;
    }
    if (this.armed && low && rc.yaw < -0.85 && !MODE_INFO[this.mode].auto) {
      this.timers.disarm += dt;
      if (this.timers.disarm >= p.armGestureTime) {
        this.timers.disarm = -10;
        this.requestDisarm('stick');
      }
    } else if (!(low && rc.yaw < -0.85)) {
      this.timers.disarm = 0;
    }
  }

  _landDetector(dt, rc) {
    const q = this.quad;
    if (!this.armed) {
      this.landed = q.contact;
      this.timers.land = 0;
      return;
    }
    if (this.landed) {
      // Manual-throttle modes leave the ground when the airframe lifts off.
      if (this.isManualThrottle && !q.contact) {
        this.timers.air += dt;
        if (this.timers.air > 0.15) {
          this.landed = false;
          this.timers.air = 0;
        }
      } else {
        this.timers.air = 0;
      }
      return;
    }
    const lowThrust = this.isManualThrottle ? rc.throttle < 0.3 : this.ctl.collective < this.hoverThr * 0.85;
    if (q.contact && Math.abs(this.vz) < 0.35 && lowThrust) {
      this.timers.land += dt;
      if (this.timers.land > 1.0) {
        this.landed = true;
        this.timers.land = 0;
        this.msg(`Landed (touchdown ${q.lastImpact.toFixed(1)} m/s)`, 'info');
        this.emit('landed', { impact: q.lastImpact });
        const autoLand = this.mode === 'AUTO' && this._returningOrLanding();
        if (this.mode === 'RTL' || this.mode === 'LAND' || autoLand) {
          if (this.mode === 'RTL' || (autoLand && this.auto.phase === 'RTL')) this.rtl.phase = 'DONE';
          if (autoLand) {
            this.auto.complete = true;
            this.emit('missioncomplete', { landed: true });
          }
          this.disarm(autoLand ? 'Mission complete: landed, disarming' : `${MODE_INFO[this.mode].label} complete: disarming`, 'good');
        }
      }
    } else {
      this.timers.land = 0;
    }
  }

  _autoDisarm(dt, rc) {
    if (!this.armed || !this.landed) {
      this.timers.autoDisarm = 0;
      return;
    }
    const low = this.isManualThrottle ? rc.throttle < 0.05 : rc.throttle < 0.5 - this.params.thrDeadband;
    if (low) {
      this.timers.autoDisarm += dt;
      if (this.timers.autoDisarm >= this.params.disarmDelay) this.disarm('Auto-disarm: landed with throttle low');
    } else {
      this.timers.autoDisarm = 0;
    }
  }

  _fenceBreach() {
    const f = this.sens.fence;
    if (this.alt > f.maxAlt) return 'altitude';
    if (this.distHome > f.radius) return 'radius';
    return '';
  }

  _failsafes() {
    const p = this.params;
    const s = this.sens;
    const airborne = this.armed && !this.landed;

    if (!s.rcValid && !this.fs.rc) {
      this.fs.rc = true;
      this.msg('Radio failsafe: controller lost', 'crit');
      if (this.armed) {
        if (this.landed) this.disarm('Radio failsafe: disarming on ground', 'crit');
        else if (this.mode === 'AUTO' && this._returningOrLanding()) this.msg('Radio failsafe: mission already returning / landing, continuing', 'warn');
        else if (s.gpsFix && this.distHome > 2) this.setMode('RTL', 'radio failsafe');
        else this.setMode('LAND', 'radio failsafe');
      }
    } else if (s.rcValid && this.fs.rc) {
      this.fs.rc = false;
      this.msg('Radio failsafe cleared: select a mode to retake control', 'good');
    }

    const pct = s.battPct;
    if (this.fs.batt < 2 && pct <= p.battCritPct) {
      this.fs.batt = 2;
      this.msg(`Battery failsafe CRITICAL (${pct.toFixed(0)}%)`, 'crit');
      if (airborne && this.mode !== 'LAND') this.setMode('LAND', 'battery critical');
    } else if (this.fs.batt < 1 && pct <= p.battLowPct) {
      this.fs.batt = 1;
      this.msg(`Battery failsafe LOW (${pct.toFixed(0)}%)`, 'warn');
      if (airborne && !this._returningOrLanding()) this.setMode(s.gpsFix ? 'RTL' : 'LAND', 'battery low');
    }

    if (s.fence.enabled && airborne) {
      const breach = this._fenceBreach();
      if (breach && !this.fs.fence) {
        this.fs.fence = true;
        this.fs.fenceType = breach;
        this.msg(`Fence breach: ${breach} limit`, 'crit');
        if (!this._returningOrLanding()) this.setMode(s.gpsFix ? 'RTL' : 'LAND', 'fence');
      } else if (!breach && this.fs.fence && this.alt < s.fence.maxAlt - 1 && this.distHome < s.fence.radius - 2) {
        this.fs.fence = false;
        this.msg('Fence breach cleared', 'good');
      }
    } else if (!this.armed) {
      this.fs.fence = false;
    }
  }
}
