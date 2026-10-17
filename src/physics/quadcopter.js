import { Vector3, Quaternion, Euler } from 'three';
import { G, DEG, clamp } from '../util/math.js';

const RHO = 1.225;
const _up = new Vector3();
const _force = new Vector3();
const _vAir = new Vector3();
const _vH = new Vector3();
const _dq = new Quaternion();
const _level = new Quaternion();
const _euler = new Euler(0, 0, 0, 'YXZ');
const _axisY = new Vector3(0, 1, 0);

// Cheeseman-Bennett in-ground-effect thrust ratio, clamped.
function groundEffect(height, r) {
  const z = Math.max(height, r * 0.6);
  const k = r / (4 * z);
  return clamp(1 / (1 - k * k), 1, 1.2);
}

// Rigid-body quadcopter. Body frame: +X right, +Y up, +Z back (nose points -Z).
// Motor order follows the ArduPilot Quad-X convention.
export class Quadcopter {
  constructor(spec) {
    this.spec = spec;
    const d = spec.armLength / Math.SQRT2;
    this.motors = [
      { pos: new Vector3(d, 0, -d), dir: 1, name: 'M1 front-right (CCW)' },
      { pos: new Vector3(-d, 0, d), dir: 1, name: 'M2 rear-left (CCW)' },
      { pos: new Vector3(-d, 0, -d), dir: -1, name: 'M3 front-left (CW)' },
      { pos: new Vector3(d, 0, d), dir: -1, name: 'M4 rear-right (CW)' },
    ];
    this.cmd = new Float64Array(4);
    this.out = new Float64Array(4);
    this.thrust = new Float64Array(4);
    this.pos = new Vector3();
    this.vel = new Vector3();
    this.accel = new Vector3();
    this.quat = new Quaternion();
    this.omega = new Vector3();
    this.thrustScale = 1;
    this.current = 0;
    this.totalThrust = 0;
    this.contact = true;
    this.crashed = false;
    this.crashReason = '';
    this.lastImpact = 0;
    this.events = [];
  }

  reset(x, z, headingDeg) {
    this.pos.set(x, this.spec.gearHeight, z);
    this.vel.set(0, 0, 0);
    this.accel.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this.quat.setFromAxisAngle(_axisY, -headingDeg * DEG);
    this.cmd.fill(0);
    this.out.fill(0);
    this.thrust.fill(0);
    this.contact = true;
    this.crashed = false;
    this.crashReason = '';
    this.lastImpact = 0;
    this.events.length = 0;
    this.current = 0;
    this.totalThrust = 0;
    this.thrustScale = 1;
  }

  get up() {
    return _up.set(0, 1, 0).applyQuaternion(this.quat);
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    this.events.push({ type: 'crash', reason });
    this.vel.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this.cmd.fill(0);
    // Leave the airframe visibly on its side.
    _euler.setFromQuaternion(this.quat);
    this.quat.setFromEuler(_euler.set(0.15, _euler.y, 1.25, 'YXZ'));
    this.pos.y = (this.groundY || 0) + 0.2;
  }

  step(dt, env) {
    const s = this.spec;
    this.groundY = env.groundHeight;

    // Motor spool dynamics.
    const a = 1 - Math.exp(-dt / s.motorTau);
    const ge = groundEffect(this.pos.y - env.groundHeight, s.propRadius);
    const tmax = s.maxThrustPerMotor * this.thrustScale;
    let total = 0;
    let current = 0;
    for (let i = 0; i < 4; i++) {
      const target = this.crashed ? 0 : this.cmd[i];
      this.out[i] += (target - this.out[i]) * a;
      const t = this.out[i] * tmax;
      this.thrust[i] = t * ge;
      total += this.thrust[i];
      current += s.currentCoeff * Math.pow(t, 1.5);
    }
    this.current = current + s.avionicsCurrent;
    this.totalThrust = total;

    if (this.crashed) {
      this.vel.set(0, 0, 0);
      this.omega.set(0, 0, 0);
      return;
    }

    // Body torques.
    let tx = 0;
    let ty = 0;
    let tz = 0;
    for (let i = 0; i < 4; i++) {
      const m = this.motors[i];
      const t = this.thrust[i];
      tx += -m.pos.z * t;
      tz += m.pos.x * t;
      ty += -m.dir * s.yawTorqueCoeff * t;
    }
    const w = this.omega;
    tx -= s.angularDamping * w.x;
    ty -= s.angularDamping * w.y;
    tz -= s.angularDamping * w.z;
    if (env.torqueNoise && !this.contact) {
      tx += env.torqueNoise.x;
      ty += env.torqueNoise.y;
      tz += env.torqueNoise.z;
    }

    // Euler's rotation equations.
    const Ix = s.inertia.pitch;
    const Iy = s.inertia.yaw;
    const Iz = s.inertia.roll;
    const hx = Ix * w.x;
    const hy = Iy * w.y;
    const hz = Iz * w.z;
    w.x += ((tx - (w.y * hz - w.z * hy)) / Ix) * dt;
    w.y += ((ty - (w.z * hx - w.x * hz)) / Iy) * dt;
    w.z += ((tz - (w.x * hy - w.y * hx)) / Iz) * dt;

    // Orientation from body rates.
    const angle = w.length() * dt;
    if (angle > 1e-9) {
      const sh = Math.sin(angle / 2) / (w.length());
      _dq.set(w.x * sh, w.y * sh, w.z * sh, Math.cos(angle / 2));
      this.quat.multiply(_dq).normalize();
    }

    // Forces (world).
    const up = this.up;
    _force.copy(up).multiplyScalar(total);
    _force.y -= s.mass * G;
    _vAir.copy(this.vel).sub(env.wind);
    const vUp = _vAir.dot(up);
    _vH.copy(_vAir).addScaledVector(up, -vUp);
    const vh = _vH.length();
    _force.addScaledVector(_vH, -(0.5 * RHO * s.cdaHorizontal * vh + s.dragLinear));
    _force.addScaledVector(up, -0.5 * RHO * s.cdaVertical * Math.abs(vUp) * vUp);

    this.accel.copy(_force).divideScalar(s.mass);
    this.vel.addScaledVector(this.accel, dt);
    this.pos.addScaledVector(this.vel, dt);

    this._groundContact(dt, up, total, env);
    if (!this.crashed) this._obstacles(env);
  }

