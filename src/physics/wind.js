import { Vector3 } from 'three';
import { DEG, clamp, gauss } from '../util/math.js';

// Wind = steady mean wind (power-law height profile) + Ornstein-Uhlenbeck turbulence
// + occasional discrete (1 - cos) gusts. Direction follows the meteorological convention
// (direction the wind blows FROM, degrees clockwise from North).
export class WindModel {
  constructor() {
    this.speed = 3;
    this.dirDeg = 270;
    this.gustiness = 0.4;
    this.turbulence = true;
    this.turb = new Vector3();
    this.torque = new Vector3();
    this.gustEvent = null;
    this.gustTimer = 6;
    this.gustNow = 0;
  }

  // Clears turbulence and gust state (for repeatable episodes).
  resetState() {
    this.turb.set(0, 0, 0);
    this.torque.set(0, 0, 0);
    this.gustEvent = null;
    this.gustTimer = 6;
    this.gustNow = 0;
  }

  configure({ speed, dirDeg, gustiness, turbulence }) {
    if (speed !== undefined) this.speed = clamp(speed, 0, 20);
    if (dirDeg !== undefined) this.dirDeg = dirDeg;
    if (gustiness !== undefined) this.gustiness = clamp(gustiness, 0, 1);
    if (turbulence !== undefined) this.turbulence = turbulence;
  }

  get sigma() {
    if (!this.turbulence) return 0;
    return (0.08 + 0.32 * this.gustiness) * Math.max(this.speed, 1.2);
  }

  update(dt) {
    const sigma = this.sigma;
    const tau = 2.5;
    const k = Math.sqrt((2 * dt) / tau);
    this.turb.x += (-this.turb.x / tau) * dt + sigma * k * gauss();
    this.turb.z += (-this.turb.z / tau) * dt + sigma * k * gauss();
    this.turb.y += (-this.turb.y / 1.2) * dt + 0.35 * sigma * Math.sqrt((2 * dt) / 1.2) * gauss();

    // Rotational turbulence felt by the airframe (N·m).
    const ts = 0.0015 + 0.0035 * sigma;
    const tt = 0.35;
    const kt = Math.sqrt((2 * dt) / tt);
    this.torque.x += (-this.torque.x / tt) * dt + ts * kt * gauss();
    this.torque.y += (-this.torque.y / tt) * dt + 0.4 * ts * kt * gauss();
    this.torque.z += (-this.torque.z / tt) * dt + ts * kt * gauss();

    // Discrete gusts along the mean wind direction.
    this.gustNow = 0;
    if (this.turbulence && this.gustiness > 0.05 && this.speed > 0.5) {
      if (!this.gustEvent) {
        this.gustTimer -= dt;
        if (this.gustTimer <= 0) {
          this.gustEvent = {
            t: 0,
            len: 1.5 + Math.random() * 2.5,
            amp: this.speed * this.gustiness * (0.35 + Math.random() * 0.45),
          };
        }
      } else {
        const g = this.gustEvent;
        g.t += dt;
        this.gustNow = (g.amp * (1 - Math.cos((2 * Math.PI * g.t) / g.len))) / 2;
        if (g.t >= g.len) {
          this.gustEvent = null;
          this.gustTimer = 4 + Math.random() * 10 * (1.2 - this.gustiness);
        }
      }
    }
  }

  // Unit vector the mean wind blows TOWARD.
  direction(out) {
    const a = this.dirDeg * DEG;
    return out.set(-Math.sin(a), 0, Math.cos(a));
  }

  heightFactor(h) {
    return clamp(Math.pow(Math.max(h, 0.3) / 10, 1 / 7), 0.45, 1.3);
  }

  sample(pos, out) {
    const hf = this.heightFactor(pos.y);
    this.direction(out).multiplyScalar((this.speed + this.gustNow) * hf);
    out.x += this.turb.x * hf;
    out.z += this.turb.z * hf;
    out.y += this.turb.y * clamp(pos.y / 5, 0, 1);
    return out;
  }
}
