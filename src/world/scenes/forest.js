// Forest Hills: temperate / Himalayan-foothill mixed forest.
//
// Rolling fbm hills around a flat ranger clearing, a meandering river ~80-150 m north with a
// wooden footbridge, a dirt trail from the clearing over the bridge to a fire lookout tower on a
// hilltop, a wooden-pole power line crossing the river valley to the east, and a missing-person
// search target (with a tent and a campfire) in a small forest gap 170-280 m from home.
//
// Terrain: one indexed grid mesh with a uniform high-resolution core (x +-480 m, z +-360 m) and
// geometrically growing spacing out to +-2000 m, so there is no seam and no visible edge.
// groundHeight() interpolates the very same Float32 vertex heights with the same triangle split
// as the mesh, so the drone always rests on the drawn surface. It is exactly 0 within 18 m of
// the origin (the spec requires 8 m).

import {
  BoxGeometry, BufferAttribute, BufferGeometry, CatmullRomCurve3, Color, ConeGeometry, CylinderGeometry, Euler,
  ExtrudeGeometry, Float32BufferAttribute, Group, IcosahedronGeometry, Matrix4, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, PointLight, Quaternion, Shape, Vector3,
} from 'three';
import {
  HEAT, barkTexture, bushes, canvasTexture, car, disposeTree, homePad, instanced, lambert, makeNoise2D, mulberry32,
  flat, paintPolyline, person, pilotPost, powerLine, rocks, smoothstep, speckle, standard, tagHeat, trees, windsock,
} from './common.js';
import { clamp } from '../../util/math.js';

const TERRAIN_SEED = 7301;
const FLAT_R = 18; // ground is exactly 0 inside this radius
const BLEND_R = 46; // clearing has blended into the hills by this radius
const WATER_Y = -1.6;
const RIVER_Z = -115;
const HILL_X = -64; // lookout hill summit (smooth-max with the noise hills)
const HILL_Z = -218;
const TERRAIN_HALF = 2000;
const MAP_HALF = 420;
const MAX_OBSTACLES = 2450;
const CABIN = { x: -22, z: 18 };
const PILOT = { x: 0, z: 14 };

const Q = {
  low: { step: 7, trees: 1200, treeScale: 1.15, place: 290, bushes: 450, rocks: 160, boulders: 10, logs: 14 },
  medium: { step: 5, trees: 2500, treeScale: 1.07, place: 380, bushes: 950, rocks: 300, boulders: 16, logs: 24 },
  high: { step: 3.5, trees: 4500, treeScale: 1, place: 440, bushes: 1700, rocks: 520, boulders: 22, logs: 36 },
};

// Dirt access track from the clearing to the south-west (the ranger 4x4 came in on it).
const ROAD_CTRL = [[-9, 33], [-20, 52], [-28, 85], [-22, 125], [-48, 175], [-62, 240], [-105, 320], [-140, 420], [-152, 540], [-185, 680]];

const lerp = (a, b, t) => a + (b - a) * t;
const smax = (a, b, k) => 0.5 * (a + b + Math.sqrt((a - b) * (a - b) + k));

// ---------------------------------------------------------------- analytic terrain

// Pure height field (no three.js objects); exported so it can be unit-checked in Node.
export function forestTerrain(seed = TERRAIN_SEED) {
  const A = makeNoise2D(seed);
  const B = makeNoise2D(seed + 101);
  const meander = (x) => 1 - smoothstep(380, 470, Math.abs(x));
  const riverZ = (x) => {
    const m = meander(x);
    return m > 0 ? RIVER_Z + m * (24 * Math.sin(x / 88 + 0.6) + 11 * Math.sin(x / 37 + 1.9)) : RIVER_Z;
  };
  // Half-width of the channel (water is ~6 m either side of the centre line).
  const riverHW = (x) => 7.5 + 1.8 * A.noise(x / 55 + 0.5, 4.2) * meander(x);
  // Approximate perpendicular distance to the river centre line.
  const riverDist = (x, z) => {
    const sl = riverZ(x + 0.5) - riverZ(x - 0.5);
    return Math.abs(z - riverZ(x)) / Math.sqrt(1 + sl * sl);
  };
  const forestRaw = (x, z) => smoothstep(-0.07, 0.07, A.fbm(x * 0.0062 + 40.3, z * 0.0062 - 17.9, 3) + 0.05);

  function height(x, z) {
    const r2 = x * x + z * z;
    if (r2 < FLAT_R * FLAT_R) return 0;
    const r = Math.sqrt(r2);
    const f = A.fbm(x * 0.004 + 13.7, z * 0.004 - 5.3, 5);
    const rd = Math.max(0, 1 - Math.abs(B.noise(x * 0.0026 + 2.1, z * 0.0026 + 7.7)) * 2.6);
    let h = 46 * f + 13 * rd * rd + 6;
    const hx = x - HILL_X;
    const hz = z - HILL_Z;
    h = smax(h, 40 * Math.exp(-(hx * hx + hz * hz) / (2 * 45 * 45)), 16); // lookout hill summit
    h = smax(h, -0.4, 6); // flat valley floors instead of pits
    h *= 0.3 + 0.7 * smoothstep(40, 260, r); // gentle near home, full hills further out
    if (r > 650) h += smoothstep(650, 1500, r) * (55 + 110 * B.fbm(x * 0.0011 + 5.1, z * 0.0011 - 9.4, 4));
    // River valley and channel.
    const hw = riverHW(x);
    const d = riverDist(x, z);
    const vw = 70 + 0.22 * Math.max(0, Math.abs(x) - 300);
    if (d < hw + 3 + vw) {
      const bank = 0.35 + 0.3 * A.noise(x * 0.03 + 7.1, z * 0.03 - 3.3);
      h = bank + (h - bank) * smoothstep(hw + 3, hw + 3 + vw, d);
      if (d < hw + 6) {
        const ch = -3 + (bank + 3) * smoothstep(hw * 0.25, hw + 4, d);
        h = ch + (h - ch) * smoothstep(hw + 2, hw + 6, d);
      }
    }
    return h * smoothstep(FLAT_R, BLEND_R, r);
  }

  return { height, riverZ, riverHW, riverDist, forestRaw, noise: A.noise };
}

// ---------------------------------------------------------------- height grid (mesh-exact lookup)

function axis(fineHalf, step, outerHalf) {
  const n = Math.max(1, Math.round(fineHalf / step));
  const half = n * step;
  const outer = [];
  let v = half;
  let s = step;
  while (v < outerHalf) {
    s = Math.min(s * 1.1, 150);
    v += s;
    outer.push(v);
  }
  const c = new Float64Array(outer.length * 2 + 2 * n + 1);
  let k = 0;
  for (let i = outer.length - 1; i >= 0; i--) c[k++] = -outer[i];
  const i0 = k;
  for (let i = -n; i <= n; i++) c[k++] = i * step;
  for (let i = 0; i < outer.length; i++) c[k++] = outer[i];
  return { c, i0, n2: 2 * n, half, step };
}

function cellOf(ax, v) {
  if (v >= -ax.half && v < ax.half) {
    const k = Math.floor((v + ax.half) / ax.step);
    return ax.i0 + (k < ax.n2 ? k : ax.n2 - 1);
  }
  const c = ax.c;
  let lo = 0;
  let hi = c.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid] <= v) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function forestHeightGrid(T, step) {
  const X = axis(480, step, TERRAIN_HALF);
  const Z = axis(360, step, TERRAIN_HALF);
  const xs = X.c;
  const zs = Z.c;
  const NX = xs.length;
  const NZ = zs.length;
  const hts = new Float32Array(NX * NZ);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) hts[j * NX + i] = T.height(xs[i], zs[j]);
  const minX = xs[0];
  const maxX = xs[NX - 1];
  const minZ = zs[0];
  const maxZ = zs[NZ - 1];
  // Same triangles as the mesh: cell (a, b = +x, c = +z, d = +x+z) split along b-c.
  function groundHeight(x, z) {
    if (x * x + z * z < 64) return 0;
    if (!(x > minX && x < maxX && z > minZ && z < maxZ)) return x === x && z === z ? T.height(x, z) : 0;
    const i = cellOf(X, x);
    const j = cellOf(Z, z);
    const u = clamp((x - xs[i]) / (xs[i + 1] - xs[i]), 0, 1);
    const v = clamp((z - zs[j]) / (zs[j + 1] - zs[j]), 0, 1);
    const k = j * NX + i;
    const ha = hts[k];
    const hb = hts[k + 1];
    const hc = hts[k + NX];
    const hd = hts[k + NX + 1];
    if (u + v <= 1) return ha + u * (hb - ha) + v * (hc - ha);
    return hd + (1 - u) * (hc - hd) + (1 - v) * (hb - hd);
  }
  return { xs, zs, NX, NZ, hts, groundHeight };
}

