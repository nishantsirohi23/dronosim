// "Solar & Substation": utility-scale solar park, a 132/33 kV substation, a 132 kV transmission line and an
// industrial estate on dry scrubland. Drone inspection training with a thermal hot-spot target.
//
// Layout (metres, +X east, -Z north, flat ground):
//   operations yard + home pad at the origin, pilot post at (0, 14)
//   solar park north of the yard (z -35 .. -233), 2 x 4 blocks of fixed-tilt tables facing south (+Z)
//   33 kV collector line along the perimeter road (z = -33.5) to the substation
//   substation east of the yard (x 80 .. 140), 132 kV line leaving east / north-east on lattice towers
//   warehouses, boiler house + chimney stack and a tank farm to the south-west

import {
  BoxGeometry, BufferAttribute, BufferGeometry, CatmullRomCurve3, Color, ConeGeometry, CylinderGeometry, DoubleSide,
  DynamicDrawUsage, Group, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial, PlaneGeometry, Quaternion, RepeatWrapping,
  TubeGeometry, Vector3,
} from 'three';
import {
  HEAT, QUALITY_SCALE, building, bushes, canvasTexture, disposeTree, facadeTexture, flat, homePad, horizonHills,
  instanced, lambert, lightWindows, makeNoise2D, mulberry32, paintPolyline, paintRect, pavingTexture, pilotPost,
  powerLine, roadTexture, rocks, soilTexture, solarPanelTexture, speckle, standard, streetLights, strip, tagHeat,
  trees, truck, windsock,
} from './common.js';

// ---------------------------------------------------------------- layout constants

const DEG = Math.PI / 180;

// Panel tables: 2 landscape modules deep (2 m along the slope) x 12 modules long (24 m), 20 deg tilt facing south.
const TILT = 20 * DEG;
const TABLE_L = 24;
const TABLE_D = 2;
const SLAB_T = 0.05;
const TABLE_YC = 1.2; // slab centre height: low (south) edge ~0.85 m, high (north) edge ~1.55 m
const ROW_PITCH = 7.5; // ~1.9 m table footprint + ~5.6 m access lane
const ROWS = 12;
const HALF_LANE = 4; // inner N-S lane half width (inverter station sits in it)
const HALF_W = 49; // half-block width: 2 tables + 1 m gap
const TABLE_OFFS = [-41, -16, 16, 41]; // table centres relative to the block centre
// Blocks in order of distance from home: near row (inner, outer), far row (inner, outer).
const BLOCK_SLOTS = [
  { cx: -59, z0: -42 }, { cx: 59, z0: -42 }, { cx: -177, z0: -42 }, { cx: 177, z0: -42 },
  { cx: -59, z0: -144 }, { cx: 59, z0: -144 }, { cx: -177, z0: -144 }, { cx: 177, z0: -144 },
];

const PARK = { minX: -236, maxX: 236, minZ: -233, maxZ: -35 };
const YARD = { minX: -34, maxX: 26, minZ: -24, maxZ: 24 };
const SUB = { minX: 80, maxX: 140, minZ: -24, maxZ: 26 };
const IND = { minX: -250, maxX: -50, minZ: 50, maxZ: 190 };
const CHIMNEY = { x: -120, z: 140, h: 45 };
const OFFICE = { x: -27, z: 4, w: 10, d: 16, h: 7 };
const SUB_CZ = 2; // substation busbar centre line (z)

// Gravel roads: ax, az, bx, bz, width, y
const GRAVEL_ROADS = [
  [0, -24, 0, -236, 8, 0.07], // main N-S spine through the park
  [-240, -29, 240, -29, 7, 0.064], // perimeter road south of the park fence
  [-232, -134.25, 232, -134.25, 8, 0.064], // E-W road between block rows
  [-118, -29, -118, -231, 7, 0.07],
  [118, -29, 118, -231, 7, 0.07],
  [26, 5, 80, 5, 6, 0.064], // yard -> substation gate
  [0, 24, 0, 295.5, 7, 0.07], // site access road south
  [-300, 42, -3.5, 42, 8, 0.064], // industrial estate road
];
const PUBLIC_ROAD = [-450, 300, 450, 300, 9];

// 132 kV towers leaving the substation towards the east / north-east.
const TOWERS = [[165, 2], [226, -14], [287, -34], [348, -54], [409, -74], [470, -94]];
const HV_HEIGHT = 27; // conductor attachment at HV_HEIGHT - 0.25; tower peaks at 31.5 m
const HV_SPREAD = 5;
// 33 kV collector line (concrete poles) along the perimeter road into the substation.
const C_POLES = [[-205, -33.5], [-160, -33.5], [-111, -33.5], [-66, -33.5], [-22, -33.5], [22, -33.5], [64, -33.5], [104, -33.5]];

// ---------------------------------------------------------------- geometry helpers (local)

const _Y = new Vector3(0, 1, 0);
const _dv = new Vector3();
const _qb = new Quaternion();

const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Thin member between two points (square section, or round when `round`).
function beam(ax, ay, az, bx, by, bz, t, round = false) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1e-3;
  const g = round ? new CylinderGeometry(t, t, len, t > 0.1 ? 14 : 8, 1, t <= 0.1) : new BoxGeometry(t, len, t);
  _qb.setFromUnitVectors(_Y, _dv.set(dx / len, dy / len, dz / len));
  g.applyQuaternion(_qb);
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