  _groundContact(dt, up, total, env) {
    const s = this.spec;
    const upY = up.y;
    const tiltSin = Math.sqrt(Math.max(0, 1 - upY * upY));
    const contactH = s.gearHeight * Math.max(upY, 0) + s.contactHalfSpan * tiltSin;
    const ground = env.groundHeight;
    const gap = this.pos.y - contactH - ground;
    if (gap > 0) {
      // Small hysteresis so skids resting on uneven tilt do not flicker the contact flag.
      this.contact = this.contact && gap < 0.03 && this.vel.y < 0.3;
      return;
    }
    const vDown = -this.vel.y;
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (!this.contact) {
      if (vDown > 0.05) this.lastImpact = vDown;
      this.events.push({ type: 'touchdown', vz: this.lastImpact, vh: hSpeed });
      if (vDown > s.crashVz) return this.crash(`Hard impact ${vDown.toFixed(1)} m/s`);
      if (hSpeed > s.crashVh) return this.crash(`Ground strike at ${hSpeed.toFixed(1)} m/s`);
      if (upY < Math.cos(55 * DEG)) return this.crash('Struck ground inverted / steeply banked');
    }
    if (upY < Math.cos(50 * DEG)) return this.crash('Tip-over on the ground');
    this.contact = true;
    this.pos.y = ground + contactH;
    if (this.vel.y < 0) this.vel.y = 0;

    // Share of the weight carried by the skids.
    const load = clamp(1 - (total * Math.max(upY, 0)) / (s.mass * G), 0, 1);
    if (load > 0.35 && hSpeed < 0.6) {
      // Static friction: skids hold against wind drag once weight is on them.
      this.vel.x = 0;
      this.vel.z = 0;
    } else {
      const fr = Math.exp(-dt * (1.5 + 12 * load));
      this.vel.x *= fr;
      this.vel.z *= fr;
    }
    if (load > 0.02) {
      _euler.setFromQuaternion(this.quat, 'YXZ');
      _level.setFromAxisAngle(_axisY, _euler.y);
      this.quat.slerp(_level, 1 - Math.exp(-dt * load * 18));
      const k = Math.exp(-dt * load * 30);
      this.omega.x *= k;
      this.omega.z *= k;
      this.omega.y *= Math.exp(-dt * load * 12);
    }
  }

  _obstacles(env) {
    const r = this.spec.collisionRadius;
    const p = this.pos;
    for (const o of env.obstacles) {
      if (o.type === 'cyl') {
        const dx = p.x - o.x;
        const dz = p.z - o.z;
        const rr = o.r + r;
        if (dx * dx + dz * dz < rr * rr && p.y < o.h + r * 0.5) return this.crash(`Collision with ${o.name}`);
      } else if (o.type === 'seg') {
        // Thin capsule (wire): distance from the drone centre to the segment.
        const vx = o.bx - o.ax;
        const vy = o.by - o.ay;
        const vz = o.bz - o.az;
        const l2 = vx * vx + vy * vy + vz * vz;
        let t = l2 > 0 ? ((p.x - o.ax) * vx + (p.y - o.ay) * vy + (p.z - o.az) * vz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = p.x - (o.ax + vx * t);
        const dy = p.y - (o.ay + vy * t);
        const dz = p.z - (o.az + vz * t);
        const rr = o.r + r * 0.8;
        if (dx * dx + dy * dy + dz * dz < rr * rr) return this.crash(`Collision with ${o.name}`);
      } else if (
        p.x > o.minX - r && p.x < o.maxX + r && p.z > o.minZ - r && p.z < o.maxZ + r && p.y < o.h + r * 0.5
      ) {
        return this.crash(`Collision with ${o.name}`);
      }
    }
    return undefined;
  }
}
