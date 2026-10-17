// Reference policies for baselines and smoke tests. They read only the observation vector,
// like a learned agent would.
import { Euler, Quaternion } from 'three';
import { clamp } from '../util/math.js';

const _q = new Quaternion();
const _e = new Euler(0, 0, 0, 'YXZ');

export function yawFromObs(obs) {
  _q.set(obs[6], obs[7], obs[8], obs[9]);
  return _e.setFromQuaternion(_q, 'YXZ').y;
}

// Scripted pilot for stick control in LOITER: commands a velocity toward the target and a
// climb rate toward its height (Loiter sticks are velocity commands, throttle is climb rate).
export function gotoPolicy(obs, { maxSpeed = 5, gain = 0.8 } = {}) {
  const [dx, dy, dz] = obs;
  const yaw = yawFromObs(obs);
  const d = Math.hypot(dx, dz);
  const v = Math.min(maxSpeed, d * gain);
  const vx = d > 1e-6 ? (dx / d) * v : 0;
  const vz = d > 1e-6 ? (dz / d) * v : 0;
  const fwd = vx * -Math.sin(yaw) + vz * -Math.cos(yaw);
  const right = vx * Math.cos(yaw) + vz * -Math.sin(yaw);
  const climb = clamp(dy * 0.8, -1.5, 2.5);
  let thr = 0.5;
  if (climb > 0.05) thr = 0.5 + 0.1 + (climb / 2.5) * 0.4;
  else if (climb < -0.05) thr = 0.5 - 0.1 - (-climb / 1.5) * 0.4;
  return [thr * 2 - 1, 0, clamp(fwd / 6, -1, 1), clamp(right / 6, -1, 1)];
}

export function randomPolicy(rng = Math.random) {
  return [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1];
}