// ---------------------------------------------------------------- small geometry helpers

const _m4 = new Matrix4();
const _q4 = new Quaternion();
const _e4 = new Euler();
const _v4 = new Vector3();
const _s4 = new Vector3(1, 1, 1);
const _yUp = new Vector3(0, 1, 0);
const _dir = new Vector3();
const _w = new Vector3();

// Non-indexed copy of geo, rotated (XYZ euler) and translated.
function placed(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  _m4.compose(_v4.set(x, y, z), _q4.setFromEuler(_e4.set(rx, ry, rz)), _s4.set(1, 1, 1));
  return g.applyMatrix4(_m4);
}

// Thin cylinder between two points.
function beam(ax, ay, az, bx, by, bz, r, seg = 5) {
  _dir.set(bx - ax, by - ay, bz - az);
  const len = _dir.length() || 0.001;
  const g = new CylinderGeometry(r, r, len, seg, 1, true).toNonIndexed();
  _q4.setFromUnitVectors(_yUp, _dir.normalize());
  _m4.compose(_v4.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q4, _s4.set(1, 1, 1));
  return g.applyMatrix4(_m4);
}

// Box with UVs in metres / tile on every face (for tiling wall textures).
function metricBox(w, h, d, tile = 1) {
  const g = new BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const sc = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (uv.getX(i) * sc[f][0]) / tile, (uv.getY(i) * sc[f][1]) / tile);
    }
  }
  return g;
}

// Concatenate non-indexed geometries (position, normal, uv).
function mergeGeos(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  let o = 0;
  for (const g0 of list) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    const c = g.attributes.position.count;
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.set(g.attributes.position.array.subarray(0, c * 3), o * 3);
    nor.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array.subarray(0, c * 2), o * 2);
    o += c;
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setAttribute('normal', new BufferAttribute(nor, 3));
  out.setAttribute('uv', new BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

function meshFrom(list, mat, heat, cast = true) {
  const m = new Mesh(mergeGeos(list), mat);
  m.castShadow = cast;
  m.receiveShadow = true;
  if (heat !== undefined) m.userData.heat = heat;
  return m;
}

// Bake an object's meshes into one mesh per material (fewer draw calls). Lights and
// instanced meshes are carried over unchanged. Materials are reused, so references kept by
// helpers (e.g. homePad().setNight) keep working.
function mergeByMaterial(obj) {
  obj.updateMatrixWorld(true);
  const buckets = new Map();
  const keep = [];
  obj.traverse((o) => {
    if (o === obj && !o.isMesh) return;
    if (o.isMesh && !o.isInstancedMesh && !Array.isArray(o.material)) {
      let b = buckets.get(o.material);
      if (!b) {
        b = { geos: [], cast: false, recv: false, heat: undefined };
        buckets.set(o.material, b);
      }
      const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrixWorld);
      b.geos.push(g);
      b.cast = b.cast || o.castShadow;
      b.recv = b.recv || o.receiveShadow;
      if (b.heat === undefined && o.userData.heat !== undefined) b.heat = o.userData.heat;
    } else if (o.isLight || o.isMesh) {
      keep.push(o);
    }
  });
  const out = new Group();
  for (const [mat, b] of buckets) {
    const m = new Mesh(mergeGeos(b.geos), mat);
    m.castShadow = b.cast;
    m.receiveShadow = b.recv;
    if (b.heat !== undefined) m.userData.heat = b.heat;
    out.add(m);
  }
  for (const o of keep) {
    o.matrixWorld.decompose(o.position, o.quaternion, o.scale);
    out.add(o);
  }
  return out;
}

// Set position and a small pitch/roll so a vehicle-like object sits on sloping ground.
// Local +Z is forward, +X is right.
function settle(obj, x, z, yaw, halfL, halfW, gh) {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  const hF = gh(x + s * halfL, z + c * halfL);
  const hB = gh(x - s * halfL, z - c * halfL);
  const hR = gh(x + c * halfW, z - s * halfW);
  const hL = gh(x - c * halfW, z + s * halfW);
  obj.position.set(x, (hF + hB + hR + hL) / 4, z);
  obj.rotation.set(-Math.atan2(hF - hB, 2 * halfL), yaw, Math.atan2(hR - hL, 2 * halfW), 'YXZ');
  return obj.position.y;
}

// Spatial hash of 2D points for "is anything within r" queries (r <= cell).
class PointIndex {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }

  static key(ix, iz) {
    return (ix + 32768) * 65536 + (iz + 32768);
  }

  add(x, z) {
    const k = PointIndex.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let a = this.map.get(k);
    if (!a) {
      a = [];
      this.map.set(k, a);
    }
    a.push(x, z);
  }

  near(x, z, r) {
    const ix = Math.floor(x / this.cell);
    const iz = Math.floor(z / this.cell);
    const r2 = r * r;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const a = this.map.get(PointIndex.key(ix + dx, iz + dz));
        if (!a) continue;
        for (let k = 0; k < a.length; k += 2) {
          const ex = a[k] - x;
          const ez = a[k + 1] - z;
          if (ex * ex + ez * ez < r2) return true;
        }
      }
    }
    return false;
  }
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

function polylineDist(pts, x, z) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(x, z, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z));
  return d;
}

// Smooth curve through 2D control points, resampled every `spacing` metres.
function sampleCurve(ctrl, spacing) {
  const curve = new CatmullRomCurve3(ctrl.map(([x, z]) => new Vector3(x, 0, z)), false, 'centripetal');
  const n = Math.max(2, Math.ceil(curve.getLength() / spacing));
  return curve.getSpacedPoints(n).map((p) => [p.x, p.z]);
}

// Control points from a to b with sideways wiggles.
function wiggle(a, b, n, amp, freq) {
  const pts = [a];
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const L = Math.hypot(dx, dz) || 1;
  const px = -dz / L;
  const pz = dx / L;
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const o = amp * Math.sin(t * Math.PI * freq);
    pts.push([a[0] + dx * t + px * o, a[1] + dz * t + pz * o]);
  }
  pts.push(b);
  return pts;
}

// Ground-hugging strip along a dense polyline; appends to the arrays.
function ribbonInto(pts, width, gh, yOff, vScale, out) {
  const base = out.pos.length / 3;
  const half = width / 2;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i];
    const p = pts[Math.max(i - 1, 0)];
    const q = pts[Math.min(i + 1, pts.length - 1)];
    const tx = q[0] - p[0];
    const tz = q[1] - p[1];
    const tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl;
    const nz = tx / tl;
    if (i) s += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
    const lx = x + nx * half;
    const lz = z + nz * half;
    const rx = x - nx * half;
    const rz = z - nz * half;
    out.pos.push(lx, gh(lx, lz) + yOff, lz, rx, gh(rx, rz) + yOff, rz);
    out.uv.push(0, s / vScale, 1, s / vScale);
    if (i) {
      const a = base + (i - 1) * 2;
      out.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
}

function geometryFrom({ pos, uv, idx }) {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- textures

function detailTexture() {
  const rnd = mulberry32(31);
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#efefef';
    g.fillRect(0, 0, w, h);
    speckle(g, w, h, rnd, ['rgba(0,0,0,0.10)', 'rgba(0,0,0,0.18)', 'rgba(255,255,255,0.3)', 'rgba(70,55,30,0.16)'], 9000, 1.7);
  }, { repeat: [1, 1] });
}

