// Uniform grid over static obstacles for fast "what is near the drone" queries.
// Moving obstacles (flagged `dynamic: true`) are always returned.
const CELL = 20;

export class ObstacleIndex {
  constructor(obstacles) {
    this.all = obstacles;
    this.cells = new Map();
    this.dynamic = [];
    this.out = [];
    this.stamp = 0;
    for (const o of obstacles) {
      if (o.dynamic) {
        this.dynamic.push(o);
        continue;
      }
      const [minX, minZ, maxX, maxZ] = bounds(o);
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
        for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
          const k = `${cx},${cz}`;
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(o);
        }
      }
    }
  }

  // Obstacles whose bounds come within `r` of (x, z). Reuses an internal array.
  near(x, z, r) {
    this.stamp++;
    const out = this.out;
    out.length = 0;
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
        const list = this.cells.get(`${cx},${cz}`);
        if (!list) continue;
        for (const o of list) {
          if (o._stamp === this.stamp) continue;
          o._stamp = this.stamp;
          out.push(o);
        }
      }
    }
    for (const o of this.dynamic) out.push(o);
    return out;
  }
}

export function bounds(o) {
  if (o.type === 'cyl') return [o.x - o.r, o.z - o.r, o.x + o.r, o.z + o.r];
  if (o.type === 'seg') return [Math.min(o.ax, o.bx) - o.r, Math.min(o.az, o.bz) - o.r, Math.max(o.ax, o.bx) + o.r, Math.max(o.az, o.bz) + o.r];
  return [o.minX, o.minZ, o.maxX, o.maxZ];
}