// Merge geometries (position / normal / uv) into one indexed geometry.
function mergeGeos(geos) {
  let nv = 0;
  let ni = 0;
  for (const g of geos) {
    const n = g.attributes.position.count;
    nv += n;
    ni += g.index ? g.index.count : n;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const t = g.attributes.uv;
    const cnt = p.count;
    for (let i = 0; i < cnt; i++) {
      const k = (vo + i) * 3;
      pos[k] = p.getX(i);
      pos[k + 1] = p.getY(i);
      pos[k + 2] = p.getZ(i);
      if (n) {
        nor[k] = n.getX(i);
        nor[k + 1] = n.getY(i);
        nor[k + 2] = n.getZ(i);
      }
      if (t) {
        uv[(vo + i) * 2] = t.getX(i);
        uv[(vo + i) * 2 + 1] = t.getY(i);
      }
    }
    if (g.index) {
      const ia = g.index;
      for (let i = 0; i < ia.count; i++) idx[io + i] = ia.getX(i) + vo;
      io += ia.count;
    } else {
      for (let i = 0; i < cnt; i++) idx[io + i] = vo + i;
      io += cnt;
    }
    vo += cnt;
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setAttribute('normal', new BufferAttribute(nor, 3));
  out.setAttribute('uv', new BufferAttribute(uv, 2));
  out.setIndex(new BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

// Collapse the plain meshes of a group into one mesh per equivalent material (fewer draw calls).
// Instanced meshes, multi-material meshes and non-mesh children (lights) are left alone.
function compact(group) {
  group.updateMatrixWorld(true);
  const inv = new Matrix4().copy(group.matrixWorld).invert();
  const meshes = [];
  group.traverse((o) => {
    if (o.isMesh && !o.isInstancedMesh && !Array.isArray(o.material)) meshes.push(o);
  });
  const buckets = new Map();
  const rel = new Matrix4();
  for (const o of meshes) {
    const m = o.material;
    const key = [
      m.type, m.color ? m.color.getHex() : '', m.emissive ? m.emissive.getHex() : '', m.emissiveIntensity ?? '',
      m.wireframe, m.transparent, m.opacity, m.side, m.map ? m.map.uuid : '', m.emissiveMap ? m.emissiveMap.uuid : '',
      m.flatShading, m.roughness ?? '', m.metalness ?? '', m.polygonOffset, m.polygonOffsetFactor, m.depthWrite,
      o.userData.heat ?? '',
    ].join('|');
    let b = buckets.get(key);
    if (!b) {
      b = { mat: m, heat: o.userData.heat, geos: [], cast: false, recv: false };
      buckets.set(key, b);
    }
    rel.multiplyMatrices(inv, o.matrixWorld);
    b.geos.push(o.geometry.clone().applyMatrix4(rel));
    b.cast = b.cast || o.castShadow;
    b.recv = b.recv || o.receiveShadow;
  }
  const used = new Set([...buckets.values()].map((b) => b.mat));
  const oldGeos = new Set();
  const oldMats = new Set();
  for (const o of meshes) {
    oldGeos.add(o.geometry);
    oldMats.add(o.material);
    o.parent.remove(o);
  }
  for (const g of oldGeos) g.dispose();
  for (const mm of oldMats) if (!used.has(mm)) mm.dispose();
  for (const b of buckets.values()) {
    const mesh = new Mesh(mergeGeos(b.geos), b.mat);
    for (const g of b.geos) g.dispose();
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.recv;
    if (b.heat !== undefined) mesh.userData.heat = b.heat;
    group.add(mesh);
  }
  return group;
}

// Instanced unit boxes / custom geometries grouped by material, plus static merged geometry buckets.
function makeBatches() {
  const unitBox = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const inst = new Map();
  const stat = new Map();
  return {
    def(key, mat, heat, { geo = unitBox, cast = true } = {}) {
      inst.set(key, { geo, mat, heat, cast, items: [] });
    },
    sdef(key, mat, heat, cast = true) {
      stat.set(key, { mat, heat, cast, geos: [] });
    },
    // Box with its base at y.
    box(key, x, y, z, sx, sy, sz, ry = 0) {
      inst.get(key).items.push({ x, y, z, sx, sy, sz, ry });
    },
    geo(key, g) {
      stat.get(key).geos.push(g);
    },
    build(parent) {
      for (const d of inst.values()) {
        if (!d.items.length) {
          d.mat.dispose();
          continue;
        }
        parent.add(tagHeat(instanced(d.geo, d.mat, d.items, { castShadow: d.cast }), d.heat));
      }
      for (const d of stat.values()) {
        if (!d.geos.length) {
          d.mat.dispose();
          continue;
        }
        const m = new Mesh(mergeGeos(d.geos), d.mat);
        for (const g of d.geos) g.dispose();
        m.castShadow = d.cast;
        m.receiveShadow = true;
        parent.add(tagHeat(m, d.heat));
      }
    },
  };
}

// Same direction convention as common.js powerLine(): (sin dir, cos dir) runs along the line.
function lineDirs(pts) {
  return pts.map((p, i) => {
    const a = pts[Math.min(i + 1, pts.length - 1)];
    const b = pts[Math.max(i - 1, 0)];
    return Math.atan2(a.x - b.x, a.z - b.z);
  });
}
const perpOf = (dir) => ({ x: Math.cos(dir), z: -Math.sin(dir) });

// Cross-arms built by powerLine() should lie across the line (local X -> perpendicular), i.e. rotation.y = dir.
function fixArms(group, pts, dirs) {
  for (const o of group.children) {
    if (!o.isMesh || o.geometry.type !== 'BoxGeometry') continue;
    let best = 0;
    let bd = Infinity;
    pts.forEach((p, i) => {
      const d = Math.hypot(o.position.x - p.x, o.position.z - p.z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    o.rotation.y = dirs[best];
  }
}

function distSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

// Horizontal plane over a rectangle with UVs in tiles of `tile` metres.
function rectGeo(minX, minZ, maxX, maxZ, y, tile) {
  const w = maxX - minX;
  const d = maxZ - minZ;
  const g = new PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * d) / tile);
  g.translate((minX + maxX) / 2, y, (minZ + maxZ) / 2);
  return g;
}

// Fixed-tilt table substructure: 4 leg pairs, rafters and two purlins, in table-local coordinates.
function tableFrameGeometry() {
  const tanT = Math.tan(TILT);
  const cosT = Math.cos(TILT);
  const yBot = (z) => TABLE_YC - z * tanT - SLAB_T / 2 / cosT;
  const P = [];
  for (const x of [-9, -3, 3, 9]) {
    P.push(beam(x, yBot(0.85) - 0.12, 0.85, x, yBot(-0.85) - 0.12, -0.85, 0.07));
    for (const z of [0.55, -0.55]) P.push(beam(x, 0, z, x, yBot(z) - 0.15, z, 0.09));
  }
  for (const z of [0.55, -0.55]) P.push(beam(-TABLE_L / 2 + 0.3, yBot(z) - 0.045, z, TABLE_L / 2 - 0.3, yBot(z) - 0.045, z, 0.07));
  const g = mergeGeos(P);
  P.forEach((p) => p.dispose());
  return g;
}

// Porcelain insulator with sheds: unit height and radius, base at y = 0 (scale by (r, len, r)).
function insulatorGeometry(sheds = 7) {
  const P = [];
  const core = new CylinderGeometry(0.42, 0.5, 1, 8);
  core.translate(0, 0.5, 0);
  P.push(core);
  for (let i = 0; i < sheds; i++) {
    const d = new CylinderGeometry(1, 1, 0.045, 10);
    d.translate(0, 0.08 + (i / (sheds - 1)) * 0.84, 0);
    P.push(d);
  }
  const g = mergeGeos(P);
  P.forEach((p) => p.dispose());
  return g;
}

// 132 kV horizontal-configuration lattice tower. Local X runs across the line (cross-arm), Z along it.
// Body 0..18 m, a two-column head forms a window for the centre phase, cross-arm at 28.6 m, earth-wire peaks at 31.5 m.
function latticeTowerGeometry() {
  const P = [];
  const add = (a, b, t) => P.push(beam(a[0], a[1], a[2], b[0], b[1], b[2], t));
  const C = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  const hw = (y) => 3.0 - (2.0 * y) / 18;
  const lv = [0, 4.5, 9, 13.5, 18];
  for (let i = 0; i < lv.length - 1; i++) {
    const y0 = lv[i];
    const y1 = lv[i + 1];
    const w0 = hw(y0);
    const w1 = hw(y1);
    for (let c = 0; c < 4; c++) {
      const [ax, az] = C[c];
      const [bx, bz] = C[(c + 1) % 4];
      add([ax * w0, y0, az * w0], [ax * w1, y1, az * w1], 0.2);
      add([ax * w0, y0, az * w0], [bx * w1, y1, bz * w1], 0.07);
      add([bx * w0, y0, bz * w0], [ax * w1, y1, az * w1], 0.07);
      add([ax * w1, y1, az * w1], [bx * w1, y1, bz * w1], 0.09);
    }
  }
  const YT = 28.6;
  const YB = 28.0;
  const yw = 18;
  for (const s of [-1, 1]) {
    for (const z of [-1, 1]) {
      const ob = [s * 1.0, yw, z * 1.0];
      const ot = [s * 3.3, YT, z * 0.6];
      const ib = [s * 0.25, yw, z * 1.0];
      const it = [s * 2.2, YB, z * 0.6];
      add(ob, ot, 0.15);
      add(ib, it, 0.12);
      for (let k = 0; k < 5; k++) add(lerp3(ob, ot, k / 5), lerp3(ib, it, (k + 1) / 5), 0.06);
      // outer arm lower chord to the tip, with one web member
      add([s * 3.1, 27.0, z * 0.6], [s * 5.5, YT, z * 0.15], 0.08);
      add([s * 4.3, YT, z * 0.38], [s * 4.3, 27.8, z * 0.38], 0.05);
    }
    for (const t of [0.35, 0.7]) add(lerp3([s, yw, -1], [s * 3.3, YT, -0.6], t), lerp3([s, yw, 1], [s * 3.3, YT, 0.6], t), 0.06);
    // earth-wire peak
    for (const z of [-0.6, 0.6]) for (const xx of [2.2, 3.3]) add([s * xx, YT, z], [s * 2.75, 31.5, 0], 0.08);
    // tapered arm tip
    for (const z of [-1, 1]) add([s * 3.3, YT, z * 0.6], [s * 5.5, YT, z * 0.15], 0.1);
  }
  for (const z of [-0.6, 0.6]) {
    add([-3.3, YT, z], [3.3, YT, z], 0.1);
    add([-2.2, YB, z], [2.2, YB, z], 0.08);
    for (let k = 0; k < 4; k++) {
      const x0 = -2.2 + k * 1.1;
      add([x0, k % 2 ? YB : YT, z], [x0 + 1.1, k % 2 ? YT : YB, z], 0.05);
    }
  }
  for (const x of [-5.0, -4.3, -3.3, -1.1, 1.1, 3.3, 4.3, 5.0]) {
    const zw = Math.abs(x) <= 3.3 ? 0.6 : 0.6 - ((Math.abs(x) - 3.3) / 2.2) * 0.45;
    add([x, YT, -zw], [x, YT, zw], 0.05);
  }
  add([0, YB, -0.6], [0, YB, 0.6], 0.06);
  const g = mergeGeos(P);
  P.forEach((p) => p.dispose());
  return g;
}

// Substation busbar portal: two lattice columns 18 m apart (local Z) with a lattice beam at 10.2..10.8 m.
function portalGeometry() {
  const P = [];
  const add = (a, b, t) => P.push(beam(a[0], a[1], a[2], b[0], b[1], b[2], t));
  const H = 11;
  const C = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  const w = (y) => 0.4 - 0.12 * (y / H);
  for (const zc of [-9, 9]) {
    for (const [sx, sz] of C) add([sx * w(0), 0, zc + sz * w(0)], [sx * w(H), H, zc + sz * w(H)], 0.1);
    const n = 8;
    for (let k = 0; k < n; k++) {
      const y0 = (k * H) / n;
      const y1 = ((k + 1) * H) / n;
      for (let c = 0; c < 4; c++) {
        const a = C[c];
        const b = C[(c + 1) % 4];
        const [p0, p1] = k % 2 ? [a, b] : [b, a];
        add([p0[0] * w(y0), y0, zc + p0[1] * w(y0)], [p1[0] * w(y1), y1, zc + p1[1] * w(y1)], 0.045);
      }
    }
  }
  for (const sx of [-0.28, 0.28]) for (const y of [10.2, 10.8]) add([sx, y, -9.3], [sx, y, 9.3], 0.08);
  for (let k = 0; k < 15; k++) {
    const z0 = -9 + k * 1.2;
    const z1 = z0 + 1.2;
    for (const sx of [-0.28, 0.28]) add([sx, k % 2 ? 10.2 : 10.8, z0], [sx, k % 2 ? 10.8 : 10.2, z1], 0.04);
    add([-0.28, 10.8, z0], [0.28, 10.8, z0], 0.04);
  }
  const g = mergeGeos(P);
  P.forEach((p) => p.dispose());
  return g;
}

// Gable roof (ridge along X), base at y = 0, for a w x d footprint.
function gableRoofGeometry(w, d, rise, overhang = 0.4) {
  const hw = w / 2 + overhang;
  const hd = d / 2 + overhang;
  const ye = (-overhang * rise) / (d / 2);
  const A = [-hw, ye, -hd];
  const Bq = [-hw, rise, 0];
  const Cq = [hw, rise, 0];
  const D = [hw, ye, -hd];
  const A2 = [-hw, ye, hd];
  const D2 = [hw, ye, hd];
  const ex = w / 2;
  const tris = [
    A, Bq, Cq, A, Cq, D, // north slope
    A2, D2, Cq, A2, Cq, Bq, // south slope
    [ex, 0, -d / 2], [ex, rise, 0], [ex, 0, d / 2], // east gable
    [-ex, 0, -d / 2], [-ex, 0, d / 2], [-ex, rise, 0], // west gable
  ];
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(tris.flat()), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(tris.length * 2), 2));
  g.computeVertexNormals();
  return g;
}

// Fence segments around a rectangle with gate gaps. gaps.N/S are x ranges on the z = minZ / maxZ sides,
// gaps.W/E are z ranges on the x = minX / maxX sides.
function fenceSegments(r, gaps = {}) {
  const segs = [];
  const run = (a0, a1, list, mk) => {
    const gs = (list || []).slice().sort((p, q) => p[0] - q[0]);
    let cur = a0;
    for (const [g0, g1] of gs) {
      if (g0 > cur + 0.01) segs.push(mk(cur, Math.min(g0, a1)));
      cur = Math.max(cur, g1);
    }
    if (cur < a1 - 0.01) segs.push(mk(cur, a1));
  };
  run(r.minX, r.maxX, gaps.N, (a, b) => [a, r.minZ, b, r.minZ]);
  run(r.minX, r.maxX, gaps.S, (a, b) => [a, r.maxZ, b, r.maxZ]);
  run(r.minZ, r.maxZ, gaps.W, (a, b) => [r.minX, a, r.minX, b]);
  run(r.minZ, r.maxZ, gaps.E, (a, b) => [r.maxX, a, r.maxX, b]);
  return segs;
}

// ---------------------------------------------------------------- textures (local)

function scrubTexture(seed) {
  const rnd = mulberry32(seed);
  return canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#b59d74';
    c.fillRect(0, 0, w, h);
    speckle(c, w, h, rnd, ['rgba(120,95,60,0.30)', 'rgba(235,220,190,0.22)', 'rgba(140,120,80,0.25)', 'rgba(95,80,55,0.25)'], 9000, 1.6);
    // dry grass tufts and the odd low scrub
    for (let i = 0; i < 160; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      c.strokeStyle = rnd() < 0.5 ? 'rgba(140,135,80,0.55)' : 'rgba(120,110,70,0.5)';
      c.lineWidth = 1;
      c.beginPath();
      for (let k = 0; k < 5; k++) {
        c.moveTo(x, y);
        c.lineTo(x + (rnd() - 0.5) * 6, y - 2 - rnd() * 4);
      }
      c.stroke();
    }
    for (let i = 0; i < 18; i++) {
      c.fillStyle = 'rgba(90,95,55,0.35)';
      c.beginPath();
      c.arc(rnd() * w, rnd() * h, 1.5 + rnd() * 2.5, 0, Math.PI * 2);
      c.fill();
    }
  }, { repeat: [1, 1] });
}

