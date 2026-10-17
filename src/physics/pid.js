import { clamp } from '../util/math.js';

// PID with integrator limit, integrator hold (anti-windup) and low-pass filtered derivative.
// The integrator accumulates i * error * dt so imax is expressed in output units.
export class PID {
  constructor({ p = 0, i = 0, d = 0, imax = Infinity, dHz = 20 } = {}) {
    this.p = p;
    this.i = i;
    this.d = d;
    this.imax = imax;
    this.dHz = dHz;
    this.reset();
  }

  setGains({ p, i, d, imax }) {
    if (p !== undefined) this.p = p;
    if (i !== undefined) this.i = i;
    if (d !== undefined) this.d = d;
    if (imax !== undefined) this.imax = imax;
  }

  reset(integrator = 0) {
    this.integ = integrator;
    this.dState = 0;
    this.lastErr = 0;
    this.hasLast = false;
    this.pTerm = 0;
    this.dTerm = 0;
  }

  update(err, dt, holdI = false) {
    this.pTerm = this.p * err;
    if (!holdI && this.i > 0) {
      this.integ = clamp(this.integ + this.i * err * dt, -this.imax, this.imax);
    }
    if (this.hasLast && dt > 0) {
      const raw = (err - this.lastErr) / dt;
      const rc = 1 / (2 * Math.PI * this.dHz);
      this.dState += (dt / (dt + rc)) * (raw - this.dState);
    }
    this.lastErr = err;
    this.hasLast = true;
    this.dTerm = this.d * this.dState;
    return this.pTerm + this.integ + this.dTerm;
  }
}