function logTexture() {
  const rnd = mulberry32(32);
  return canvasTexture(128, 128, (g, w, h) => {
    for (let i = 0; i < 4; i++) {
      const y0 = i * 32;
      const grd = g.createLinearGradient(0, y0, 0, y0 + 32);
      grd.addColorStop(0, '#8d6743');
      grd.addColorStop(0.45, '#a77d55');
      grd.addColorStop(1, '#5c3f27');
      g.fillStyle = grd;
      g.fillRect(0, y0, w, 32);
      g.fillStyle = '#2b1d12';
      g.fillRect(0, y0 + 30, w, 2);
    }
    speckle(g, w, h, rnd, ['rgba(40,25,10,0.25)', 'rgba(255,230,200,0.08)'], 900, 1.2);
  }, { repeat: [1, 1] });
}

function waterTexture() {
  const rnd = mulberry32(33);
  return canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = '#e4ecef';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(120,150,165,0.18)';
      g.beginPath();
      g.ellipse(rnd() * w, rnd() * h, 8 + rnd() * 30, 0.8 + rnd() * 1.6, 0, 0, Math.PI * 2);
      g.fill();
    }
  }, { repeat: [1, 1] });
}

function trailTexture() {
  const rnd = mulberry32(34);
  return canvasTexture(128, 256, (g, w, h) => {
    g.fillStyle = '#8a6c4c';
    g.fillRect(0, 0, w, h);
    speckle(g, w, h, rnd, ['rgba(0,0,0,0.16)', 'rgba(255,240,220,0.10)', 'rgba(60,40,20,0.22)', 'rgba(110,120,70,0.25)'], 4000, 1.6);
    // Grassy fringe on both edges.
    const grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, 'rgba(92,120,60,0.85)');
    grd.addColorStop(0.18, 'rgba(92,120,60,0)');
    grd.addColorStop(0.82, 'rgba(92,120,60,0)');
    grd.addColorStop(1, 'rgba(92,120,60,0.85)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  }, { repeat: [1, 1] });
}

// ---------------------------------------------------------------- terrain mesh

const PAL = {
  meadow: new Color(0x7aa64c),
  dry: new Color(0x9aa85a),
  floor: new Color(0x4a5e31),
  canopy: new Color(0x31482a),
  clearing: new Color(0x8ab45a),
  rock: new Color(0x8e897e),
  alpine: new Color(0x838a7c),
  sand: new Color(0xbba97c),
  bed: new Color(0x5f5544),
};

function terrainMesh(grid, T, floorMask, forestR) {
  const { xs, zs, NX, NZ, hts } = grid;
  const n = NX * NZ;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const col = new Float32Array(n * 3);
  const c = new Color();
  for (let j = 0; j < NZ; j++) {
    const jl = j > 0 ? j - 1 : j;
    const jr = j < NZ - 1 ? j + 1 : j;
    for (let i = 0; i < NX; i++) {
      const k = j * NX + i;
      const x = xs[i];
      const z = zs[j];
      const y = hts[k];
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      uv[k * 2] = x / 7;
      uv[k * 2 + 1] = z / 7;
      const il = i > 0 ? i - 1 : i;
      const ir = i < NX - 1 ? i + 1 : i;
      const sx = (hts[j * NX + ir] - hts[j * NX + il]) / (xs[ir] - xs[il]);
      const sz = (hts[jr * NX + i] - hts[jl * NX + i]) / (zs[jr] - zs[jl]);
      const slope = Math.hypot(sx, sz);
      const r = Math.hypot(x, z);
      const mask = r < 1100 ? floorMask(x, z) : 0.8;
      const nv = clamp(0.5 + T.noise(x * 0.021 + 3.3, z * 0.021 - 1.7) * 0.8, 0, 1);
      c.copy(PAL.meadow).lerp(PAL.dry, nv * 0.7);
      c.lerp(PAL.floor, mask * 0.85);
      const far = smoothstep(forestR * 0.85, forestR * 1.7, r);
      if (far > 0) c.lerp(PAL.canopy, far * (0.45 + 0.55 * mask));
      const cl = 1 - smoothstep(30, 48, r);
      if (cl > 0) c.lerp(PAL.clearing, cl);
      const rk = smoothstep(0.5, 0.95, slope);
      if (rk > 0) c.lerp(PAL.rock, rk * 0.85);
      const alp = smoothstep(80, 140, y);
      if (alp > 0) c.lerp(PAL.alpine, alp * 0.8);
      const d = T.riverDist(x, z);
      const hw = T.riverHW(x);
      if (d < hw + 8) {
        c.lerp(PAL.sand, 1 - smoothstep(hw + 1.5, hw + 7, d));
        c.lerp(PAL.bed, 1 - smoothstep(-2.1, -1.2, y));
      }
      col[k * 3] = c.r;
      col[k * 3 + 1] = c.g;
      col[k * 3 + 2] = c.b;
    }
  }
  const idx = new Uint32Array((NX - 1) * (NZ - 1) * 6);
  let o = 0;
  for (let j = 0; j < NZ - 1; j++) {
    for (let i = 0; i < NX - 1; i++) {
      const a = j * NX + i;
      const b = a + 1;
      const cc = a + NX;
      const d = cc + 1;
      idx[o++] = a;
      idx[o++] = cc;
      idx[o++] = b;
      idx[o++] = b;
      idx[o++] = cc;
      idx[o++] = d;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const mesh = new Mesh(g, new MeshLambertMaterial({ color: 0xffffff, vertexColors: true, map: detailTexture() }));
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return tagHeat(mesh, HEAT.ground);
}

// River surface: a ribbon along the centre line, edges tucked under the banks.
function riverMesh(T) {
  const pos = [];
  const uv = [];
  const idx = [];
  let s = 0;
  let px = null;
  let pz = 0;
  let n = 0;
  for (let x = -TERRAIN_HALF; x <= TERRAIN_HALF;) {
    const zc = T.riverZ(x);
    const sl = T.riverZ(x + 0.5) - T.riverZ(x - 0.5);
    const L = Math.hypot(1, sl);
    const nx = -sl / L;
    const nz = 1 / L;
    const w = T.riverHW(x) + 2.6;
    if (px !== null) s += Math.hypot(x - px, zc - pz);
    px = x;
    pz = zc;
    pos.push(x + nx * w, WATER_Y, zc + nz * w, x - nx * w, WATER_Y, zc - nz * w);
    uv.push(s / 24, 1, s / 24, 0);
    if (n) {
      const a = (n - 1) * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    n++;
    x += Math.abs(x) < 520 ? 3 : 24;
  }
  const tex = waterTexture();
  const mat = standard(0x55879a, { roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.86, map: tex });
  const m = new Mesh(geometryFrom({ pos, uv, idx }), mat);
  m.receiveShadow = true;
  m.name = 'river';
  return { mesh: tagHeat(m, HEAT.water), tex };
}

// ---------------------------------------------------------------- layout

function pickBridge(T) {
  let best = null;
  for (let x = -36; x <= 24; x += 1) {
    const sl = Math.abs(T.riverZ(x + 0.5) - T.riverZ(x - 0.5));
    if (!best || sl < best.sl) best = { x, sl };
  }
  const hw = T.riverHW(best.x);
  return { x: best.x, z: T.riverZ(best.x), hw, half: hw + 6 };
}

function pickHilltop(T, gh) {
  let best = null;
  for (let x = HILL_X - 50; x <= HILL_X + 50; x += 2) {
    for (let z = HILL_Z - 50; z <= HILL_Z + 50; z += 2) {
      const r = Math.hypot(x, z);
      if (r < 150 || r > 250 || T.riverDist(x, z) < T.riverHW(x) + 45) continue;
      const h = gh(x, z);
      if (!best || h > best.h) best = { x, z, h };
    }
  }
  return best || { x: HILL_X, z: HILL_Z, h: gh(HILL_X, HILL_Z) };
}

function trailPaths(bridge, tower) {
  const sEnd = [bridge.x, bridge.z + bridge.half + 0.4];
  const sApp = [bridge.x, bridge.z + bridge.half + 11];
  const south = sampleCurve([...wiggle([2, -15], sApp, 3, 9, 3), sEnd], 1.25);
  const nStart = [bridge.x, bridge.z - bridge.half - 0.4];
  const nApp = [bridge.x, bridge.z - bridge.half - 11];
  const north = sampleCurve([nStart, ...wiggle(nApp, [tower.x + 4, tower.z + 9], 3, 10, 2)], 1.25);
  return { south, north };
}

// Wooden pole line running roughly north-south ~100 m east of home, across the river valley.
function linePoles(T, gh) {
  const lx = (z) => 100 + 14 * Math.sin(z / 160 + 0.7);
  const inRiver = (x, z) => T.riverDist(x, z) < T.riverHW(x) + 14;
  const clear = (a, b) => {
    const ya = gh(a.x, a.z) + 11.75;
    const yb = gh(b.x, b.z) + 11.75;
    const sag = 0.6 + Math.hypot(b.x - a.x, b.z - a.z) * 0.012;
    for (let k = 1; k < 12; k++) {
      const t = k / 12;
      const x = lerp(a.x, b.x, t);
      const z = lerp(a.z, b.z, t);
      if (lerp(ya, yb, t) - sag * 4 * t * (1 - t) - gh(x, z) < 6) return false;
    }
    return true;
  };
  const poles = [{ x: lx(330), z: 330 }];
  let z = 330;
  while (z > -540) {
    const prev = poles[poles.length - 1];
    let next = null;
    for (const L of [64, 56, 48, 40, 32, 26]) {
      const p = { x: lx(z - L), z: z - L };
      if (!inRiver(p.x, p.z) && clear(prev, p)) {
        next = p;
        break;
      }
    }
    if (!next) {
      for (const L of [26, 20, 34, 44]) {
        const p = { x: lx(z - L), z: z - L };
        if (!inRiver(p.x, p.z)) {
          next = p;
          break;
        }
      }
    }
    if (!next) next = { x: lx(z - 50), z: z - 50 };
    poles.push(next);
    z = next.z;
  }
  return poles;
}

// The search target: a camp in a forest gap 170-280 m from home. Placement varies with ctx.seed.
function chooseCamp(seed, T, gh, avoid) {
  const rnd = mulberry32((Math.imul(seed | 0, 2654435761) ^ 0x9e37) >>> 0);
  const slope = (x, z) => Math.hypot(gh(x + 3, z) - gh(x - 3, z), gh(x, z + 3) - gh(x, z - 3)) / 6;
  for (let i = 0; i < 600; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 170 + rnd() * 110;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (T.riverDist(x, z) < T.riverHW(x) + 35) continue;
    if (avoid(x, z)) continue;
    if (slope(x, z) > 0.22) continue;
    if (i < 450 && T.forestRaw(x, z) < 0.6) continue;
    return { x, z };
  }
  return { x: -180, z: 150 };
}

// ---------------------------------------------------------------- structures

function rangerCabin(obstacles, cx, cz, gh) {
  const W = 7; // x
  const D = 10; // z
  const WH = 2.9;
  const PORCH = 2.3;
  let gmin = Infinity;
  let gmax = -Infinity;
  for (const fx of [-W / 2, 0, W / 2, W / 2 + PORCH]) {
    for (const fz of [-D / 2, 0, D / 2]) {
      const h = gh(cx + fx, cz + fz);
      gmin = Math.min(gmin, h);
      gmax = Math.max(gmax, h);
    }
  }
  const floorY = gmax + 0.25;
  const logMat = lambert(0xffffff, { map: logTexture() });
  const roofMat = lambert(0x3e5b3d);
  const stoneMat = lambert(0x8d877c);
  const woodMat = lambert(0x4b3624);
  const glassMat = new MeshLambertMaterial({ color: 0x2b3036, emissive: new Color(0xffb35c), emissiveIntensity: 0.03 });
  const lanternMat = new MeshLambertMaterial({ color: 0x40382a, emissive: new Color(0xffc070), emissiveIntensity: 0.2 });

  const plinthH = floorY - gmin + 0.5;
  const stone = [
    placed(new BoxGeometry(W + PORCH + 0.2, plinthH, D + 0.2), PORCH / 2, -plinthH / 2, 0),
    placed(new BoxGeometry(0.9, 3.2, 0.9), -1.7, WH + 1.0, -3.0),
  ];
  const gable = new Shape();
  gable.moveTo(-W / 2, 0);
  gable.lineTo(W / 2, 0);
  gable.lineTo(0, 2.1);
  gable.closePath();
  const gableGeo = new ExtrudeGeometry(gable, { depth: D, bevelEnabled: false });
  const guv = gableGeo.attributes.uv;
  for (let i = 0; i < guv.count; i++) guv.setXY(i, guv.getX(i) / 1.2, guv.getY(i) / 1.2);
  const logs = [placed(metricBox(W, WH, D, 1.2), 0, WH / 2, 0), placed(gableGeo, 0, WH, -D / 2)];
  const slope = Math.atan(0.6);
  const slabW = Math.hypot(4.1, 2.46);
  const roof = [
    placed(new BoxGeometry(slabW, 0.16, D + 1), 2.05, WH + 0.87 + 0.08, 0, 0, 0, -slope),
    placed(new BoxGeometry(slabW, 0.16, D + 1), -2.05, WH + 0.87 + 0.08, 0, 0, 0, slope),
    placed(new BoxGeometry(Math.hypot(2.3, 0.65), 0.12, 8.6), W / 2 + 1.15, WH - 0.625, 0, 0, 0, -Math.atan(0.65 / 2.3)),
  ];
  const wood = [
    placed(new BoxGeometry(PORCH, 0.12, 8.6), W / 2 + PORCH / 2, 0.06, 0),
    placed(new BoxGeometry(0.06, 2.0, 1.0), W / 2 + 0.03, 1.0, 1.2),
  ];
  for (const pz of [-3.6, 0, 3.6]) wood.push(placed(new BoxGeometry(0.18, WH - 0.9, 0.18), W / 2 + 2.1, (WH - 0.9) / 2, pz));
  const glass = [];
  const windowAt = (x, z, alongX) => {
    glass.push(placed(alongX ? new BoxGeometry(1.3, 0.95, 0.05) : new BoxGeometry(0.05, 0.95, 1.3), x, 1.55, z));
    const fx = alongX ? 0 : Math.sign(x) * -0.01;
    const fz = alongX ? Math.sign(z) * -0.01 : 0;
    wood.push(placed(alongX ? new BoxGeometry(1.5, 1.15, 0.04) : new BoxGeometry(0.04, 1.15, 1.5), x + fx, 1.55, z + fz));
  };
  windowAt(W / 2 + 0.035, -2.4, false);
  windowAt(W / 2 + 0.035, 3.4, false);
  windowAt(-W / 2 - 0.035, -2, false);
  windowAt(-W / 2 - 0.035, 2, false);
  windowAt(-1.3, -D / 2 - 0.035, true);
  windowAt(1.3, D / 2 + 0.035, true);
  const g = new Group();
  g.add(meshFrom(stone, stoneMat, HEAT.ground + 0.05));
  g.add(meshFrom(logs, logMat, HEAT.building));
  g.add(meshFrom(roof, roofMat, HEAT.roof));
  g.add(meshFrom(wood, woodMat, HEAT.building));
  g.add(meshFrom(glass, glassMat, HEAT.building + 0.12, false));
  g.add(meshFrom([placed(new BoxGeometry(0.18, 0.28, 0.18), W / 2 + 0.12, 2.25, 0.35)], lanternMat, HEAT.light, false));
  g.position.set(cx, floorY, cz);
  obstacles.push({ type: 'box', name: 'ranger cabin', minX: cx - W / 2 - 0.6, maxX: cx + W / 2 + 0.6, minZ: cz - D / 2 - 0.5, maxZ: cz + D / 2 + 0.5, h: floorY + WH + 2.6 });
  obstacles.push({ type: 'box', name: 'cabin porch', minX: cx + W / 2 + 0.6, maxX: cx + W / 2 + PORCH + 0.2, minZ: cz - 4.3, maxZ: cz + 4.3, h: floorY + WH - 0.3 });
  return { group: g, glassMat, lanternMat };
}

function rangerVehicle(obstacles, x, z, yaw, gh) {
  const v = car(0x3b5733, { seed: 4 });
  const rackMat = lambert(0x1d1f22);
  const rack = new Mesh(new BoxGeometry(1.5, 0.12, 1.9), rackMat);
  rack.position.set(0, 1.62, -0.2);
  v.add(rack);
  const spare = new Mesh(new CylinderGeometry(0.36, 0.36, 0.24, 12).rotateX(Math.PI / 2), rackMat);
  spare.position.set(0, 0.8, -2.2);
  v.add(spare);
  const bar = new Mesh(new BoxGeometry(1.7, 0.6, 0.08), rackMat);
  bar.position.set(0, 0.55, 2.13);
  v.add(bar);
  for (const m of [rack, spare, bar]) m.userData.heat = HEAT.vehicle;
  v.scale.setScalar(1.1);
  const y = settle(v, x, z, yaw, 2.2, 0.95, gh);
  const merged = mergeByMaterial(v);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [lx, lz] of [[-1.05, -2.5], [1.05, -2.5], [-1.05, 2.5], [1.05, 2.5]]) {
    const wx = x + lx * c + lz * s;
    const wz = z - lx * s + lz * c;
    minX = Math.min(minX, wx);
    maxX = Math.max(maxX, wx);
    minZ = Math.min(minZ, wz);
    maxZ = Math.max(maxZ, wz);
  }
  obstacles.push({ type: 'box', name: 'ranger 4x4', minX, maxX, minZ, maxZ, h: y + 1.9 });
  return merged;
}

function lookoutTower(obstacles, x, z, gh) {
  const gy = gh(x, z);
  const H = 19.5; // platform level above the hilltop
  const b = 3.0;
  const t = 1.75;
  const halfAt = (y) => b + (t - b) * (y / H);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const metal = [];
  const concrete = [];
  for (const [sx, sz] of corners) {
    const bx = x + sx * b;
    const bz = z + sz * b;
    const fy = gh(bx, bz);
    metal.push(beam(bx, Math.min(fy, gy) - 0.4, bz, x + sx * t, gy + H, z + sz * t, 0.12, 6));
    concrete.push(placed(new BoxGeometry(0.9, 0.7, 0.9), bx, fy + 0.1, bz));
  }
  const levels = [1.2, 5.3, 9.3, 13.0, 16.4, H];
  const P = (c, y) => [x + corners[c][0] * halfAt(y), gy + y, z + corners[c][1] * halfAt(y)];
  for (let l = 0; l < levels.length; l++) {
    for (let c = 0; c < 4; c++) {
      const n = (c + 1) % 4;
      const a1 = P(c, levels[l]);
      const b1 = P(n, levels[l]);
      metal.push(beam(...a1, ...b1, 0.06, 4));
      if (l > 0) {
        const a0 = P(c, levels[l - 1]);
        const b0 = P(n, levels[l - 1]);
        metal.push(beam(...a0, ...b1, 0.045, 4), beam(...b0, ...a1, 0.045, 4));
      }
    }
  }
  // Platform, railing and the ladder up one face.
  const top = gy + H;
  const deck = [placed(new BoxGeometry(4.7, 0.2, 4.7), x, top + 0.1, z)];
  const rh = 1.05;
  const e = 2.3;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
    metal.push(beam(x + sx * e, top + 0.2, z + sz * e, x + sx * e, top + 0.2 + rh, z + sz * e, 0.04, 4));
  }
  for (let c = 0; c < 4; c++) {
    const [ax, az] = corners[c];
    const [bx, bz] = corners[(c + 1) % 4];
    metal.push(beam(x + ax * e, top + 0.2 + rh, z + az * e, x + bx * e, top + 0.2 + rh, z + bz * e, 0.035, 4));
  }
  for (const sx of [-0.25, 0.25]) metal.push(beam(x + sx, gy, z + 0.2, x + sx, top, z + 0.2, 0.03, 4));
  for (let y = 0.6; y < H; y += 0.45) metal.push(beam(x - 0.25, gy + y, z + 0.2, x + 0.25, gy + y, z + 0.2, 0.02, 3));
  // Cabin.
  const walls = [
    placed(new BoxGeometry(3.4, 1.0, 3.4), x, top + 0.7, z),
    placed(new BoxGeometry(3.4, 0.3, 3.4), x, top + 2.5, z),
  ];
  const glassGeo = [placed(new BoxGeometry(3.3, 1.15, 3.3), x, top + 1.775, z)];
  const roofGeo = [placed(new ConeGeometry(2.75, 1.4, 4, 1), x, top + 3.35, z, 0, Math.PI / 4, 0)];
  const beaconGeo = [placed(new IcosahedronGeometry(0.16, 1), x, top + 4.45, z)];
  metal.push(beam(x, top + 3.9, z, x, top + 4.35, z, 0.04, 4));
  const metalMat = lambert(0x7d8287);
  const wallMat = lambert(0xb9a98a);
  const roofMat = lambert(0x6d3b2c);
  const concreteMat = lambert(0x9a978f);
  const glassMat = new MeshLambertMaterial({ color: 0x48606e, emissive: new Color(0xffd9a0), emissiveIntensity: 0 });
  const beaconMat = new MeshLambertMaterial({ color: 0x5a0a06, emissive: new Color(0xff2a10), emissiveIntensity: 0.3 });
  const g = new Group();
  g.add(meshFrom(metal, metalMat, HEAT.metal));
  g.add(meshFrom(deck, lambert(0x5d4632), HEAT.building));
  g.add(meshFrom(concrete, concreteMat, HEAT.ground + 0.04));
  g.add(meshFrom(walls, wallMat, HEAT.building));
  g.add(meshFrom(glassGeo, glassMat, HEAT.building + 0.05));
  g.add(meshFrom(roofGeo, roofMat, HEAT.roof));
  g.add(meshFrom(beaconGeo, beaconMat, HEAT.light, false));
  const name = 'fire lookout tower';
  obstacles.push({ type: 'box', name, minX: x - 2.45, maxX: x + 2.45, minZ: z - 2.45, maxZ: z + 2.45, h: top + 4.6 });
  const hm = halfAt(9) + 0.2;
  obstacles.push({ type: 'box', name, minX: x - hm, maxX: x + hm, minZ: z - hm, maxZ: z + hm, h: gy + 9 });
  obstacles.push({ type: 'box', name, minX: x - b - 0.35, maxX: x + b + 0.35, minZ: z - b - 0.35, maxZ: z + b + 0.35, h: gy + 3 });
  return { group: g, glassMat, beaconMat, top: top + 4.6 };
}

function footbridge(obstacles, bridge, gh) {
  const { x, z, half } = bridge;
  const hS = gh(x, z + half);
  const hN = gh(x, z - half);
  const deckY = Math.max(hS, hN, 0) + 0.3;
  const len = 2 * half + 1.5;
  const deck = [placed(new BoxGeometry(1.9, 0.14, len), x, deckY, z)];
  const frame = [];
  for (const sx of [-0.75, 0.75]) frame.push(placed(new BoxGeometry(0.2, 0.3, len), x + sx, deckY - 0.22, z));
  for (let pz = z - half + 2; pz <= z + half - 2 + 1e-6; pz += (2 * half - 4) / 4) {
    const bed = Math.min(gh(x - 0.8, pz), gh(x + 0.8, pz)) - 0.6;
    for (const sx of [-0.8, 0.8]) frame.push(beam(x + sx, bed, pz, x + sx, deckY - 0.3, pz, 0.12, 6));
    frame.push(placed(new BoxGeometry(1.9, 0.18, 0.2), x, deckY - 0.42, pz));
  }
  const nPost = Math.round(len / 2);
  for (const sx of [-0.92, 0.92]) {
    for (let i = 0; i <= nPost; i++) {
      const pz = z - len / 2 + (i * len) / nPost;
      frame.push(placed(new BoxGeometry(0.1, 1.0, 0.1), x + sx, deckY + 0.57, pz));
    }
    frame.push(placed(new BoxGeometry(0.09, 0.09, len), x + sx, deckY + 1.06, z));
    frame.push(placed(new BoxGeometry(0.06, 0.06, len), x + sx, deckY + 0.6, z));
  }
  const g = new Group();
  g.add(meshFrom(deck, lambert(0x7a5a3a), HEAT.building - 0.04));
  g.add(meshFrom(frame, lambert(0x5a4029), HEAT.building - 0.04));
  obstacles.push({ type: 'box', name: 'footbridge', minX: x - 1.05, maxX: x + 1.05, minZ: z - len / 2, maxZ: z + len / 2, h: deckY + 1.1 });
  return g;
}

// Tent, smouldering campfire and the missing person. No obstacles are added here on purpose:
// the engine draws obstacles on the minimap, which would give the search target away.
function searchCamp(cx, cz, gh, rnd) {
  const g = new Group();
  const yaw = rnd() * Math.PI * 2;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const at = (lx, lz) => [cx + lx * c + lz * s, cz - lx * s + lz * c];

  const [tx, tz] = at(-2.4, -1.2);
  const shape = new Shape();
  shape.moveTo(-0.85, 0);
  shape.lineTo(0.85, 0);
  shape.lineTo(0, 1.15);
  shape.closePath();
  const tent = new Mesh(new ExtrudeGeometry(shape, { depth: 2.2, bevelEnabled: false }).translate(0, 0, -1.1), standard(0xf07a1a, { roughness: 0.9 }));
  tent.position.set(tx, gh(tx, tz) - 0.03, tz);
  tent.rotation.y = yaw + 0.4;
  tent.castShadow = true;
  g.add(tagHeat(tent, HEAT.soil));

  const [bx, bz] = at(-0.9, -2.5);
  const pack = new Mesh(new BoxGeometry(0.35, 0.55, 0.25), lambert(0x2d5aa8));
  pack.position.set(bx, gh(bx, bz) + 0.27, bz);
  pack.rotation.set(0.3, yaw, 0.1);
  g.add(tagHeat(pack, HEAT.ground + 0.06));

  const [fx, fz] = at(1.2, 1.0);
  const fy = gh(fx, fz);
  const stones = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    stones.push(placed(new IcosahedronGeometry(0.13 + rnd() * 0.05, 0), fx + Math.cos(a) * 0.55, fy + 0.06, fz + Math.sin(a) * 0.55, rnd(), rnd(), 0));
  }
  g.add(meshFrom(stones, lambert(0x77736b, { flatShading: true }), HEAT.soil + 0.1));
  const logs = [];
  for (let i = 0; i < 3; i++) logs.push(placed(new CylinderGeometry(0.06, 0.07, 0.8, 6), fx, fy + 0.1, fz, Math.PI / 2 - 0.25, (i / 3) * Math.PI, 0));
  g.add(meshFrom(logs, lambert(0x3a2a1c), HEAT.hotspot * 0.85));
  const emberMat = new MeshBasicMaterial({ color: 0xff5a1a });
  const embers = meshFrom([placed(new CylinderGeometry(0.4, 0.45, 0.05, 10), fx, fy + 0.03, fz)], emberMat, HEAT.hotspot, false);
  g.add(embers);
  const flameMat = new MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85, depthWrite: false });
  const flame = new Mesh(new ConeGeometry(0.22, 0.7, 7).translate(0, 0.35, 0), flameMat);
  flame.position.set(fx, fy + 0.05, fz);
  g.add(tagHeat(flame, HEAT.hotspot));
  const light = new PointLight(0xff8a3a, 0, 22, 2);
  light.position.set(fx, fy + 0.9, fz);
  g.add(light);

  // The missing person, lying on their back near the camp in a red jacket.
  const [px, pz] = at(2.6, -2.0);
  const body = person(0xe8232a, { pants: 0x2f3542 });
  body.rotation.x = -Math.PI / 2;
  body.position.y = 0.2;
  const holder = new Group();
  holder.add(body);
  holder.position.set(px, gh(px, pz), pz);
  holder.rotation.y = yaw + 1.1;
  g.add(holder);
  return { group: g, light, flame, person: { x: px, z: pz } };
}