function gravelTexture(seed) {
  const rnd = mulberry32(seed);
  return canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#a29a8b';
    c.fillRect(0, 0, w, h);
    speckle(c, w, h, rnd, ['#8d8576', '#b5ad9e', '#7b7468', '#c4bcae', '#958c7c'], 9000, 1.5);
    speckle(c, w, h, rnd, ['rgba(70,60,50,0.25)'], 600, 2.2);
  }, { repeat: [1, 1] });
}

function chainLinkTexture() {
  return canvasTexture(32, 32, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = 'rgba(178,182,186,1)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(w, h);
    c.moveTo(w, 0);
    c.lineTo(0, h);
    c.stroke();
  }, { repeat: [1, 1] });
}

// Profiled steel cladding with a translucent skylight band near the top (lit at night).
function corrugatedFacade(wall) {
  const W = 256;
  const H = 256;
  const rnd = mulberry32(61);
  const map = canvasTexture(W, H, (c) => {
    c.fillStyle = wall;
    c.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 8) {
      c.fillStyle = 'rgba(0,0,0,0.13)';
      c.fillRect(x, 0, 3, H);
      c.fillStyle = 'rgba(255,255,255,0.10)';
      c.fillRect(x + 4, 0, 2, H);
    }
    speckle(c, W, H, rnd, ['rgba(80,70,60,0.05)', 'rgba(255,255,255,0.04)'], 800, 3);
    c.fillStyle = 'rgba(208,222,230,0.95)';
    c.fillRect(0, H * 0.16, W, H * 0.08);
    c.fillStyle = 'rgba(0,0,0,0.25)';
    for (let x = 0; x < W; x += 32) c.fillRect(x, H * 0.16, 2, H * 0.08);
    c.fillStyle = '#8f8a80';
    c.fillRect(0, H * 0.92, W, H * 0.08);
  });
  const emissiveMap = canvasTexture(W, H, (c) => {
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    c.fillStyle = '#ffe0a8';
    c.fillRect(0, H * 0.16, W, H * 0.08);
  });
  return { map, emissiveMap };
}

// Chimney shaft: concrete with red / white aviation bands over the top third and a sooty lip.
function chimneyTexture() {
  const rnd = mulberry32(77);
  return canvasTexture(16, 256, (c, w, h) => {
    c.fillStyle = '#9b968d';
    c.fillRect(0, 0, w, h);
    speckle(c, w, h, rnd, ['rgba(0,0,0,0.08)', 'rgba(255,255,255,0.06)'], 300, 1.2);
    const bands = 7;
    const bh = (h * 0.36) / bands;
    for (let i = 0; i < bands; i++) {
      c.fillStyle = i % 2 ? '#f2efe8' : '#c4312b';
      c.fillRect(0, i * bh, w, bh + 0.5);
    }
    c.fillStyle = '#2b2725';
    c.fillRect(0, 0, w, 3);
  });
}

// ---------------------------------------------------------------- small props

