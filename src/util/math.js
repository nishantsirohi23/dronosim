// Shared math helpers.
// World frame (three.js): +X = East, +Y = Up, -Z = North.
// Heading is degrees clockwise from North; three.js yaw (rotation about +Y) is counter-clockwise.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const G = 9.80665;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function wrapPi(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

export function wrap360(d) {
  d %= 360;
  return d < 0 ? d + 360 : d;
}

// Classic RC expo: e = 0 is linear, e = 1 is fully cubic.
export const expo = (x, e) => (1 - e) * x + e * x * x * x;

export function deadband(x, d) {
  if (Math.abs(x) <= d) return 0;
  return (x - Math.sign(x) * d) / (1 - d);
}

// Frame-rate independent exponential smoothing factor.
export const smoothing = (rate, dt) => 1 - Math.exp(-rate * dt);

export const headingFromYaw = (yaw) => wrap360(-yaw * RAD);
export const yawFromHeading = (hdg) => wrapPi(-hdg * DEG);

// Bearing (deg clockwise from North) of a displacement in the XZ plane.
export const bearingDeg = (dx, dz) => wrap360(Math.atan2(dx, -dz) * RAD);

// Deterministic PRNG for scenery placement.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let spareGauss = null;
// Clears the cached second Gaussian sample so seeded runs are exactly repeatable.
export function resetGauss() {
  spareGauss = null;
}

export function gauss() {
  if (spareGauss !== null) {
    const s = spareGauss;
    spareGauss = null;
    return s;
  }
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const m = Math.sqrt(-2 * Math.log(u));
  spareGauss = m * Math.sin(2 * Math.PI * v);
  return m * Math.cos(2 * Math.PI * v);
}

export function compassPoint(deg) {
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round(wrap360(deg) / 22.5) % 16];
}

export function formatDuration(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function timestampForFile(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