// ---------------------------------------------------------------- scene

export function build(ctx) {
  const opts = ctx || {};
  const quality = Q[opts.quality] ? opts.quality : 'medium';
  const cfg = Q[quality];
  const searchSeed = Number.isFinite(opts.seed) ? Math.floor(opts.seed) : 1;
  const T = forestTerrain(TERRAIN_SEED);
  const rnd = mulberry32(TERRAIN_SEED * 7 + 3);
  const root = new Group();
  root.name = 'forest-hills';
  const obstacles = [];

  // ---- height grid shared by the mesh and groundHeight()
  const grid = forestHeightGrid(T, cfg.step);
  const gh = grid.groundHeight;
  const slopeAt = (x, z) => Math.hypot(gh(x + 1.5, z) - gh(x - 1.5, z), gh(x, z + 1.5) - gh(x, z - 1.5)) / 3;

  // ---- layout
  const bridge = pickBridge(T);
  const tower = pickHilltop(T, gh);
  const trail = trailPaths(bridge, tower);
  const road = sampleCurve(ROAD_CTRL, 1.25);
  const pathIdx = new PointIndex(10);
  const coarsePath = [];
  [trail.south, trail.north, road].forEach((pts) => pts.forEach((p, i) => {
    pathIdx.add(p[0], p[1]);
    if (i % 6 === 0) coarsePath.push(p);
  }));
  for (let z = bridge.z - bridge.half; z <= bridge.z + bridge.half; z += 1.25) pathIdx.add(bridge.x, z);
  const poles = linePoles(T, gh);
  const lineDist = (x, z) => polylineDist(poles, x, z);
  const camp = chooseCamp(searchSeed, T, gh, (x, z) => {
    if (Math.hypot(x - tower.x, z - tower.z) < 50 || lineDist(x, z) < 40) return true;
    for (const p of coarsePath) if (Math.hypot(x - p[0], z - p[1]) < 35) return true;
    return false;
  });
  // Natural gaps: the camp's, around the tower, and decoys so the camp gap is not unique.
  const gaps = [{ x: camp.x, z: camp.z, r: 12 }, { x: tower.x, z: tower.z, r: 13 }];
  for (let i = 0, tries = 0; i < 9 && tries < 400; tries++) {
    const a = rnd() * Math.PI * 2;
    const d = 90 + rnd() * 330;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (T.forestRaw(x, z) < 0.6 || T.riverDist(x, z) < 30 || lineDist(x, z) < 20 || pathIdx.near(x, z, 10)) continue;
    if (Math.hypot(x - camp.x, z - camp.z) < 60) continue;
    gaps.push({ x, z, r: 7 + rnd() * 5 });
    i++;
  }
  const inGap = (x, z, pad = 0) => {
    for (const g of gaps) {
      const dx = x - g.x;
      const dz = z - g.z;
      const rr = g.r + pad;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  };
  const forestMask = (x, z) => {
    const m = T.forestRaw(x, z);
    const d = Math.hypot(x - camp.x, z - camp.z);
    return d < 60 ? Math.max(m, 1 - smoothstep(22, 60, d)) : m;
  };
  const floorMask = (x, z) => {
    let open = 0;
    const ld = lineDist(x, z);
    if (ld < 16) open = 1 - smoothstep(8, 16, ld);
    for (const g of gaps) {
      const d = Math.hypot(x - g.x, z - g.z);
      if (d < g.r + 6) open = Math.max(open, 1 - smoothstep(g.r - 2, g.r + 6, d));
    }
    return forestMask(x, z) * (1 - open);
  };

  // ---- ground, water, paths
  root.add(terrainMesh(grid, T, floorMask, cfg.place));
  const river = riverMesh(T);
  root.add(river.mesh);
  const strips = { pos: [], uv: [], idx: [] };
  ribbonInto(trail.south, 2.2, gh, 0.07, 3, strips);
  ribbonInto(trail.north, 2.2, gh, 0.07, 3, strips);
  ribbonInto(road, 3.4, gh, 0.07, 3, strips);
  const pathMesh = new Mesh(geometryFrom(strips), flat(0xffffff, { map: trailTexture() }));
  pathMesh.receiveShadow = true;
  pathMesh.name = 'trails';
  root.add(tagHeat(pathMesh, HEAT.soil));

  // ---- ranger clearing
  const pad = homePad();
  root.add(mergeByMaterial(pad.group));
  root.add(tagHeat(mergeByMaterial(pilotPost(obstacles, PILOT.x, PILOT.z, { groundHeight: gh, color: 0x2e6b3a })), HEAT.metal));
  const sock = windsock(obstacles, 12, -6, { groundHeight: gh });
  root.add(tagHeat(sock.group, HEAT.metal));
  const cabin = rangerCabin(obstacles, CABIN.x, CABIN.z, gh);
  root.add(cabin.group);
  root.add(rangerVehicle(obstacles, -5, 27, 2.3, gh));

  // ---- landmarks and hazards
  const look = lookoutTower(obstacles, tower.x, tower.z, gh);
  root.add(look.group);
  root.add(footbridge(obstacles, bridge, gh));
  const line = mergeByMaterial(powerLine(obstacles, poles, { height: 12, wires: 3, sag: 0.6, spread: 1.15, groundHeight: gh, poleColor: 0x5b4330, name: 'power line' }));
  for (const m of line.children) if (m.isMesh) m.userData.heat = m.material.isMeshBasicMaterial ? HEAT.metal + 0.1 : HEAT.vegetation + 0.12;
  root.add(line);
  const sar = searchCamp(camp.x, camp.z, gh, mulberry32(searchSeed + 101));
  root.add(sar.group);

  // ---- vegetation
  const RP = cfg.place;
  const blocked = (x, z, pathClear, riverClear) => {
    const r = Math.hypot(x, z);
    if (r < 40 + 5 * T.noise(x * 0.05, z * 0.05)) return true;
    if (T.riverDist(x, z) < T.riverHW(x) + riverClear) return true;
    if (pathIdx.near(x, z, pathClear)) return true;
    return false;
  };
  // Keep small props out of the cabin footprint and from under the lookout tower.
  const onStructure = (x, z) => (Math.abs(x - CABIN.x - 1.2) < 7 && Math.abs(z - CABIN.z) < 7.5) || Math.hypot(x - tower.x, z - tower.z) < 6;

  // Fallen logs (seg obstacles along the trunk).
  const logItems = [];
  for (let tries = 0; logItems.length < cfg.logs && tries < cfg.logs * 60; tries++) {
    const x = (rnd() * 2 - 1) * RP * 0.75;
    const z = (rnd() * 2 - 1) * RP * 0.75;
    if (forestMask(x, z) < 0.55 || blocked(x, z, 5, 6) || inGap(x, z, 2) || lineDist(x, z) < 8 || slopeAt(x, z) > 0.25) continue;
    const L = 4 + rnd() * 4.5;
    const rad = 0.2 + rnd() * 0.16;
    const ry = rnd() * Math.PI;
    const ex = (Math.cos(ry) * L) / 2;
    const ez = (-Math.sin(ry) * L) / 2;
    const ha = gh(x + ex, z + ez);
    const hb = gh(x - ex, z - ez);
    if (Math.abs(ha - hb) > 0.6) continue;
    const y = (ha + hb) / 2 + rad * 0.75;
    logItems.push({ x, y, z, sx: L, sy: rad, sz: rad, ry });
    if (Math.hypot(x, z) < 400) obstacles.push({ type: 'seg', name: 'fallen log', ax: x + ex, ay: y, az: z + ez, bx: x - ex, by: y, bz: z - ez, r: rad });
  }
  const logGeo = new CylinderGeometry(1, 1, 1, 8, 1).rotateZ(Math.PI / 2);
  root.add(tagHeat(instanced(logGeo, lambert(0xd8c8b8, { map: barkTexture() }), logItems), HEAT.vegetation + 0.04));

  // Rocks: steep slopes, river banks and the riverbed; a few big boulders (obstacles).
  const rockSpots = [];
  for (let tries = 0; rockSpots.length < cfg.rocks && tries < cfg.rocks * 40; tries++) {
    const x = (rnd() * 2 - 1) * RP * 0.8;
    const z = (rnd() * 2 - 1) * RP * 0.8;
    if (Math.hypot(x, z) < 34 || pathIdx.near(x, z, 2.5) || inGap(x, z, -3) || onStructure(x, z)) continue;
    const d = T.riverDist(x, z);
    const hw = T.riverHW(x);
    const sl = slopeAt(x, z);
    let p = 0.05 + 0.9 * smoothstep(0.45, 0.9, sl);
    if (d < hw + 7) p += 0.8;
    if (rnd() > p) continue;
    rockSpots.push({ x, z, s: d < hw ? 1.4 + rnd() * 0.9 : (0.5 + rnd()) * (1 + sl * 0.6) });
  }
  for (let i = 0, tries = 0; i < cfg.boulders && tries < 2000; tries++) {
    const x = (rnd() * 2 - 1) * RP * 0.7;
    const z = (rnd() * 2 - 1) * RP * 0.7;
    if (blocked(x, z, 6, 8) || inGap(x, z, 3) || lineDist(x, z) < 6 || slopeAt(x, z) < 0.3) continue;
    const s = 2.2 + rnd();
    rockSpots.push({ x, z, s });
    if (Math.hypot(x, z) < 400) obstacles.push({ type: 'cyl', name: 'boulder', x, z, r: s * 0.95, h: gh(x, z) + 0.95 * s });
    i++;
  }
  root.add(rocks(rockSpots, { groundHeight: gh, seed: TERRAIN_SEED + 7, color: 0x88847b }));

  // Trees: Poisson-ish rejection sampling over a density field (forest patches, denser on
  // hillsides, riparian strip along the river, thinning with distance).
  const spots = [];
  const treeIdx = new PointIndex(6);
  for (let tries = 0; spots.length < cfg.trees && tries < cfg.trees * 40; tries++) {
    const x = (rnd() * 2 - 1) * RP;
    const z = (rnd() * 2 - 1) * RP;
    if (blocked(x, z, 4.5, 4.5) || inGap(x, z) || lineDist(x, z) < 11) continue;
    const r = Math.hypot(x, z);
    if (r > RP * 1.15) continue;
    const d = T.riverDist(x, z);
    const riparian = d < T.riverHW(x) + 24;
    let m = forestMask(x, z);
    if (riparian) m = Math.max(m, 0.7);
    m = Math.max(m, 0.6 * (1 - smoothstep(42, 62, r)));
    const sl = slopeAt(x, z);
    const hill = 0.7 + 0.45 * smoothstep(0.06, 0.35, sl) - 0.75 * smoothstep(0.85, 1.25, sl);
    const p = m * hill * (1 - 0.65 * smoothstep(RP * 0.45, RP, r));
    if (p <= 0 || rnd() > p || treeIdx.near(x, z, 3.4)) continue;
    treeIdx.add(x, z);
    const y = gh(x, z);
    const pine = rnd() < clamp(0.25 + 0.5 * smoothstep(4, 24, y) - (riparian ? 0.18 : 0), 0.06, 0.85);
    let s = pine ? 1.05 + rnd() * 0.8 : 1.0 + rnd() * 0.65;
    s *= (0.78 + 0.22 * smoothstep(38, 75, r)) * cfg.treeScale;
    spots.push({ x, z, s, kind: pine ? 'pine' : 'broad' });
  }
  // Keep the total obstacle count bounded: only the nearest trees collide.
  const cap = Math.max(0, MAX_OBSTACLES - obstacles.length);
  const dists = spots.map((p) => Math.hypot(p.x, p.z)).sort((a, b) => a - b);
  const maxObstacleDist = dists.length > cap ? Math.min(350, dists[cap]) : 350;
  const forest = trees(obstacles, spots, { groundHeight: gh, seed: TERRAIN_SEED + 5, maxObstacleDist });
  root.add(forest.group);

  const bushSpots = [];
  for (let tries = 0; bushSpots.length < cfg.bushes && tries < cfg.bushes * 30; tries++) {
    const x = (rnd() * 2 - 1) * RP * 0.85;
    const z = (rnd() * 2 - 1) * RP * 0.85;
    const r = Math.hypot(x, z);
    const d = T.riverDist(x, z);
    const hw = T.riverHW(x);
    if (r < 33 || d < hw + 3 || pathIdx.near(x, z, 2.6) || Math.hypot(x - camp.x, z - camp.z) < 6.5 || onStructure(x, z)) continue;
    const m = forestMask(x, z);
    let p = 0.12 + 1.6 * m * (1 - m);
    if (r < 56) p += 0.8 * (1 - smoothstep(42, 56, r));
    if (d < hw + 16) p += 0.6;
    p *= 1 - 0.5 * smoothstep(RP * 0.5, RP * 0.85, r);
    if (rnd() > p) continue;
    bushSpots.push({ x, z, s: 0.7 + rnd() * 0.9 });
  }
  root.add(bushes(bushSpots, { groundHeight: gh, seed: TERRAIN_SEED + 6 }));

  // ---- minimap
  const riverPts = [];
  for (let x = -MAP_HALF - 60; x <= MAP_HALF + 60; x += 6) riverPts.push([x, T.riverZ(x)]);
  const thin = (pts, k) => pts.filter((_, i) => i % k === 0 || i === pts.length - 1);
  const mapTrail = [...thin(trail.south, 4), [bridge.x, bridge.z], ...thin(trail.north, 4)];
  const mapRoad = thin(road, 4);
  let mapCanvas = null;
  function renderMapCanvas() {
    const N = 220;
    const cell = (2 * MAP_HALF) / N;
    const cv = document.createElement('canvas');
    cv.width = N;
    cv.height = N;
    const g = cv.getContext('2d');
    const img = g.createImageData(N, N);
    const L = [-0.55, 0.75, -0.55];
    const ll = Math.hypot(...L);
    for (let j = 0; j < N; j++) {
      const z = -MAP_HALF + (j + 0.5) * cell;
      for (let i = 0; i < N; i++) {
        const x = -MAP_HALF + (i + 0.5) * cell;
        const h = gh(x, z);
        const hx = (gh(x + cell, z) - gh(x - cell, z)) / (2 * cell);
        const hz = (gh(x, z + cell) - gh(x, z - cell)) / (2 * cell);
        const nl = Math.hypot(hx, 1, hz);
        const shade = clamp(((-hx * L[0] + L[1] - hz * L[2]) / (nl * ll)) / (L[1] / ll), 0.55, 1.3);
        const m = T.forestRaw(x, z);
        let cr = lerp(118, 52, m);
        let cg = lerp(156, 92, m);
        let cb = lerp(74, 44, m);
        const rk = smoothstep(0.5, 0.95, Math.hypot(hx, hz));
        cr = lerp(cr, 140, rk);
        cg = lerp(cg, 134, rk);
        cb = lerp(cb, 120, rk);
        const sd = 1 - smoothstep(T.riverHW(x) + 1.5, T.riverHW(x) + 7, T.riverDist(x, z));
        cr = lerp(cr, 190, sd);
        cg = lerp(cg, 172, sd);
        cb = lerp(cb, 128, sd);
        const lift = 1 + clamp(h, -2, 40) * 0.006;
        // Faint 10 m contour lines.
        const contour = Math.floor(h / 10) !== Math.floor(gh(x + cell, z) / 10) || Math.floor(h / 10) !== Math.floor(gh(x, z + cell) / 10) ? 0.82 : 1;
        const k = shade * lift * contour;
        const o = (j * N + i) * 4;
        img.data[o] = clamp(cr * k, 0, 255);
        img.data[o + 1] = clamp(cg * k, 0, 255);
        img.data[o + 2] = clamp(cb * k, 0, 255);
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  // ---- runtime state
  let night = 0;
  let clock = 0;

  return {
    root,
    obstacles,
    groundHeight: gh,
    pilot: { x: PILOT.x, z: PILOT.z },
    patterns: false,
    // Water surface height where the terrain dips below it (river); null on dry ground.
    waterAt: (x, z) => (gh(x, z) < WATER_Y ? WATER_Y : null),
    swayMaterials: forest.swayMaterials,
    mapExtent: 300,
    poi: [
      { name: 'Ranger cabin', x: CABIN.x, z: CABIN.z },
      { name: 'River footbridge', x: bridge.x, z: bridge.z },
      { name: 'Fire lookout tower', x: tower.x, z: tower.z },
      { name: 'Missing person (search target)', x: sar.person.x, z: sar.person.z, hidden: true },
    ],
    setNight(k) {
      night = clamp(k, 0, 1);
      pad.setNight(night);
      cabin.glassMat.emissiveIntensity = 0.03 + night * 1.6;
      cabin.lanternMat.emissiveIntensity = 0.2 + night * 3;
      look.glassMat.emissiveIntensity = night * 0.35;
    },
    update(dt, t, windAt) {
      clock += dt || 0;
      if (windAt) {
        const w = windAt(sock.sample.x, sock.sample.y, sock.sample.z, _w);
        if (w) sock.update(dt, w);
      }
      river.tex.offset.x = (river.tex.offset.x - (dt || 0) * 0.04) % 1;
      const fl = 0.8 + 0.12 * Math.sin(clock * 13.1) + 0.08 * Math.sin(clock * 29.7 + 1.3);
      sar.flame.scale.set(1, fl * (0.7 + 0.5 * night), 1);
      sar.light.intensity = night * 28 * fl;
      look.beaconMat.emissiveIntensity = night > 0.2 ? (clock % 1.5 < 0.25 ? 4 * night : 0.15) : 0.3;
    },
    mapPaint(g, toPx) {
      if (!mapCanvas) mapCanvas = renderMapCanvas();
      const [ax, ay] = toPx(-MAP_HALF, -MAP_HALF);
      const [bx, by] = toPx(MAP_HALF, -MAP_HALF);
      const [cx, cy] = toPx(-MAP_HALF, MAP_HALF);
      const W = mapCanvas.width;
      g.save();
      g.transform((bx - ax) / W, (by - ay) / W, (cx - ax) / W, (cy - ay) / W, ax, ay);
      g.drawImage(mapCanvas, 0, 0);
      g.restore();
      const ppm = Math.hypot(bx - ax, by - ay) / (2 * MAP_HALF) || 1;
      const [ox, oy] = toPx(0, 0);
      g.fillStyle = 'rgba(165,205,115,0.9)';
      g.beginPath();
      g.arc(ox, oy, Math.max(2, 37 * ppm), 0, Math.PI * 2);
      g.fill();
      paintPolyline(g, toPx, riverPts, '#4a86b8', Math.max(2, 13 * ppm));
      paintPolyline(g, toPx, mapRoad, '#a2835a', Math.max(1.5, 3.4 * ppm));
      paintPolyline(g, toPx, mapTrail, '#a2835a', Math.max(1.2, 2.2 * ppm));
      paintPolyline(g, toPx, [[bridge.x, bridge.z + bridge.half], [bridge.x, bridge.z - bridge.half]], '#6e4f31', Math.max(1.5, 2.4 * ppm));
    },
    dispose() {
      mapCanvas = null;
      disposeTree(root);
    },
  };
}