function pickup(color) {
  const g = new Group();
  const paint = standard(color, { roughness: 0.4, metalness: 0.3 });
  const glass = standard(0x1f2a33, { roughness: 0.2, metalness: 0.5 });
  const tyre = lambert(0x151515);
  const add = (geo, mat, x, y, z, heat) => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.userData.heat = heat;
    g.add(m);
  };
  add(new BoxGeometry(1.9, 0.75, 5.3), paint, 0, 0.8, 0, HEAT.vehicle);
  add(new BoxGeometry(1.88, 0.2, 1.6), paint, 0, 1.275, -1.85, HEAT.engine); // bonnet (front = -Z)
  add(new BoxGeometry(1.84, 0.85, 2.2), glass, 0, 1.6, -0.45, HEAT.vehicle);
  add(new BoxGeometry(1.86, 0.08, 2.1), paint, 0, 2.06, -0.45, HEAT.vehicle);
  for (const s of [-1, 1]) add(new BoxGeometry(0.08, 0.45, 2.0), paint, s * 0.91, 1.4, 1.65, HEAT.vehicle);
  add(new BoxGeometry(1.9, 0.45, 0.08), paint, 0, 1.4, 2.62, HEAT.vehicle);
  const wheel = new CylinderGeometry(0.42, 0.42, 0.3, 14);
  wheel.rotateZ(Math.PI / 2);
  for (const [x, z] of [[-0.9, 1.75], [0.9, 1.75], [-0.9, -1.75], [0.9, -1.75]]) add(wheel, tyre, x, 0.42, z, HEAT.vehicle - 0.1);
  return g;
}

// Cheap smoke plume: <= 40 instanced puffs with a per-instance alpha (one draw call).
function smokePlume(x, y, z, n, seed) {
  const rnd = mulberry32(seed);
  const geo = new IcosahedronGeometry(1, 1);
  const alpha = new Float32Array(n);
  const alphaAttr = new InstancedBufferAttribute(alpha, 1);
  alphaAttr.setUsage(DynamicDrawUsage);
  geo.setAttribute('aAlpha', alphaAttr);
  const mat = new MeshLambertMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = `attribute float aAlpha;\nvarying float vAlpha;\n${sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;')}`;
    sh.fragmentShader = `varying float vAlpha;\n${sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.a *= vAlpha;')}`;
  };
  mat.customProgramCacheKey = () => 'dronosim-smoke-alpha';
  const mesh = new InstancedMesh(geo, mat, n);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 2;
  mesh.userData.heat = 0.5;
  const LIFE = 18;
  const rise = (a) => 0.5 + 1.9 * Math.exp(-a / 4);
  const st = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * LIFE;
    st.push({
      age: a,
      x: x + (rnd() - 0.5) * 0.6,
      y: y + 0.5 * a + 7.6 * (1 - Math.exp(-a / 4)),
      z: z + (rnd() - 0.5) * 0.6,
      dx: (rnd() - 0.5) * 0.5,
      dz: (rnd() - 0.5) * 0.5,
    });
  }
  const c0 = new Color(0xa9a9a9);
  const c1 = new Color(0xeeeeee);
  const col = new Color();
  const m4 = new Matrix4();
  const qI = new Quaternion();
  const pv = new Vector3();
  const sv = new Vector3();
  const write = () => {
    for (let i = 0; i < n; i++) {
      const p = st[i];
      const s = 1.1 + 0.42 * p.age;
      m4.compose(pv.set(p.x, p.y, p.z), qI, sv.set(s, s * 0.85, s));
      mesh.setMatrixAt(i, m4);
      const k = p.age / LIFE;
      mesh.setColorAt(i, col.copy(c0).lerp(c1, Math.min(1, k * 1.6)));
      alpha[i] = Math.min(1, p.age / 1.2) * Math.pow(Math.max(0, 1 - k), 1.4) * 0.55;
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  };
  write();
  return {
    mesh,
    update(dt, wind) {
      const h = Math.min(Math.max(dt || 0, 0), 0.1);
      if (h === 0) return;
      const wx = Number.isFinite(wind.x) ? wind.x : 0;
      const wz = Number.isFinite(wind.z) ? wind.z : 0;
      for (const p of st) {
        p.age += h;
        if (p.age >= LIFE) {
          p.age -= LIFE;
          p.x = x + (rnd() - 0.5) * 0.6;
          p.y = y;
          p.z = z + (rnd() - 0.5) * 0.6;
        }
        const f = Math.min(1, p.age / 2.5);
        p.x += (wx * f + p.dx) * h;
        p.z += (wz * f + p.dz) * h;
        p.y += rise(p.age) * h;
      }
      write();
    },
  };
}

// ---------------------------------------------------------------- scene

