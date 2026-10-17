// Simulated obstacle-sensing system (stereo vision / ToF style): horizontal beams in the
// four heading-relative directions plus a downward rangefinder. Beams are fanned +/-15 deg.
const FAN = [-15, 0, 15].map((d) => (d * Math.PI) / 180);
export const SENSOR_DIRS = ['front', 'right', 'back', 'left'];

function rayCircle(ox, oz, dx, dz, cx, cz, r, range) {
  const fx = ox - cx;
  const fz = oz - cz;
  const b = fx * dx + fz * dz;
  const c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t <= range ? t : Infinity;
}

function rayBox(ox, oz, dx, dz, o, range) {
  let t0 = 0;
  let t1 = range;
  for (const [p, d, mn, mx] of [[ox, dx, o.minX, o.maxX], [oz, dz, o.minZ, o.maxZ]]) {
    if (Math.abs(d) < 1e-9) {
      if (p < mn || p > mx) return Infinity;
    } else {
      let a = (mn - p) / d;
      let b = (mx - p) / d;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) return Infinity;
    }
  }
  return t0;
}

// Closest approach between the beam segment and a wire segment.
function raySeg(ox, oy, oz, dx, dz, o, range) {
  const ux = dx * range;
  const uz = dz * range;
  const vx = o.bx - o.ax;
  const vy = o.by - o.ay;
  const vz = o.bz - o.az;
  const wx = ox - o.ax;
  const wy = oy - o.ay;
  const wz = oz - o.az;
  const a = ux * ux + uz * uz;
  const b = ux * vx + uz * vz;
  const c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uz * wz;
  const e = vx * wx + vy * wy + vz * wz;
  const den = a * c - b * b;
  let s = den > 1e-9 ? (b * e - c * d) / den : 0;
  s = Math.min(Math.max(s, 0), 1);
  let t = c > 1e-9 ? (b * s + e) / c : 0;
  t = Math.min(Math.max(t, 0), 1);
  s = a > 1e-9 ? Math.min(Math.max((b * t - d) / a, 0), 1) : 0;
  const px = wx + ux * s - vx * t;
  const py = wy - vy * t;
  const pz = wz + uz * s - vz * t;
  const dist = Math.sqrt(px * px + py * py + pz * pz);
  return dist < o.r + 0.6 ? s * range : Infinity;
}

export class ProximitySensors {
  constructor({ range = 20 } = {}) {
    this.range = range;
    this.enabled = true;
    this.dist = { front: Infinity, right: Infinity, back: Infinity, left: Infinity, down: Infinity };
    this.nearest = { dir: '', dist: Infinity, name: '' };
  }

  update(pos, yaw, obstacles, groundHeight, gearHeight) {
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const dirs = { front: [fwdX, fwdZ], right: [rx, rz], back: [-fwdX, -fwdZ], left: [-rx, -rz] };
    this.nearest.dist = Infinity;
    for (const name of SENSOR_DIRS) {
      const [bx, bz] = dirs[name];
      let best = Infinity;
      let bestName = '';
      for (const fan of FAN) {
        const c = Math.cos(fan);
        const s = Math.sin(fan);
        const dx = bx * c - bz * s;
        const dz = bx * s + bz * c;
        for (const o of obstacles) {
          let t = Infinity;
          if (o.type === 'cyl') {
            if (pos.y <= o.h) t = rayCircle(pos.x, pos.z, dx, dz, o.x, o.z, o.r, this.range);
          } else if (o.type === 'box') {
            if (pos.y <= o.h) t = rayBox(pos.x, pos.z, dx, dz, o, this.range);
          } else if (o.type === 'seg') {
            t = raySeg(pos.x, pos.y, pos.z, dx, dz, o, this.range);
          }
          if (t < best) {
            best = t;
            bestName = o.name;
          }
        }
        // Rising terrain ahead: ground higher than the skids.
        const skids = pos.y - gearHeight;
        for (let d = 2; d <= this.range && d < best; d += 2) {
          if (groundHeight(pos.x + dx * d, pos.z + dz * d) > skids + 0.2) {
            best = d;
            bestName = 'terrain';
            break;
          }
        }
      }
      this.dist[name] = best;
      if (best < this.nearest.dist) {
        this.nearest.dist = best;
        this.nearest.dir = name;
        this.nearest.name = bestName;
      }
    }
    // Downward rangefinder: terrain or the top of whatever is directly below.
    let floor = groundHeight(pos.x, pos.z);
    for (const o of obstacles) {
      if (o.h >= pos.y) continue;
      if (o.type === 'box' && pos.x > o.minX && pos.x < o.maxX && pos.z > o.minZ && pos.z < o.maxZ) floor = Math.max(floor, o.h);
      else if (o.type === 'cyl' && (pos.x - o.x) ** 2 + (pos.z - o.z) ** 2 < o.r * o.r) floor = Math.max(floor, o.h);
    }
    this.dist.down = Math.max(pos.y - gearHeight - floor, 0);
    return this.dist;
  }

  // Scale pilot stick inputs so the drone brakes before obstacles (GPS modes only, like
  // consumer obstacle-avoidance systems). Returns true when braking is active.
  brake(rc, brakeDist = 3, slowDist = 9) {
    if (!this.enabled) return false;
    const allow = (d) => Math.min(Math.max((d - brakeDist) / (slowDist - brakeDist), 0), 1);
    let active = false;
    if (rc.pitch > 0) {
      const a = allow(this.dist.front);
      if (a < 1) {
        rc.pitch = Math.min(rc.pitch, a);
        active = true;
      }
    } else if (rc.pitch < 0) {
      const a = allow(this.dist.back);
      if (a < 1) {
        rc.pitch = Math.max(rc.pitch, -a);
        active = true;
      }
    }
    if (rc.roll > 0) {
      const a = allow(this.dist.right);
      if (a < 1) {
        rc.roll = Math.min(rc.roll, a);
        active = true;
      }
    } else if (rc.roll < 0) {
      const a = allow(this.dist.left);
      if (a < 1) {
        rc.roll = Math.max(rc.roll, -a);
        active = true;
      }
    }
    return active;
  }
}