export function build(ctx = {}) {
  const quality = ctx.quality || 'high';
  const seed = Number.isFinite(ctx.seed) ? ctx.seed : 1;
  const q = QUALITY_SCALE[quality] ?? 1;
  const root = new Group();
  root.name = 'industrial';
  const obstacles = [];
  const facadeMats = [];
  const wireGeos = [];
  const B = makeBatches();
  const insGeo = insulatorGeometry(7);

  B.def('concrete', lambert(0xb3aea3), HEAT.road);
  B.def('steel', lambert(0x9ca2a8), HEAT.metal);
  B.def('darksteel', lambert(0x5d6268), HEAT.metal);
  B.def('xfmr', lambert(0x7d8a80), HEAT.transformer);
  B.def('fin', lambert(0x748178), 0.82);
  B.def('inverter', lambert(0xe2e4e0), HEAT.transformer);
  B.def('cabinet', lambert(0xc9cdc8), 0.6);
  B.def('combiner', lambert(0xdcdcd4), 0.62);
  B.def('equip', lambert(0x6c7378), 0.55);
  B.def('firewall', lambert(0xa49f95), HEAT.building);
  B.def('door', lambert(0x56606a), HEAT.building);
  B.def('container', lambert(0x2f6f8f), HEAT.metal);
  B.def('ins', lambert(0xd8d2c4), 0.5, { geo: insGeo });
  B.sdef('alu', lambert(0xc6cacd), HEAT.metal + 0.1);
  B.sdef('conservator', lambert(0x7d8a80), HEAT.transformer - 0.15);
  B.sdef('rail', lambert(0x9aa0a5), HEAT.metal, false);

  const box = (name, minX, minZ, maxX, maxZ, h) => obstacles.push({ type: 'box', name, minX, maxX, minZ, maxZ, h });
  const cyl = (name, x, z, r, h) => obstacles.push({ type: 'cyl', name, x, z, r, h });
  const seg = (name, a, b, r) => obstacles.push({ type: 'seg', name, ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, r });

  // Catenary wire (tube) plus two capsule obstacles, like common.js powerLine().
  const addWire = (a, b, sag, r, name) => {
    const span = a.distanceTo(b);
    const d = sag + span * 0.01;
    const mid = a.clone().lerp(b, 0.5);
    mid.y -= d;
    const q1 = a.clone().lerp(mid, 0.5);
    q1.y = (a.y + mid.y) / 2 - d * 0.2;
    const q3 = mid.clone().lerp(b, 0.5);
    q3.y = (b.y + mid.y) / 2 - d * 0.2;
    wireGeos.push(new TubeGeometry(new CatmullRomCurve3([a, q1, mid, q3, b]), 12, r, 4, false));
    seg(name, a, mid, 0.06);
    seg(name, mid, b, 0.06);
  };

  // ------------------------------------------------ ground

  {
    const size = 3000;
    const segs = 60;
    const g = new PlaneGeometry(size, size, segs, segs);
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * size) / 12, (uv.getY(i) * size) / 12);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const nz = makeNoise2D(seed + 11);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const k = 0.92 + nz.fbm(x / 170, z / 170, 3) * 0.2;
      const t = nz.noise(x / 70 + 7.3, z / 70 - 3.1);
      colors[i * 3] = k * (1.0 + t * 0.04);
      colors[i * 3 + 1] = k * (0.98 + t * 0.03);
      colors[i * 3 + 2] = k * 0.95;
    }
    g.setAttribute('color', new BufferAttribute(colors, 3));
    const ground = new Mesh(g, lambert(0xffffff, { map: scrubTexture(seed + 3), vertexColors: true }));
    ground.receiveShadow = true;
    ground.name = 'ground';
    root.add(tagHeat(ground, HEAT.soil));

    // graded soil inside the solar park fence
    const parkGround = new Mesh(rectGeo(PARK.minX, PARK.minZ, PARK.maxX, PARK.maxZ, 0.02, 10),
      flat(0xffffff, { map: soilTexture([1, 1], { base: '#a68e69' }) }));
    parkGround.receiveShadow = true;
    root.add(tagHeat(parkGround, HEAT.soil - 0.02));

    // industrial hardstand
    const hard = new Mesh(rectGeo(IND.minX, IND.minZ, IND.maxX, IND.maxZ, 0.03, 8),
      flat(0xffffff, { map: pavingTexture([1, 1], '#aaa69c') }));
    hard.receiveShadow = true;
    root.add(tagHeat(hard, HEAT.road));

    // gravel: ops yard, substation compound and all site roads in one mesh
    const gravelMat = flat(0xffffff, { map: gravelTexture(seed + 5), polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const gravel = new Group();
    gravel.add(new Mesh(rectGeo(YARD.minX, YARD.minZ, YARD.maxX, YARD.maxZ, 0.05, 8), gravelMat));
    gravel.add(new Mesh(rectGeo(SUB.minX, SUB.minZ, SUB.maxX, SUB.maxZ, 0.05, 8), gravelMat));
    for (const [ax, az, bx, bz, w, y] of GRAVEL_ROADS) gravel.add(strip(ax, az, bx, bz, w, y, gravelMat, w));
    gravel.traverse((o) => {
      if (o.isMesh) {
        o.receiveShadow = true;
        o.userData.heat = HEAT.road - 0.04;
      }
    });
    root.add(compact(gravel));

    // public road along the southern boundary
    const rt = roadTexture({ lanes: 2 });
    rt.wrapS = RepeatWrapping;
    rt.wrapT = RepeatWrapping;
    const [rax, raz, rbx, rbz, rw] = PUBLIC_ROAD;
    root.add(tagHeat(strip(rax, raz, rbx, rbz, rw, 0.06, flat(0xffffff, { map: rt, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), 16), HEAT.road + 0.05));

    root.add(compact(tagHeat(horizonHills({ seed: seed + 99, color: 0x9b8c6a }), HEAT.ground)));
  }

  // ------------------------------------------------ operations yard

  const pad = homePad();
  root.add(compact(pad.group));
  root.add(compact(pilotPost(obstacles, 0, 14)));
  const sock = windsock(obstacles, -16, -12, { height: 6 });
  root.add(sock.group);

  const officeFacade = facadeTexture({ seed: seed + 21, cols: 4, floors: 2, wall: '#ddd5c4', glass: '#3f5568', frame: '#7d776c', litRatio: 0.75 });
  const office = building(obstacles, { ...OFFICE, facade: officeFacade, roofColor: 0x6b6f75, name: 'site office / control room', seed: seed + 22 });
  facadeMats.push(...office.userData.facadeMaterials);
  root.add(compact(office));

  {
    const t = truck(0xd9822b);
    t.position.set(-15, 0, 17);
    t.rotation.y = Math.PI;
    t.traverse((o) => {
      if (o.isMesh && o.userData.heat === undefined) o.userData.heat = HEAT.vehicle - 0.1;
    });
    root.add(compact(t));
    box('maintenance truck', -16.25, 13.4, -13.75, 21.0, 3.2);

    const p = pickup(0xe8e8e6);
    p.position.set(13, 0, 17);
    root.add(compact(p));
    box('pickup', 12.05, 14.35, 13.95, 19.65, 2.1);

    B.box('container', 16, 0, -19, 6.06, 2.6, 2.44);
    box('site store container', 13, -20.2, 19, -17.8, 2.6);
  }

  const yardLights = streetLights(obstacles, [[-24, -21], [22, -21], [22, 21], [-24, 21]].map(([x, z]) => ({ x, z, dir: Math.atan2(-x, -z) })),
    { height: 10, maxLights: 4, lightCentre: { x: 0, z: 0 } });
  root.add(compact(yardLights.group));

  // ------------------------------------------------ solar park

  const nBlocks = Math.min(BLOCK_SLOTS.length, Math.max(4, Math.round(BLOCK_SLOTS.length * q)));
  const blocks = BLOCK_SLOTS.slice(0, nBlocks);
  const panelTex = solarPanelTexture();
  panelTex.wrapS = RepeatWrapping;
  panelTex.wrapT = RepeatWrapping;
  panelTex.repeat.set(TABLE_L / 2, 2);
  const panelMat = standard(0xffffff, { map: panelTex, roughness: 0.38, metalness: 0.15 });
  const panelGeo = new BoxGeometry(TABLE_L, SLAB_T, TABLE_D).rotateX(TILT);
  const frameGeo = tableFrameGeometry();
  const tableItems = [];
  const frameItems = [];
  for (const b of blocks) {
    for (let r = 0; r < ROWS; r++) {
      const z = b.z0 - r * ROW_PITCH;
      for (const off of TABLE_OFFS) {
        tableItems.push({ x: b.cx + off, y: TABLE_YC, z });
        frameItems.push({ x: b.cx + off, y: 0, z });
      }
      for (const s of [-1, 1]) {
        const x0 = b.cx + s * HALF_LANE;
        const x1 = b.cx + s * (HALF_LANE + HALF_W);
        box('solar panel row', Math.min(x0, x1), z - 0.96, Math.max(x0, x1), z + 0.96, 1.7);
      }
      // string combiner boxes on posts at the lane end of every other row
      if (r % 2 === 1) {
        for (const s of [-1, 1]) {
          const x = b.cx + s * 3.3;
          B.box('steel', x, 0, z, 0.08, 1.45, 0.08);
          B.box('combiner', x, 0.75, z + 0.18, 0.7, 0.8, 0.28);
          cyl('combiner box', x, z, 0.45, 1.6);
        }
      }
    }
    // inverter station (inverter container + transformer + RMU on a skid) mid-block in the inner lane
    const x = b.cx;
    const z = b.z0 - 5.5 * ROW_PITCH;
    B.box('concrete', x, 0, z, 3.0, 0.3, 12.0);
    B.box('inverter', x, 0.3, z - 2.6, 2.44, 2.6, 6.06);
    B.box('darksteel', x, 2.9, z - 2.6, 2.5, 0.12, 6.1);
    B.box('xfmr', x, 0.3, z + 2.7, 1.8, 2.0, 2.2);
    for (const s of [-1, 1]) for (let k = 0; k < 8; k++) B.box('fin', x + s * 1.15, 0.5, z + 1.8 + k * 0.26, 0.5, 1.5, 0.05);
    for (let k = 0; k < 3; k++) B.box('ins', x - 0.5 + 0.5 * k, 2.3, z + 2.7, 0.08, 0.45, 0.08);
    B.box('cabinet', x, 0.3, z + 5.0, 1.3, 1.7, 1.0);
    box('inverter station', x - 1.5, z - 6, x + 1.5, z + 6, 3.1);
  }
  root.add(tagHeat(instanced(panelGeo, panelMat, tableItems), HEAT.solar));
  root.add(tagHeat(instanced(frameGeo, lambert(0xa3a9ae), frameItems), HEAT.metal));

  // Hot-spot: one module on one table in a near block, a separate overlay that matches the panel exactly in RGB.
  let hotspot;
  {
    const hr = mulberry32(((seed * 7919) ^ 0x5bd1) >>> 0);
    const hb = blocks[Math.floor(hr() * 4)];
    const hrow = 2 + Math.floor(hr() * 8);
    const hoff = TABLE_OFFS[Math.floor(hr() * 4)];
    const hi = 1 + Math.floor(hr() * 10); // module along the table (0..11)
    const hj = hr() < 0.5 ? 0 : 1; // 0 = upper (north) module row, 1 = lower
    const tx = hb.cx + hoff;
    const tz = hb.z0 - hrow * ROW_PITCH;
    const xm = -TABLE_L / 2 + 2 * hi + 1;
    const zm = -TABLE_D / 4 + (hj * TABLE_D) / 2;
    const g = new PlaneGeometry(2, 1);
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (hi + uv.getX(i)) / (TABLE_L / 2), ((hj === 0 ? 1 : 0) + uv.getY(i)) / 2);
    g.translate(xm, SLAB_T / 2 + 0.004, zm);
    g.rotateX(TILT);
    g.translate(tx, TABLE_YC, tz);
    const hotMat = panelMat.clone();
    hotMat.polygonOffset = true;
    hotMat.polygonOffsetFactor = -1;
    hotMat.polygonOffsetUnits = -1;
    const hot = new Mesh(g, hotMat);
    hot.name = 'panel-hotspot';
    hot.receiveShadow = true;
    root.add(tagHeat(hot, HEAT.hotspot));
    hotspot = { x: tx + xm, z: tz + zm * Math.cos(TILT) };
  }

  // ------------------------------------------------ fences (solar park + substation)

  const fenceDefs = [
    { segs: fenceSegments(PARK, { N: [[-5, 5]], S: [[-122, -114], [-5, 5], [114, 122]] }), h: 2.4, name: 'solar park fence' },
    { segs: fenceSegments(SUB, { W: [[1, 9]] }), h: 2.8, name: 'substation fence' },
  ];
  {
    const posts = [];
    const pos = [];
    const nor = [];
    const uvs = [];
    const idx = [];
    const tile = 0.3;
    for (const f of fenceDefs) {
      for (const [ax, az, bx, bz] of f.segs) {
        const len = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.ceil(len / 3));
        for (let k = 0; k <= n; k++) posts.push({ x: ax + ((bx - ax) * k) / n, y: 0, z: az + ((bz - az) * k) / n, sy: f.h + 0.1 });
        const nx = -(bz - az) / len;
        const nz = (bx - ax) / len;
        const base = pos.length / 3;
        pos.push(ax, 0.05, az, bx, 0.05, bz, bx, f.h, bz, ax, f.h, az);
        for (let k = 0; k < 4; k++) nor.push(nx, 0, nz);
        uvs.push(0, 0, len / tile, 0, len / tile, f.h / tile, 0, f.h / tile);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        B.geo('rail', beam(ax, f.h, az, bx, f.h, bz, 0.025, true));
        box(f.name, Math.min(ax, bx) - 0.12, Math.min(az, bz) - 0.12, Math.max(ax, bx) + 0.12, Math.max(az, bz) + 0.12, f.h);
      }
    }
    const fg = new BufferGeometry();
    fg.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    fg.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
    fg.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    fg.setIndex(idx);
    fg.computeBoundingSphere();
    const mesh = new Mesh(fg, new MeshLambertMaterial({ map: chainLinkTexture(), transparent: true, alphaTest: 0.04, side: DoubleSide, depthWrite: false }));
    root.add(tagHeat(mesh, HEAT.metal - 0.05));
    const postGeo = new CylinderGeometry(0.04, 0.05, 1, 6).translate(0, 0.5, 0);
    root.add(tagHeat(instanced(postGeo, lambert(0x8a8f94), posts), HEAT.metal));
  }

  // ------------------------------------------------ substation (132 / 33 kV)

  const PORTAL_X = [88, 102, 116, 134];
  const PHASE_Z = [SUB_CZ + 5, SUB_CZ, SUB_CZ - 5];
  const BUS_Y = 8.4;
  {
    const portalGeo = portalGeometry();
    root.add(tagHeat(instanced(portalGeo, lambert(0x9ba1a6), PORTAL_X.map((x) => ({ x, y: 0, z: SUB_CZ }))), HEAT.metal));
    for (const x of PORTAL_X) {
      cyl('busbar gantry', x, SUB_CZ - 9, 0.6, 11);
      cyl('busbar gantry', x, SUB_CZ + 9, 0.6, 11);
      seg('busbar gantry beam', { x, y: 10.5, z: SUB_CZ - 9.3 }, { x, y: 10.5, z: SUB_CZ + 9.3 }, 0.5);
      for (const z of PHASE_Z) {
        B.box('ins', x, BUS_Y + 0.05, z, 0.15, 1.7, 0.15);
        seg('insulator string', { x, y: BUS_Y, z }, { x, y: 10.2, z }, 0.2);
      }
    }
    for (const z of PHASE_Z) {
      B.geo('alu', beam(PORTAL_X[0], BUS_Y, z, PORTAL_X[PORTAL_X.length - 1], BUS_Y, z, 0.06, true));
      seg('busbar', { x: PORTAL_X[0], y: BUS_Y, z }, { x: PORTAL_X[PORTAL_X.length - 1], y: BUS_Y, z }, 0.15);
    }

    // switchgear bays under the busbars: disconnector, circuit breaker, current transformer per phase
    const BAYS = [95, 109, 123];
    for (const xb of BAYS) {
      for (const z of PHASE_Z) {
        for (const dx of [-4.2, -2.8]) {
          B.box('steel', xb + dx, 0, z, 0.3, 2.5, 0.3);
          B.box('ins', xb + dx, 2.5, z, 0.14, 1.4, 0.14);
        }
        B.box('steel', xb - 3.5, 3.88, z, 1.6, 0.07, 0.07);
        B.box('steel', xb, 0, z, 0.45, 2.2, 0.45);
        B.box('cabinet', xb + 0.55, 0.6, z, 0.6, 1.0, 0.7);
        B.box('ins', xb, 2.2, z, 0.24, 2.0, 0.24);
        B.box('equip', xb, 4.2, z, 0.55, 0.5, 0.55);
        B.box('steel', xb + 3.5, 0, z, 0.35, 2.3, 0.35);
        B.box('ins', xb + 3.5, 2.3, z, 0.2, 1.6, 0.2);
        B.box('equip', xb + 3.5, 3.9, z, 0.6, 0.7, 0.6);
        addWire(new Vector3(xb, 4.7, z), new Vector3(xb + 0.6, BUS_Y - 0.06, z), 0.05, 0.025, 'substation jumper');
      }
      box('substation switchgear', xb - 4.6, SUB_CZ - 5.6, xb + 4.6, SUB_CZ + 5.6, 4.8);
    }

    // power transformers with radiator banks, conservator and bushings; fire walls between them
    const TZ = 17;
    for (const xt of BAYS) {
      B.box('concrete', xt, 0, TZ, 7.4, 0.4, 5.6);
      B.box('xfmr', xt, 0.4, TZ, 5.0, 3.4, 2.6);
      B.box('xfmr', xt, 3.8, TZ, 5.2, 0.15, 2.8);
      for (const s of [-1, 1]) {
        const zf = TZ + s * 1.85;
        for (let k = 0; k < 15; k++) B.box('fin', xt - 2.1 + k * 0.3, 0.8, zf, 0.05, 2.6, 1.1);
        B.box('fin', xt, 3.35, zf, 4.6, 0.14, 0.2);
        B.box('fin', xt, 0.75, zf, 4.6, 0.14, 0.2);
      }
      B.geo('conservator', beam(xt - 1.2, 5.0, TZ + 0.9, xt + 1.8, 5.0, TZ + 0.9, 0.45, true));
      for (const dx of [-0.8, 1.4]) B.box('steel', xt + dx, 3.95, TZ + 0.9, 0.1, 0.65, 0.1);
      for (let k = 0; k < 3; k++) {
        const bx = xt - 1.5 + 1.5 * k;
        B.box('ins', bx, 3.95, TZ - 0.6, 0.2, 2.2, 0.2); // HV bushing
        B.box('ins', xt - 1.2 + 1.2 * k, 3.95, TZ + 0.1, 0.14, 0.9, 0.14); // LV bushing
        addWire(new Vector3(bx, BUS_Y - 0.06, PHASE_Z[k]), new Vector3(bx, 6.15, TZ - 0.6), 0.3, 0.03, 'transformer dropper');
      }
      B.box('cabinet', xt + 3.1, 0.4, TZ + 1.6, 0.8, 1.5, 0.5);
      box('power transformer', xt - 3.7, TZ - 2.8, xt + 3.7, TZ + 2.8, 6.4);
    }
    for (const xw of [102, 116]) {
      B.box('firewall', xw, 0, TZ, 0.4, 7.0, 6.5);
      box('fire wall', xw - 0.2, TZ - 3.25, xw + 0.2, TZ + 3.25, 7.0);
    }

    const ctrlFacade = facadeTexture({ seed: seed + 31, cols: 3, floors: 1, wall: '#d6d0c2', glass: '#3c5263', litRatio: 0.6 });
    const ctrl = building(obstacles, { x: 89, z: -17.5, w: 12, d: 7, h: 4.5, facade: ctrlFacade, roofColor: 0x6b6f75, name: 'substation control building', seed: seed + 32 });
    facadeMats.push(...ctrl.userData.facadeMaterials);
    root.add(compact(ctrl));
  }
  const subLights = streetLights(obstacles, [[83.5, 22.5], [136.5, 22.5], [136.5, -20.5], [100, -20.5]].map(([x, z]) => ({ x, z, dir: Math.atan2(110 - x, SUB_CZ - z) })),
    { height: 9, maxLights: 1, lightCentre: { x: 110, z: SUB_CZ } });
  root.add(compact(subLights.group));

  // ------------------------------------------------ 132 kV transmission line

  const beaconSpots = [];
  const tpts = TOWERS.map(([x, z]) => ({ x, z }));
  const tdirs = lineDirs(tpts);
  {
    const hv = powerLine(obstacles, tpts, { height: HV_HEIGHT, wires: 3, spread: HV_SPREAD, sag: 1.2, lattice: true, poleColor: 0x8d9297, name: '132 kV line' });
    // The helper's simple wireframe poles and single cross-arm are replaced by full lattice towers below.
    for (const o of [...hv.children]) {
      if (o.isMesh && (o.material.wireframe || o.geometry.type === 'BoxGeometry')) {
        hv.remove(o);
        o.geometry.dispose();
        o.material.dispose();
      }
    }
    root.add(compact(hv));

    const towerGeo = latticeTowerGeometry();
    root.add(tagHeat(instanced(towerGeo, lambert(0x8d9297), tpts.map((p, i) => ({ x: p.x, y: 0, z: p.z, ry: tdirs[i] }))), HEAT.metal));
    const yAtt = HV_HEIGHT - 0.25;
    tpts.forEach((p, i) => {
      const ry = tdirs[i];
      const pp = perpOf(ry);
      const at = (off, y) => ({ x: p.x + pp.x * off, y, z: p.z + pp.z * off });
      cyl('132 kV tower', p.x, p.z, 4.3, 5);
      cyl('132 kV tower', p.x, p.z, 3.4, 31.5);
      seg('132 kV tower cross-arm', at(-5.6, 28.3), at(5.6, 28.3), 0.5);
      for (const off of [-HV_SPREAD, 0, HV_SPREAD]) {
        const top = off === 0 ? 28.0 : 28.6;
        B.box('ins', p.x + pp.x * off, yAtt, p.z + pp.z * off, 0.16, top - yAtt, 0.16);
        if (off !== 0) seg('132 kV insulator', at(off, yAtt), at(off, top), 0.25);
      }
      // leg foundations
      const c = Math.cos(ry);
      const s = Math.sin(ry);
      for (const [lx, lz] of [[3, 3], [3, -3], [-3, -3], [-3, 3]]) B.box('concrete', p.x + c * lx + s * lz, 0, p.z - s * lx + c * lz, 0.9, 0.35, 0.9, ry);
      beaconSpots.push(at(2.75, 31.75));
    });
    // two earth wires between the peaks
    for (let i = 0; i < tpts.length - 1; i++) {
      for (const sgn of [-1, 1]) {
        const pa = perpOf(tdirs[i]);
        const pb = perpOf(tdirs[i + 1]);
        const a = new Vector3(tpts[i].x + pa.x * 2.75 * sgn, 31.5, tpts[i].z + pa.z * 2.75 * sgn);
        const b = new Vector3(tpts[i + 1].x + pb.x * 2.75 * sgn, 31.5, tpts[i + 1].z + pb.z * 2.75 * sgn);
        addWire(a, b, 0.8, 0.02, '132 kV earth wire');
      }
    }
    // down-leads from the terminal tower into the substation entry gantry
    const p0 = tpts[0];
    const pp0 = perpOf(tdirs[0]);
    for (const off of [-HV_SPREAD, 0, HV_SPREAD]) {
      const a = new Vector3(p0.x + pp0.x * off, yAtt, p0.z + pp0.z * off);
      const zg = SUB_CZ + Math.round((pp0.z * off) / HV_SPREAD) * 5;
      addWire(a, new Vector3(PORTAL_X[PORTAL_X.length - 1] + 0.3, 10.5, zg), 0.3, 0.025, '132 kV down-lead');
    }
  }

  // ------------------------------------------------ 33 kV collector line

  {
    const cpts = C_POLES.map(([x, z]) => ({ x, z }));
    const cdirs = lineDirs(cpts);
    const mv = powerLine(obstacles, cpts, { height: 12, wires: 3, spread: 1.1, sag: 0.4, poleColor: 0xb1aca3, name: '33 kV line' });
    fixArms(mv, cpts, cdirs);
    root.add(compact(mv));
    cpts.forEach((p, i) => {
      const pp = perpOf(cdirs[i]);
      for (const off of [-1.1, 0, 1.1]) B.box('ins', p.x + pp.x * off, 11.62, p.z + pp.z * off, 0.08, 0.38, 0.08);
    });
    // cable riser on the terminal pole (the line continues underground into the substation)
    const last = cpts[cpts.length - 1];
    B.box('darksteel', last.x + 0.25, 0, last.z, 0.12, 11.6, 0.12);
  }

  // ------------------------------------------------ industrial estate (south-west)

  {
    const wf = corrugatedFacade('#b9bfc4');
    const whs = [
      { x: -95, z: 75, w: 70, d: 34, h: 12, rise: 2.5, doors: [-115, -95, -75], seed: 41 },
      { x: -185, z: 75, w: 56, d: 34, h: 10, rise: 2.2, doors: [-197, -173], seed: 42 },
    ];
    for (const wh of whs) {
      const g = building(obstacles, { x: wh.x, z: wh.z, w: wh.w, d: wh.d, h: wh.h, facade: wf, roofColor: 0x8f969c, rooftop: false, name: 'warehouse', seed: seed + wh.seed });
      obstacles[obstacles.length - 1].h = wh.h + wh.rise;
      facadeMats.push(...g.userData.facadeMaterials);
      const roof = new Mesh(gableRoofGeometry(wh.w, wh.d, wh.rise), lambert(0x9aa1a6, { side: DoubleSide }));
      roof.position.y = wh.h;
      roof.castShadow = true;
      roof.receiveShadow = true;
      g.add(tagHeat(roof, HEAT.roof));
      root.add(compact(g));
      for (const dx of wh.doors) B.box('door', dx, 0, wh.z - wh.d / 2 - 0.1, 5, 5.5, 0.2);
    }
    const t = truck(0x2f6b3a);
    t.position.set(-75, 0, 53);
    t.rotation.y = Math.PI;
    t.traverse((o) => {
      if (o.isMesh && o.userData.heat === undefined) o.userData.heat = HEAT.vehicle - 0.1;
    });
    root.add(compact(t));
    box('delivery truck', -76.25, 49.4, -73.75, 57.0, 3.2);

    // boiler house, flue duct and the chimney stack
    const boiler = building(obstacles, { x: -102, z: CHIMNEY.z, w: 14, d: 12, h: 9, wallColor: 0xb7b0a3, roofColor: 0x6e6a64, name: 'boiler house', seed: seed + 43 });
    root.add(compact(boiler));
    B.box('darksteel', -113.6, 5.9, CHIMNEY.z, 9.2, 1.2, 1.2);
    seg('flue duct', { x: -109, y: 6.5, z: CHIMNEY.z }, { x: -118.3, y: 6.5, z: CHIMNEY.z }, 0.7);

    const chimGeo = new CylinderGeometry(1.5, 2.3, CHIMNEY.h, 24);
    chimGeo.translate(0, CHIMNEY.h / 2, 0);
    const chim = new Mesh(chimGeo, lambert(0xffffff, { map: chimneyTexture() }));
    chim.position.set(CHIMNEY.x, 0, CHIMNEY.z);
    chim.castShadow = true;
    chim.receiveShadow = true;
    root.add(tagHeat(chim, 0.7));
    const gallery = new CylinderGeometry(2.55, 2.55, 0.25, 24);
    gallery.translate(CHIMNEY.x, 37.8, CHIMNEY.z);
    B.geo('rail', gallery);
    B.box('concrete', CHIMNEY.x, 0, CHIMNEY.z, 6, 0.8, 6);
    cyl('chimney stack', CHIMNEY.x, CHIMNEY.z, 2.6, CHIMNEY.h + 0.5);
    beaconSpots.push({ x: CHIMNEY.x + 1.45, y: CHIMNEY.h + 0.3, z: CHIMNEY.z });

    // tank farm with a bund wall
    const tanks = [
      { x: -215, z: 135, r: 9, h: 13 }, { x: -190, z: 135, r: 9, h: 13 },
      { x: -215, z: 162, r: 7, h: 10 }, { x: -190, z: 162, r: 7, h: 10 },
    ];
    const shellGeo = new CylinderGeometry(1, 1, 1, 32).translate(0, 0.5, 0);
    const roofGeo = new ConeGeometry(1, 1, 32).translate(0, 0.5, 0);
    root.add(tagHeat(instanced(shellGeo, lambert(0xffffff), tanks.map((tk, i) => ({ x: tk.x, y: 0, z: tk.z, sx: tk.r, sy: tk.h, sz: tk.r, color: i % 2 ? 0xe6e6e1 : 0xdcdcd6 }))), 0.45));
    root.add(tagHeat(instanced(roofGeo, lambert(0xc9cdce), tanks.map((tk) => ({ x: tk.x, y: tk.h, z: tk.z, sx: tk.r, sy: tk.r * 0.15, sz: tk.r }))), HEAT.roof - 0.05));
    for (const tk of tanks) cyl('storage tank', tk.x, tk.z, tk.r, tk.h + tk.r * 0.15);
    const bund = { minX: -228, maxX: -177, minZ: 122, maxZ: 173 };
    const bw = bund.maxX - bund.minX;
    const bd = bund.maxZ - bund.minZ;
    const bcx = (bund.minX + bund.maxX) / 2;
    const bcz = (bund.minZ + bund.maxZ) / 2;
    B.box('concrete', bcx, 0, bund.minZ, bw, 1.2, 0.3);
    B.box('concrete', bcx, 0, bund.maxZ, bw, 1.2, 0.3);
    B.box('concrete', bund.minX, 0, bcz, 0.3, 1.2, bd);
    B.box('concrete', bund.maxX, 0, bcz, 0.3, 1.2, bd);
    box('bund wall', bund.minX, bund.minZ - 0.15, bund.maxX, bund.minZ + 0.15, 1.2);
    box('bund wall', bund.minX, bund.maxZ - 0.15, bund.maxX, bund.maxZ + 0.15, 1.2);
    box('bund wall', bund.minX - 0.15, bund.minZ, bund.minX + 0.15, bund.maxZ, 1.2);
    box('bund wall', bund.maxX - 0.15, bund.minZ, bund.maxX + 0.15, bund.maxZ, 1.2);
  }

  const plume = smokePlume(CHIMNEY.x, CHIMNEY.h + 0.3, CHIMNEY.z, 36, seed + 51);
  root.add(plume.mesh);

  // ------------------------------------------------ aircraft-warning beacons

  const beaconMat = new MeshStandardMaterial({ color: 0x400000, emissive: new Color(0xff1a1a), emissiveIntensity: 0.5 });
  root.add(tagHeat(instanced(new IcosahedronGeometry(1, 1), beaconMat, beaconSpots.map((p) => ({ x: p.x, y: p.y, z: p.z, sx: 0.35, sy: 0.35, sz: 0.35 })), { castShadow: false }), HEAT.light));

  // ------------------------------------------------ batched props and merged wires

  B.build(root);
  if (wireGeos.length) {
    const wm = new Mesh(mergeGeos(wireGeos), new MeshBasicMaterial({ color: 0x1a1a1a }));
    for (const g of wireGeos) g.dispose();
    root.add(tagHeat(wm, HEAT.metal + 0.1));
  }

  // ------------------------------------------------ vegetation and rocks (outside the fences)

  const keepOut = [
    [-250, -245, 250, -22], // solar park, perimeter road, collector line
    [-45, -32, 35, 32], // ops yard
    [70, -30, 150, 34], // substation
    [-260, 34, -40, 200], // industrial estate
  ];
  const roadsAll = [...GRAVEL_ROADS, PUBLIC_ROAD];
  const isClear = (x, z, m) => {
    if (Math.hypot(x, z) < 40) return false;
    for (const [x0, z0, x1, z1] of keepOut) if (x > x0 - m && x < x1 + m && z > z0 - m && z < z1 + m) return false;
    for (const [ax, az, bx, bz, w] of roadsAll) if (distSeg(x, z, ax, az, bx, bz) < w / 2 + 2 + m) return false;
    for (let i = 0; i < TOWERS.length - 1; i++) if (distSeg(x, z, TOWERS[i][0], TOWERS[i][1], TOWERS[i + 1][0], TOWERS[i + 1][1]) < 14 + m) return false;
    return true;
  };
  const vr = mulberry32(seed + 501);
  const scatter = (n, margin, mk) => {
    const out = [];
    for (let tries = 0; out.length < n && tries < n * 40; tries++) {
      const x = (vr() * 2 - 1) * 320;
      const z = (vr() * 2 - 1) * 320;
      if (isClear(x, z, margin)) out.push(mk(x, z));
    }
    return out;
  };
  const treeSpots = scatter(Math.round(70 * q), 4, (x, z) => ({ x, z, s: 0.55 + vr() * 0.4, kind: 'broad' }));
  const tr = trees(obstacles, treeSpots, { seed: seed + 17, crownTint: 0x6f7b3f });
  root.add(tr.group);
  const bushSpots = scatter(Math.round(260 * q), 1, (x, z) => ({ x, z, s: 0.5 + vr() * 0.8 }));
  if (bushSpots.length) root.add(bushes(bushSpots, { seed: seed + 23 }));
  const rockSpots = scatter(Math.round(140 * q), 0.5, (x, z) => ({ x, z, s: 0.3 + vr() * 0.7 }));
  if (rockSpots.length) root.add(rocks(rockSpots, { seed: seed + 29, color: 0x9a8e7c }));

  // Helper-built structures without an explicit thermal tag (posts, arms, canopy, windsock) read as metal.
  root.traverse((o) => {
    if (o.isMesh && o.userData.heat === undefined) o.userData.heat = o.material.isMeshBasicMaterial ? HEAT.road : HEAT.metal;
  });

  // ------------------------------------------------ interface

  let night = 0;
  let time = 0;
  const _w = new Vector3();
  const _w2 = new Vector3();
  const rectLoop = (r) => [[r.minX, r.minZ], [r.maxX, r.minZ], [r.maxX, r.maxZ], [r.minX, r.maxZ], [r.minX, r.minZ]];

  return {
    root,
    obstacles,
    groundHeight: () => 0,
    pilot: { x: 0, z: 14 },
    patterns: false,
    swayMaterials: tr.swayMaterials,
    setNight(k) {
      night = Math.min(1, Math.max(0, k || 0));
      pad.setNight(night);
      yardLights.setNight(night);
      subLights.setNight(night);
      lightWindows(facadeMats, night);
    },
    update(dt, t, windAt) {
      time = Number.isFinite(t) ? t : time + (dt || 0);
      let wind = _w2.set(0, 0, 0);
      if (typeof windAt === 'function') {
        const ws = windAt(sock.sample.x, sock.sample.y, sock.sample.z, _w);
        if (ws) sock.update(dt || 0, ws);
        wind = windAt(CHIMNEY.x, CHIMNEY.h + 5, CHIMNEY.z, _w2) || _w2;
      }
      // ~40 flashes per minute
      const on = time % 1.5 < 0.55;
      beaconMat.emissiveIntensity = on ? 0.8 + night * 3.5 : 0.06;
      plume.update(dt, wind);
    },
    mapExtent: 320,
    mapPaint(c, toPx, mpp = 1) {
      const px = (m) => Math.max(1, m / (mpp || 1));
      paintRect(c, toPx, -340, -340, 340, 340, '#bca57c');
      paintRect(c, toPx, PARK.minX, PARK.minZ, PARK.maxX, PARK.maxZ, '#ab9671');
      paintRect(c, toPx, IND.minX, IND.minZ, IND.maxX, IND.maxZ, '#aba79f');
      paintRect(c, toPx, YARD.minX, YARD.minZ, YARD.maxX, YARD.maxZ, '#a29b8e');
      paintRect(c, toPx, SUB.minX, SUB.minZ, SUB.maxX, SUB.maxZ, '#9a9892');
      for (const [ax, az, bx, bz, w] of GRAVEL_ROADS) paintPolyline(c, toPx, [[ax, az], [bx, bz]], '#a0978a', px(w));
      paintPolyline(c, toPx, [[PUBLIC_ROAD[0], PUBLIC_ROAD[1]], [PUBLIC_ROAD[2], PUBLIC_ROAD[3]]], '#4b4e53', px(PUBLIC_ROAD[4]));
      for (const b of blocks) {
        for (const s of [-1, 1]) {
          paintRect(c, toPx, b.cx + s * HALF_LANE, b.z0 + 1, b.cx + s * (HALF_LANE + HALF_W), b.z0 - (ROWS - 1) * ROW_PITCH - 1, '#22396b');
        }
      }
      const dashed = typeof c.setLineDash === 'function';
      if (dashed) c.setLineDash([4, 3]);
      paintPolyline(c, toPx, rectLoop(PARK), 'rgba(240,236,228,0.85)', 1);
      paintPolyline(c, toPx, rectLoop(SUB), 'rgba(240,236,228,0.85)', 1);
      if (dashed) c.setLineDash([]);
      paintPolyline(c, toPx, TOWERS, 'rgba(210,60,50,0.9)', 1.5);
      paintPolyline(c, toPx, C_POLES, 'rgba(225,140,50,0.9)', 1);
    },
    poi: [
      { name: 'Control room', x: OFFICE.x, z: OFFICE.z },
      { name: 'Substation', x: 110, z: SUB_CZ },
      { name: 'Transmission line', x: TOWERS[1][0], z: TOWERS[1][1] },
      { name: 'Chimney stack', x: CHIMNEY.x, z: CHIMNEY.z },
      { name: 'Panel hot-spot (inspection target)', x: hotspot.x, z: hotspot.z, hidden: true },
    ],
    dispose() {
      disposeTree(root);
    },
  };
}
