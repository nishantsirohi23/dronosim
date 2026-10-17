// Farmland: a North-Indian agricultural landscape for agricultural spray-drone training.
//
// Layout (metres, +X east, -Z north, home pad at the origin):
//   - village road (paved, east-west) at z = +22 with an 11 kV line on its south side (z = +27.5)
//   - dirt cart track north-south at x = +18.75, crossing a raised, concrete-lined canal at z = -132.5
//   - farm compound (farmhouse, cattle shed, haystacks) west of the gravel yard that holds the pad
//   - tube-well pump house fed by an LT line along the bund at x = -120
//   - village cluster with a water tower and pond to the south-east (x 102..228, z 33..128)
//   - patchwork of wheat, paddy, mustard, sugarcane, ploughed, fallow, fodder and stubble fields
// groundHeight is 0 everywhere; bunds, canal banks and crops are visual only.

import {
  BoxGeometry, BufferGeometry, CircleGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, Float32BufferAttribute,
  Group, Mesh, MeshLambertMaterial, MeshStandardMaterial, PlaneGeometry, PointLight, RingGeometry, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  HEAT, QUALITY_SCALE, building, bushes, canvasTexture, car, cropTexture, disposeTree, flat, grassTexture, homePad,
  horizonHills, instanced, lambert, makeNoise2D, mulberry32, paintPolyline, paintRect, person, pilotPost, powerLine,
  soilTexture, speckle, standard, strip, tagHeat, trees, truck, windsock,
} from './common.js';

const ROAD_Z = 22;
const ROAD_W = 9; // asphalt 5.4 m plus dirt shoulders
const POLE_Z = 27.5;
const TRACK_X = 18.75;
const TRACK_W = 3.5;
const CANAL_Z = -132.5;
const FAR = 1600; // length of road / canal / track beyond the field area
const CANE_H = 2.7;
const COMPOUND = { minX: -50, maxX: 16.5, minZ: -31, maxZ: 17.5 };
const YARD = { minX: -15, maxX: 15, minZ: -16, maxZ: 16 };
const VILLAGE = { minX: 102, maxX: 228, minZ: 33, maxZ: 128 };
const GROVE = { minX: -260, maxX: -170, minZ: 33, maxZ: 120 };
const POND = { x: 210, z: 45, r: 11 };
const WATER_TOWER = { x: 122, z: 108 };
const FARMHOUSE = { x: -32, z: 0, w: 12, d: 9, h: 3.4 };
const PUMP = { x: -125.5, z: -46, w: 3.6, d: 3.2, h: 2.9 };
const TRACTOR = { x: -78, z: -96, ry: -Math.PI / 2 };
const LT_X = -120;
const CHANNEL_Z = -61;

const CROPS = {
  wheat: { label: 'wheat', map: '#cdb25c', heat: HEAT.vegetation + 0.08, tile: 3, tex: () => cropTexture([1, 1], { soil: '#8c7040', plant: '#dcbc5e', plant2: '#c7a24a', rows: 12, density: 1.8 }) },
  paddy: { label: 'paddy', map: '#5e9f47', heat: HEAT.water + 0.04, tile: 2.4, shiny: true, tex: () => cropTexture([1, 1], { soil: '#4d5d4b', plant: '#5c9e34', plant2: '#7ab643', rows: 12, density: 0.7 }) },
  mustard: { label: 'mustard', map: '#e6cb2a', heat: HEAT.vegetation, tile: 3, tex: () => cropTexture([1, 1], { soil: '#64802e', plant: '#f2d322', plant2: '#e3bf1a', rows: 10, density: 1.5 }) },
  fodder: { label: 'fodder', map: '#62a33c', heat: HEAT.vegetation - 0.02, tile: 2.5, tex: () => cropTexture([1, 1], { soil: '#4c6a2a', plant: '#6cad3a', plant2: '#86c44c', rows: 16, density: 1.6 }) },
  stubble: { label: 'stubble', map: '#c2ab76', heat: HEAT.soil - 0.04, tile: 3, tex: () => cropTexture([1, 1], { soil: '#a08856', plant: '#d8c58e', plant2: '#bda76e', rows: 14, density: 0.45 }) },
  ploughed: { label: 'ploughed', map: '#7a5a3c', heat: HEAT.soil, tile: 3.2, rowsU: true, tex: () => soilTexture([1, 1], { base: '#7b5a3d', rows: 8, rowColor: '#583d29' }) },
  fallow: { label: 'fallow', map: '#86914f', heat: HEAT.vegetation + 0.06, tile: 8, tint: [1, 0.96, 0.72], tex: () => grassTexture([1, 1]) },
  cane: { label: 'sugarcane', map: '#3d7a2e', heat: HEAT.vegetation - 0.03, tile: 2.5, block: true, tex: () => cropTexture([1, 1], { soil: '#2f5422', plant: '#5f9a3a', plant2: '#7fb04c', rows: 6, density: 2.2 }) },
};
const RANDOM_CROPS = [['wheat', 0.3], ['paddy', 0.14], ['mustard', 0.11], ['ploughed', 0.13], ['fallow', 0.08], ['fodder', 0.09], ['stubble', 0.11], ['cane', 0.04]];

const WALL_COLORS = [0xece6d6, 0xe3c98f, 0xd9a090, 0xb9cfe0, 0xc7d9a8, 0xf0ead8, 0xd8b4c8, 0xe0d0a8];
const HOUSES = [
  { x: 152, z: 40, w: 9, d: 8, h: 3.3, front: 'px' },
  { x: 151.5, z: 54, w: 10, d: 9, h: 6.4, front: 'px' },
  { x: 152.5, z: 66, w: 8, d: 8, h: 3.3, front: 'px' },
  { x: 151.5, z: 88, w: 10, d: 9, h: 3.3, front: 'px' },
  { x: 152, z: 102, w: 9, d: 8, h: 6.4, front: 'px' },
  { x: 168, z: 42, w: 9, d: 9, h: 3.3, front: 'nx' },
  { x: 169, z: 57, w: 11, d: 8, h: 6.4, front: 'nx' },
  { x: 168, z: 89, w: 9, d: 8, h: 3.3, front: 'nx' },
  { x: 167.5, z: 103, w: 8, d: 8, h: 3.3, front: 'nx' },
  { x: 132, z: 68, w: 9, d: 8, h: 3.3, front: 'pz' },
  { x: 190, z: 68, w: 10, d: 8, h: 3.3, front: 'pz' },
  { x: 192, z: 86, w: 9, d: 9, h: 6.4, front: 'nz' },
];
const FACES = { px: [1, 0], nx: [-1, 0], pz: [0, 1], nz: [0, -1] };

const _w = new Vector3();

// ---------------------------------------------------------------- geometry batching

class Batch {
  constructor() {
    this.p = [];
    this.n = [];
    this.uv = [];
    this.c = [];
    this.i = [];
  }

  get count() {
    return this.p.length / 3;
  }

  vert(x, y, z, nx, ny, nz, u, v, r = 1, g = 1, b = 1) {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.uv.push(u, v);
    this.c.push(r, g, b);
  }

  tri(a, b, c) {
    this.i.push(a, b, c);
  }

  mesh(material, heat, { cast = false } = {}) {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    const m = new Mesh(g, material);
    m.receiveShadow = true;
    m.castShadow = cast;
    if (heat !== undefined) m.userData.heat = heat;
    return m;
  }
}

// Flat rectangle on the ground, subdivided so vertex colours can carry low-frequency variation.
// UVs are world metres / tile; crop rows run along v, so alongX puts v on the X axis.
function addGroundRect(b, x0, z0, x1, z1, y, { tile = 4, alongX = false, uo = 0, vo = 0, tint = null, shade = 1, noise = null, seg = 30 } = {}) {
  const nx = Math.max(1, Math.ceil((x1 - x0) / seg));
  const nzs = Math.max(1, Math.ceil((z1 - z0) / seg));
  const base = b.count;
  for (let j = 0; j <= nzs; j++) {
    const z = z0 + ((z1 - z0) * j) / nzs;
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      const n = noise ? noise(x, z) : 0;
      const k = Math.min(1.08, Math.max(0.72, shade * (1 + 0.24 * n)));
      b.vert(x, y, z, 0, 1, 0, (alongX ? z : x) / tile + uo, (alongX ? x : z) / tile + vo,
        (tint ? tint[0] : 1) * k, (tint ? tint[1] : 1) * k, (tint ? tint[2] : 1) * k);
    }
  }
  for (let j = 0; j < nzs; j++) {
    for (let i = 0; i < nx; i++) {
      const a = base + j * (nx + 1) + i;
      const c = a + nx + 1;
      b.tri(a, c, a + 1);
      b.tri(a + 1, c, c + 1);
    }
  }
}

// Four outward-facing walls of an axis-aligned block (sugarcane stands). v runs 0 (ground) .. 1 (top).
function addBlockSides(b, x0, z0, x1, z1, h, tileU) {
  const ring = [[x0, z1], [x1, z1], [x1, z0], [x0, z0], [x0, z1]];
  for (let s = 0; s < 4; s++) {
    const [ax, az] = ring[s];
    const [bx, bz] = ring[s + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const nx = -(bz - az) / len;
    const nz = (bx - ax) / len;
    const base = b.count;
    const u1 = len / tileU;
    b.vert(ax, 0, az, nx, 0, nz, 0, 0, 0.5, 0.5, 0.5);
    b.vert(bx, 0, bz, nx, 0, nz, u1, 0, 0.5, 0.5, 0.5);
    b.vert(bx, h, bz, nx, 0, nz, u1, 1);
    b.vert(ax, h, az, nx, 0, nz, 0, 1);
    b.tri(base, base + 1, base + 2);
    b.tri(base, base + 2, base + 3);
  }
}

// Extrude a (z, y) profile, ordered north to south, along X (canal banks).
function addPrismX(b, profile, x0, x1, tile = 6) {
  let acc = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const [za, ya] = profile[i];
    const [zb, yb] = profile[i + 1];
    const seg = Math.hypot(zb - za, yb - ya) || 1;
    const ny = (zb - za) / seg;
    const nz = -(yb - ya) / seg;
    const base = b.count;
    b.vert(x0, ya, za, 0, ny, nz, x0 / tile, acc / tile);
    b.vert(x1, ya, za, 0, ny, nz, x1 / tile, acc / tile);
    b.vert(x1, yb, zb, 0, ny, nz, x1 / tile, (acc + seg) / tile);
    b.vert(x0, yb, zb, 0, ny, nz, x0 / tile, (acc + seg) / tile);
    b.tri(base, base + 2, base + 1);
    b.tri(base, base + 3, base + 2);
    acc += seg;
  }
}

// ---------------------------------------------------------------- static merge (draw-call reduction)

function matKey(m) {
  if (m.userData.keep) return m.uuid;
  return [
    m.type, m.color ? m.color.getHexString() : '', m.emissive ? m.emissive.getHexString() : '', m.emissiveIntensity ?? '',
    m.map ? m.map.uuid : '', m.emissiveMap ? m.emissiveMap.uuid : '', m.side, m.transparent, m.opacity, m.flatShading,
    m.wireframe, m.vertexColors, m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits, m.depthWrite,
    m.roughness ?? '', m.metalness ?? '',
  ].join('|');
}

function pieceGeometry(geo, start, count, matrix) {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const total = src.attributes.position.count;
  const s = Math.max(0, start);
  const e = Math.min(total, start + count);
  const out = new BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = src.attributes[name];
    if (a) out.setAttribute(name, new Float32BufferAttribute(a.array.slice(s * a.itemSize, e * a.itemSize), a.itemSize));
  }
  if (src !== geo) src.dispose();
  if (!out.attributes.normal) out.computeVertexNormals();
  if (!out.attributes.uv) out.setAttribute('uv', new Float32BufferAttribute(new Float32Array((e - s) * 2), 2));
  out.applyMatrix4(matrix);
  return out;
}

// Bakes every plain mesh under `src` into one mesh per (material signature, heat). Lights, instanced
// meshes and meshes flagged userData.noMerge are re-parented unchanged. Materials flagged
// userData.keep (night lights) are never swapped for an equivalent one.
function mergeStatic(src) {
  const out = new Group();
  out.name = 'farm-static';
  src.updateMatrixWorld(true);
  const buckets = new Map();
  const extras = [];
  const oldGeos = new Set();
  src.traverse((o) => {
    if (o === src) return;
    if (o.isMesh && !o.isInstancedMesh && !o.userData.noMerge) {
      const geo = o.geometry;
      let pieces;
      if (Array.isArray(o.material)) {
        pieces = geo.groups.length ? geo.groups.map((gr) => [o.material[gr.materialIndex], gr.start, gr.count]) : [[o.material[0], 0, Infinity]];
      } else {
        pieces = [[o.material, 0, Infinity]];
      }
      for (const [mat, start, count] of pieces) {
        if (!mat) continue;
        const heat = o.userData.heat;
        const key = `${matKey(mat)}#${heat ?? 'u'}`;
        let b = buckets.get(key);
        if (!b) {
          b = { mat, heat, geos: [], cast: false, mats: new Set() };
          buckets.set(key, b);
        }
        b.geos.push(pieceGeometry(geo, start, count, o.matrixWorld));
        b.cast = b.cast || o.castShadow;
        b.mats.add(mat);
      }
      oldGeos.add(geo);
    } else if (o.isLight || o.isInstancedMesh || o.isMesh) {
      extras.push(o);
    }
  });
  for (const o of extras) out.attach(o);
  const used = new Set();
  const all = new Set();
  for (const b of buckets.values()) {
    for (const m of b.mats) all.add(m);
    const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    const geos = merged ? [merged] : b.geos;
    if (merged && b.geos.length > 1) for (const g of b.geos) g.dispose();
    for (const g of geos) {
      const mesh = new Mesh(g, b.mat);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = true;
      if (b.heat !== undefined) mesh.userData.heat = b.heat;
      out.add(mesh);
    }
    used.add(b.mat);
  }
  for (const m of all) if (!used.has(m)) m.dispose();
  for (const g of oldGeos) g.dispose();
  return out;
}

// ---------------------------------------------------------------- textures

function patchworkTexture(seed) {
  const rnd = mulberry32(seed);
  const pal = ['#8e8a4f', '#7b8a46', '#a5934f', '#6d8040', '#86704a', '#999a55', '#74863f', '#b19b59', '#68783a', '#8b6c4a', '#c2ab52'];
  return canvasTexture(1024, 1024, (ctx, w, h) => {
    ctx.fillStyle = '#6f6f45';
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h;) {
      const rh = Math.min(h - y, 50 + rnd() * 110);
      for (let x = 0; x < w;) {
        const rw = Math.min(w - x, 50 + rnd() * 120);
        ctx.fillStyle = pal[Math.floor(rnd() * pal.length)];
        ctx.fillRect(x + 1, y + 1, Math.max(0, rw - 2), Math.max(0, rh - 2));
        ctx.fillStyle = 'rgba(0,0,0,0.05)';
        if (rnd() < 0.5) for (let k = x + 3; k < x + rw - 2; k += 4) ctx.fillRect(k, y + 1, 1, Math.max(0, rh - 2));
        else for (let k = y + 3; k < y + rh - 2; k += 4) ctx.fillRect(x + 1, k, Math.max(0, rw - 2), 1);
        x += rw;
      }
      y += rh;
    }
    speckle(ctx, w, h, rnd, ['rgba(0,0,0,0.06)', 'rgba(255,255,240,0.05)'], 9000, 2);
    for (let i = 0; i < 70; i++) {
      const cx = rnd() * w;
      const cy = rnd() * h;
      const n = 2 + Math.floor(rnd() * 6);
      for (let k = 0; k < n; k++) {
        ctx.fillStyle = rnd() < 0.5 ? '#36502a' : '#2e4624';
        ctx.beginPath();
        ctx.arc(cx + (rnd() - 0.5) * 18, cy + (rnd() - 0.5) * 18, 2 + rnd() * 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, { repeat: [5, 5] });
}

// u across the road (asphalt in the middle 60 %, dusty shoulders), v along it.
function villageRoadTexture() {
  const rnd = mulberry32(41);
  return canvasTexture(128, 256, (ctx, w, h) => {
    ctx.fillStyle = '#9b8562';
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rnd, ['rgba(80,60,40,0.25)', 'rgba(210,190,160,0.2)', 'rgba(95,115,60,0.3)'], 2200, 2);
    const a0 = Math.round(w * 0.2);
    const a1 = Math.round(w * 0.8);
    ctx.fillStyle = '#4b4c4d';
    ctx.fillRect(a0, 0, a1 - a0, h);
    ctx.save();
    ctx.translate(a0, 0);
    speckle(ctx, a1 - a0, h, rnd, ['#55575a', '#414244', '#5d5f61', '#3a3b3d'], 2600, 1.4);
    ctx.fillStyle = 'rgba(40,40,40,0.35)';
    for (let i = 0; i < 6; i++) ctx.fillRect(rnd() * (a1 - a0 - 20), rnd() * h, 8 + rnd() * 16, 6 + rnd() * 14);
    ctx.restore();
    ctx.fillStyle = '#9b8562';
    for (let y = 0; y < h; y += 3) {
      ctx.fillRect(a0 - 1, y, rnd() * 4, 3);
      const e = rnd() * 4;
      ctx.fillRect(a1 + 1 - e, y, e, 3);
    }
  }, { repeat: [1, 1] });
}

function trackTexture() {
  const rnd = mulberry32(42);
  return canvasTexture(64, 128, (ctx, w, h) => {
    ctx.fillStyle = '#8d6f4c';
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rnd, ['rgba(60,40,25,0.25)', 'rgba(220,200,170,0.18)'], 900, 1.5);
    ctx.fillStyle = 'rgba(95,70,45,0.6)';
    ctx.fillRect(w * 0.2, 0, w * 0.13, h);
    ctx.fillRect(w * 0.67, 0, w * 0.13, h);
    ctx.fillStyle = 'rgba(100,122,62,0.55)';
    for (let i = 0; i < 140; i++) ctx.fillRect(w * 0.4 + rnd() * w * 0.2, rnd() * h, 1.5, 2 + rnd() * 3);
    for (let i = 0; i < 90; i++) ctx.fillRect(rnd() < 0.5 ? rnd() * w * 0.12 : w - rnd() * w * 0.12, rnd() * h, 1.5, 2 + rnd() * 3);
  }, { repeat: [1, 1] });
}

function earthTexture() {
  const rnd = mulberry32(51);
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#a58b66';
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rnd, ['rgba(90,65,40,0.18)', 'rgba(230,215,185,0.16)', 'rgba(120,100,70,0.2)'], 5000, 2.2);
    speckle(ctx, w, h, rnd, ['rgba(95,110,55,0.35)'], 160, 3);
  }, { repeat: [1, 1] });
}

function gravelTexture() {
  const rnd = mulberry32(52);
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#bba887';
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rnd, ['#a8957a', '#cbbb9e', '#9a8a74', '#d6c9b0', '#8f8170'], 9000, 1.3);
  }, { repeat: [1, 1] });
}

function brickTexture() {
  const rnd = mulberry32(53);
  return canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#6e5b4a';
    ctx.fillRect(0, 0, w, h);
    const bw = 8;
    const bh = 4;
    for (let r = 0; r < h / bh; r++) {
      for (let x = (r % 2) * (bw / 2) - bw; x < w; x += bw) {
        const l = 0.8 + rnd() * 0.35;
        ctx.fillStyle = `rgb(${Math.round(160 * l)},${Math.round(92 * l)},${Math.round(64 * l)})`;
        ctx.fillRect(x + 0.5, r * bh + 0.5, bw - 1, bh - 1);
      }
    }
    speckle(ctx, w, h, rnd, ['rgba(0,0,0,0.12)', 'rgba(210,190,160,0.15)'], 600, 2);
  }, { repeat: [1, 1] });
}

function caneSideTexture() {
  const rnd = mulberry32(54);
  return canvasTexture(128, 128, (ctx, w, h) => {
    const gr = ctx.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#5d8f35');
    gr.addColorStop(0.45, '#3f6a27');
    gr.addColorStop(1, '#4a4a2a');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 3 + rnd() * 4) {
      ctx.fillStyle = rnd() < 0.5 ? 'rgba(150,160,80,0.55)' : 'rgba(110,120,60,0.5)';
      ctx.fillRect(x, h * 0.35, 1.5, h * 0.65);
    }
    for (let i = 0; i < 170; i++) {
      const x = rnd() * w;
      const y = rnd() * h * 0.6;
      ctx.strokeStyle = rnd() < 0.5 ? '#6fa23e' : '#4f8030';
      ctx.lineWidth = 1 + rnd() * 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rnd() - 0.5) * 30, y + 6 + rnd() * 20);
      ctx.stroke();
    }
  }, { repeat: [1, 1] });
}

function strawTexture() {
  const rnd = mulberry32(55);
  return canvasTexture(64, 64, (ctx, w, h) => {
    ctx.fillStyle = '#c8a95e';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      ctx.strokeStyle = rnd() < 0.5 ? 'rgba(120,90,40,0.45)' : 'rgba(240,215,140,0.5)';
      ctx.lineWidth = 1;
      const x = rnd() * w;
      const y = rnd() * h;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rnd() - 0.5) * 10, y + (rnd() - 0.5) * 6);
      ctx.stroke();
    }
  }, { repeat: [1, 1] });
}

// ---------------------------------------------------------------- small structures

// Pick a building() seed that gives the wanted rooftop tank and no AC units (mirrors building()'s rnd order).
function houseSeed(base, wantTank) {
  for (let s = base; s < base + 400; s++) {
    const r = mulberry32(s);
    const tank = r() < 0.7;
    if (tank !== wantTank) continue;
    if (tank) {
      r();
      r();
      r();
    }
    if (Math.floor(r() * 4) === 0) return s;
  }
  return base;
}

// Doors, windows and a door lamp on an axis-aligned building. Quads sit 3 cm proud of the walls.
function addOpenings(dst, b, front, rnd, M, { lamp = true, sideWindows = true } = {}) {
  const floors = Math.max(1, Math.round(b.h / 3.2));
  for (const key of Object.keys(FACES)) {
    const [fx, fz] = FACES[key];
    const half = fx ? b.w / 2 : b.d / 2;
    const len = fx ? b.d : b.w;
    const cx = b.x + fx * (half + 0.03);
    const cz = b.z + fz * (half + 0.03);
    const tx = -fz;
    const tz = fx;
    const ry = Math.atan2(fx, fz);
    const place = (mat, w, h, s, y, out = 0) => {
      const m = new Mesh(out ? new BoxGeometry(w, h, 0.14) : new PlaneGeometry(w, h), mat);
      m.position.set(cx + tx * s + fx * out, y, cz + tz * s + fz * out);
      m.rotation.y = ry;
      dst.add(m);
      return m;
    };
    for (let fl = 0; fl < floors; fl++) {
      const y = 1.55 + fl * 3.2;
      if (key === front) {
        if (fl === 0) {
          place(rnd() < 0.5 ? M.door : M.door2, 1.1, 2.1, 0, 1.05);
          if (lamp) tagHeat(place(M.lamp, 0.22, 0.12, 0, 2.42, 0.08), HEAT.light);
        } else {
          place(rnd() < 0.5 ? M.lit : M.dark, 1.0, 1.1, 0, y);
        }
        if (len >= 6) for (const s of [-len * 0.3, len * 0.3]) place(rnd() < 0.5 ? M.lit : M.dark, 1.0, 1.1, s, y);
      } else if (sideWindows && len > 5 && rnd() < 0.8) {
        place(rnd() < 0.35 ? M.lit : M.dark, 0.9, 1.0, (rnd() - 0.5) * len * 0.4, y);
      }
    }
  }
}

// Box obstacle for a rectangle given in local coordinates of an object rotated by ry about Y.
function pushRotBox(obstacles, name, x, z, ry, lx0, lx1, lz0, lz1, h) {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const lx of [lx0, lx1]) {
    for (const lz of [lz0, lz1]) {
      const wx = x + lx * c + lz * s;
      const wz = z - lx * s + lz * c;
      minX = Math.min(minX, wx);
      maxX = Math.max(maxX, wx);
      minZ = Math.min(minZ, wz);
      maxZ = Math.max(maxZ, wz);
    }
  }
  obstacles.push({ type: 'box', name, minX, maxX, minZ, maxZ, h });
}

// Tractor with a two-wheel trolley. Local -Z is forward; the trolley trails towards +Z.
function tractor() {
  const g = new Group();
  const red = standard(0xb3232a, { roughness: 0.5 });
  const dark = lambert(0x2b2b2b);
  const tyre = lambert(0x161616);
  const rim = lambert(0xd8b030);
  const add = (geo, mat, x, y, z, heat, rx = 0) => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.castShadow = true;
    if (heat !== undefined) m.userData.heat = heat;
    g.add(m);
    return m;
  };
  add(new BoxGeometry(0.85, 0.75, 1.7), red, 0, 1.15, -1.05, HEAT.engine);
  add(new BoxGeometry(0.8, 0.6, 0.06), dark, 0, 1.1, -1.92, HEAT.engine);
  add(new BoxGeometry(0.9, 0.6, 1.0), red, 0, 0.95, 0.25, HEAT.vehicle);
  for (const sx of [-1, 1]) add(new BoxGeometry(0.5, 0.1, 1.35), red, sx * 0.9, 1.6, 0.45, HEAT.vehicle);
  add(new BoxGeometry(0.5, 0.1, 0.45), dark, 0, 1.5, 0.55, HEAT.vehicle);
  add(new BoxGeometry(0.5, 0.4, 0.08), dark, 0, 1.72, 0.8, HEAT.vehicle);
  add(new CylinderGeometry(0.03, 0.03, 0.6, 6), dark, 0, 1.65, -0.25, HEAT.vehicle, -0.5);
  add(new CylinderGeometry(0.2, 0.2, 0.04, 14), dark, 0, 1.92, -0.12, HEAT.vehicle, -0.5);
  add(new CylinderGeometry(0.05, 0.05, 0.9, 8), dark, 0.3, 1.95, -1.5, HEAT.engine);
  const rear = new CylinderGeometry(0.78, 0.78, 0.42, 18);
  rear.rotateZ(Math.PI / 2);
  const rearRim = new CylinderGeometry(0.42, 0.42, 0.44, 12);
  rearRim.rotateZ(Math.PI / 2);
  const front = new CylinderGeometry(0.42, 0.42, 0.24, 14);
  front.rotateZ(Math.PI / 2);
  for (const sx of [-1, 1]) {
    add(rear, tyre, sx * 0.92, 0.78, 0.45, HEAT.metal);
    add(rearRim, rim, sx * 0.92, 0.78, 0.45, HEAT.metal);
    add(front, tyre, sx * 0.72, 0.42, -1.55, HEAT.metal);
  }
  // Trolley.
  const blue = lambert(0x50678a);
  add(new BoxGeometry(0.12, 0.12, 1.2), dark, 0, 0.62, 1.55, HEAT.metal);
  add(new BoxGeometry(2.1, 0.1, 3.8), blue, 0, 0.95, 3.95, HEAT.metal);
  for (const sx of [-1, 1]) add(new BoxGeometry(0.06, 0.6, 3.8), blue, sx * 1.05, 1.3, 3.95, HEAT.metal);
  for (const z of [2.05, 5.85]) add(new BoxGeometry(2.1, 0.6, 0.06), blue, 0, 1.3, z, HEAT.metal);
  add(new BoxGeometry(2.0, 0.45, 3.7), lambert(0xc9a85c, { map: strawTexture() }), 0, 1.2, 3.95, HEAT.soil);
  const tw = new CylinderGeometry(0.48, 0.48, 0.3, 14);
  tw.rotateZ(Math.PI / 2);
  for (const sx of [-1, 1]) add(tw, tyre, sx * 1.0, 0.48, 3.95, HEAT.metal);
  return g;
}

// Zebu cow or water buffalo, grazing. Local -Z is forward.
function cow(color, { buffalo = false } = {}) {
  const g = new Group();
  const m = lambert(color);
  const add = (geo, x, y, z, rx = 0) => {
    const o = new Mesh(geo, m);
    o.position.set(x, y, z);
    o.rotation.x = rx;
    o.castShadow = true;
    g.add(o);
  };
  const bw = buffalo ? 0.72 : 0.55;
  add(new BoxGeometry(bw, 0.62, 1.5), 0, 1.0, 0);
  if (!buffalo) add(new BoxGeometry(0.3, 0.22, 0.32), 0, 1.38, -0.5);
  add(new BoxGeometry(0.3, 0.34, 0.55), 0, 1.0, -0.95, 0.75);
  for (const sx of [-1, 1]) {
    add(new ConeGeometry(0.035, buffalo ? 0.3 : 0.22, 5), sx * 0.12, 1.22, -0.92, buffalo ? 1.2 : -0.3);
    for (const sz of [-1, 1]) add(new CylinderGeometry(0.06, 0.05, 0.72, 6), sx * (bw / 2 - 0.08), 0.36, sz * 0.58);
  }
  add(new CylinderGeometry(0.025, 0.02, 0.7, 4), 0, 0.85, 0.78, 0.2);
  return tagHeat(g, HEAT.person - 0.04);
}

// ---------------------------------------------------------------- layout

function pickCrop(rnd) {
  let r = rnd();
  for (const [type, w] of RANDOM_CROPS) {
    r -= w;
    if (r <= 0) return type;
  }
  return 'wheat';
}

function layoutFields(rnd) {
  const cells = [];
  const add = (x0, x1, z0, z1, o = {}) => cells.push({ x0, x1, z0, z1, ...o });
  const NC = [[-350, -262], [-260, -177], [-175, -121], [-119, -52], [-50, 16.5], [21, 100], [102, 190], [192, 270], [272, 350]];
  // North of the road, first row (compound, spray target, tube-well gap at x -131..-119).
  NC.forEach(([x0, x1], i) => {
    if (i === 2) add(x0, -131, -60, 12.5);
    else if (i === 4) add(x0, x1, -60, -34, { fixed: 'fodder', noSplit: true });
    else if (i === 5) add(x0, x1, -60, 12.5, { fixed: 'mustard', noSplit: true, target: true });
    else add(x0, x1, -60, 12.5);
  });
  [[-124, -62], [-235, -141], [-350, -237]].forEach(([z0, z1], r) => {
    NC.forEach(([x0, x1], i) => {
      const o = {};
      if (r === 0 && i === 3) Object.assign(o, { fixed: 'ploughed', noSplit: true, tractor: true });
      if (r === 0 && i === 7) o.fixed = 'cane';
      if (r === 1 && i === 1) o.fixed = 'cane';
      if (r === 0 && i === 0) o.fixed = 'paddy';
      add(x0, x1, z0, z1, o);
    });
  });
  // South of the road: mango grove and village take two cells of the first row.
  const SC = [[-350, -262], [-260, -170], [-168, -90], [-88, 16.5], [21, 100], [102, 190], [192, 270], [272, 350]];
  SC.forEach(([x0, x1], i) => {
    if (i === 1 || i === 5 || i === 7) return;
    if (i === 6) add(230, 350, 33, 120, { fixed: 'wheat' });
    else if (i === 3) add(x0, x1, 33, 120, { fixed: 'stubble' });
    else add(x0, x1, 33, 120);
  });
  [[122, 230], [232, 350]].forEach(([z0, z1], r) => {
    SC.forEach(([x0, x1], i) => {
      const o = {};
      if (r === 0 && i === 5) o.fixed = 'cane';
      add(x0, x1, r === 0 && (i === 5 || i === 6) ? 130 : z0, z1, o);
    });
  });

  const fields = [];
  for (const c of cells) {
    const w = c.x1 - c.x0;
    const d = c.z1 - c.z0;
    const parts = [];
    if (!c.noSplit && Math.max(w, d) > 75 && rnd() < 0.4) {
      const f = 0.4 + rnd() * 0.2;
      if (w >= d) {
        const xm = Math.round((c.x0 + w * f) * 2) / 2;
        parts.push([c.x0, xm, c.z0, c.z1], [xm, c.x1, c.z0, c.z1]);
      } else {
        const zm = Math.round((c.z0 + d * f) * 2) / 2;
        parts.push([c.x0, c.x1, c.z0, zm], [c.x0, c.x1, zm, c.z1]);
      }
    } else {
      parts.push([c.x0, c.x1, c.z0, c.z1]);
    }
    parts.forEach(([x0, x1, z0, z1], k) => {
      const type = k === 0 && c.fixed ? c.fixed : pickCrop(rnd);
      const fw = x1 - x0;
      const fd = z1 - z0;
      fields.push({
        x0, x1, z0, z1, type,
        alongX: fw > fd ? rnd() < 0.8 : rnd() < 0.2,
        target: !!c.target && k === 0,
        tractor: !!c.tractor && k === 0,
        uo: rnd(), vo: rnd(), shade: 0.93 + rnd() * 0.12,
      });
    });
  }
  return fields;
}

// ---------------------------------------------------------------- build

export function build(ctx = {}) {
  const quality = ctx.quality in QUALITY_SCALE ? ctx.quality : 'high';
  const q = QUALITY_SCALE[quality];
  const seed = Number.isFinite(ctx.seed) ? ctx.seed : 1;
  const rnd = mulberry32((seed * 7919 + 101) >>> 0);
  const root = new Group();
  root.name = 'farmland';
  const obstacles = [];
  const swayMaterials = [];
  const S = new Group(); // static props, merged by material at the end
  const groundHeight = () => 0;
  const noise = makeNoise2D(seed + 17);
  const nz = (x, z) => noise.fbm(x * 0.012, z * 0.012, 3);

  // ------------------------------------------------ ground
  const groundGeo = new PlaneGeometry(4000, 4000);
  groundGeo.rotateX(-Math.PI / 2);
  const ground = new Mesh(groundGeo, lambert(0xffffff, { map: patchworkTexture(seed + 3) }));
  ground.receiveShadow = true;
  ground.name = 'ground';
  root.add(tagHeat(ground, HEAT.ground));

  // Grass-and-earth margin under the field patchwork (shows in the gaps between fields).
  const under = new Batch();
  addGroundRect(under, -362, -362, 362, 362, 0.006, { tile: 6, noise: nz, seg: 60 });
  root.add(under.mesh(flat(0xd8cf9e, { map: grassTexture([1, 1]), vertexColors: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), HEAT.vegetation + 0.05));

  // ------------------------------------------------ fields
  const fields = layoutFields(rnd);
  const fieldBatches = {};
  for (const f of fields) {
    const def = CROPS[f.type];
    if (def.block) continue;
    const b = (fieldBatches[f.type] ||= new Batch());
    addGroundRect(b, f.x0, f.z0, f.x1, f.z1, 0.02, {
      tile: def.tile, alongX: def.rowsU ? !f.alongX : f.alongX, uo: f.uo, vo: f.vo, tint: def.tint, shade: f.shade, noise: nz, seg: 30,
    });
  }
  for (const [type, b] of Object.entries(fieldBatches)) {
    const def = CROPS[type];
    const map = def.tex();
    const mat = def.shiny
      ? standard(0xffffff, { map, vertexColors: true, roughness: 0.36, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
      : flat(0xffffff, { map, vertexColors: true });
    const m = b.mesh(mat, def.heat);
    m.name = `field-${type}`;
    root.add(m);
  }

  // Sugarcane: raised 2.7 m textured blocks with leaf tufts poking out of the canopy (crops, not obstacles).
  const caneFields = fields.filter((f) => f.type === 'cane');
  if (caneFields.length) {
    const top = new Batch();
    const sides = new Batch();
    const leaves = [];
    for (const f of caneFields) {
      addGroundRect(top, f.x0, f.z0, f.x1, f.z1, CANE_H, { tile: CROPS.cane.tile, alongX: f.alongX, uo: f.uo, vo: f.vo, shade: f.shade, noise: nz, seg: 30 });
      addBlockSides(sides, f.x0, f.z0, f.x1, f.z1, CANE_H, 2.0);
      const n = Math.min(1600, Math.round((((f.x1 - f.x0) * (f.z1 - f.z0)) / 5) * q));
      for (let i = 0; i < n; i++) {
        leaves.push({
          x: f.x0 + rnd() * (f.x1 - f.x0), y: CANE_H - 0.55, z: f.z0 + rnd() * (f.z1 - f.z0),
          sx: 1, sy: 0.9 + rnd() * 0.7, sz: 1, ry: rnd() * Math.PI * 2,
          color: new Color().setHSL(0.24 + rnd() * 0.06, 0.45, 0.25 + rnd() * 0.12),
        });
      }
    }
    const heat = CROPS.cane.heat;
    root.add(top.mesh(lambert(0xffffff, { map: CROPS.cane.tex(), vertexColors: true }), heat, { cast: true }));
    root.add(sides.mesh(lambert(0xffffff, { map: caneSideTexture(), vertexColors: true }), heat, { cast: true }));
    const leafGeo = new PlaneGeometry(0.18, 1);
    leafGeo.translate(0, 0.5, 0);
    leafGeo.rotateX(0.5);
    const leafMat = lambert(0xffffff, { side: DoubleSide });
    root.add(tagHeat(instanced(leafGeo, leafMat, leaves, { castShadow: false }), heat));
    swayMaterials.push(leafMat);
  }

  // Earthen bunds (0.45 m wide, 0.28 m high) along every field edge; shared edges are emitted once.
  const bundItems = [];
  const seen = new Set();
  const addBund = (ax, az, bx, bz) => {
    const key = [ax, az, bx, bz].map((v) => v.toFixed(1)).join(',');
    if (seen.has(key)) return;
    seen.add(key);
    if (az === bz) bundItems.push({ x: (ax + bx) / 2, y: 0, z: az, sx: Math.abs(bx - ax) + 0.45, sy: 0.28, sz: 0.45 });
    else bundItems.push({ x: ax, y: 0, z: (az + bz) / 2, sx: 0.45, sy: 0.28, sz: Math.abs(bz - az) + 0.45 });
  };
  for (const f of fields) {
    addBund(f.x0, f.z0, f.x1, f.z0);
    addBund(f.x0, f.z1, f.x1, f.z1);
    addBund(f.x0, f.z0, f.x0, f.z1);
    addBund(f.x1, f.z0, f.x1, f.z1);
  }
  const bundGeo = new BoxGeometry(1, 1, 1);
  bundGeo.translate(0, 0.5, 0);
  root.add(tagHeat(instanced(bundGeo, lambert(0x857b55), bundItems, { castShadow: false }), HEAT.soil));

  // ------------------------------------------------ roads, track, yard, village ground
  const road = strip(-FAR, ROAD_Z, FAR, ROAD_Z, ROAD_W, 0.015, flat(0xffffff, { map: villageRoadTexture() }), 18);
  root.add(tagHeat(road, HEAT.road));
  const trackMat = flat(0xffffff, { map: trackTexture() });
  S.add(tagHeat(strip(TRACK_X, -FAR, TRACK_X, ROAD_Z - ROAD_W / 2, TRACK_W, 0.015, trackMat, 7), HEAT.soil));
  S.add(tagHeat(strip(TRACK_X, ROAD_Z + ROAD_W / 2, TRACK_X, FAR, TRACK_W, 0.015, trackMat, 7), HEAT.soil));

  const earth = new Batch();
  addGroundRect(earth, COMPOUND.minX, COMPOUND.minZ, COMPOUND.maxX, COMPOUND.maxZ, 0.012, { tile: 8, noise: nz, seg: 30 });
  addGroundRect(earth, VILLAGE.minX, VILLAGE.minZ, VILLAGE.maxX, VILLAGE.maxZ, 0.012, { tile: 8, noise: nz, seg: 30 });
  root.add(earth.mesh(flat(0xffffff, { map: earthTexture(), vertexColors: true }), HEAT.soil));
  const yard = new Batch();
  addGroundRect(yard, YARD.minX, YARD.minZ, YARD.maxX, YARD.maxZ, 0.016, { tile: 6 });
  root.add(yard.mesh(flat(0xffffff, { map: gravelTexture(), vertexColors: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), HEAT.soil + 0.03));

  const laneMat = flat(0xffffff, { map: brickTexture(), polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  S.add(tagHeat(strip(160, ROAD_Z + ROAD_W / 2, 160, VILLAGE.maxZ - 2, 4, 0.018, laneMat, 4), HEAT.road - 0.04));
  S.add(tagHeat(strip(106, 76, 158, 76, 3.5, 0.018, laneMat, 4), HEAT.road - 0.04));
  S.add(tagHeat(strip(162, 76, 226, 76, 3.5, 0.018, laneMat, 4), HEAT.road - 0.04));

  // ------------------------------------------------ water: canal, field channel, pond
  const waterMat = standard(0x3f6f78, { roughness: 0.18, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const banks = new Batch();
  addPrismX(banks, [[CANAL_Z - 4.5, 0], [CANAL_Z - 3.0, 0.55], [CANAL_Z - 1.95, 0.55]], -FAR, FAR);
  addPrismX(banks, [[CANAL_Z + 1.95, 0.55], [CANAL_Z + 3.0, 0.55], [CANAL_Z + 4.5, 0]], -FAR, FAR);
  root.add(banks.mesh(lambert(0xc8bd8f, { map: grassTexture([1, 1]), vertexColors: true }), HEAT.ground));
  const concrete = lambert(0xaaa69b);
  for (const sz of [-1, 1]) {
    const wall = new Mesh(new BoxGeometry(2 * FAR, 0.4, 0.2), concrete);
    wall.position.set(0, 0.45, CANAL_Z + sz * 1.85);
    S.add(tagHeat(wall, HEAT.road - 0.05));
  }
  const canalWater = new Mesh(new PlaneGeometry(2 * FAR, 3.5).rotateX(-Math.PI / 2), waterMat);
  canalWater.position.set(0, 0.42, CANAL_Z);
  S.add(tagHeat(canalWater, HEAT.water));
  // Field channel from the tube-well tank along the bund between the first two field rows.
  S.add(tagHeat(strip(-122.4, -49.6, -122.4, CHANNEL_Z, 0.6, 0.03, waterMat, 4), HEAT.water));
  S.add(tagHeat(strip(-122.7, CHANNEL_Z, -52, CHANNEL_Z, 0.6, 0.03, waterMat, 4), HEAT.water));
  // Village pond with a muddy bank.
  const pond = new Mesh(new CircleGeometry(POND.r, 32).rotateX(-Math.PI / 2), waterMat);
  pond.position.set(POND.x, 0.025, POND.z);
  S.add(tagHeat(pond, HEAT.water));
  const pondBank = new Mesh(new RingGeometry(POND.r, POND.r + 2.5, 32).rotateX(-Math.PI / 2), flat(0x6e5a40, { polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  pondBank.position.set(POND.x, 0.022, POND.z);
  S.add(tagHeat(pondBank, HEAT.soil - 0.08));

  // Culvert bridge where the cart track crosses the canal.
  {
    const deck = new Mesh(new BoxGeometry(4.6, 0.3, 9.2), concrete);
    deck.position.set(TRACK_X, 0.8, CANAL_Z);
    deck.castShadow = true;
    S.add(tagHeat(deck, HEAT.road));
    const para = lambert(0xbdb8ac);
    for (const sx of [-1, 1]) {
      const p = new Mesh(new BoxGeometry(0.25, 0.55, 9.2), para);
      p.position.set(TRACK_X + sx * 2.18, 1.225, CANAL_Z);
      p.castShadow = true;
      S.add(tagHeat(p, HEAT.road));
      obstacles.push({ type: 'box', name: 'culvert parapet', minX: TRACK_X + sx * 2.18 - 0.13, maxX: TRACK_X + sx * 2.18 + 0.13, minZ: CANAL_Z - 4.6, maxZ: CANAL_Z + 4.6, h: 1.5 });
    }
    const a = Math.atan2(0.95, 4.1);
    const rampMat = lambert(0x8d6f4c);
    for (const sz of [-1, 1]) {
      const r = new Mesh(new BoxGeometry(3.6, 0.3, 4.4), rampMat);
      r.position.set(TRACK_X, 0.33, CANAL_Z + sz * 6.65);
      r.rotation.x = sz * a; // high end towards the deck
      S.add(tagHeat(r, HEAT.soil));
    }
  }

  // ------------------------------------------------ home pad, pilot post, windsock
  const pad = homePad({ size: 6, y: 0.02 });
  pad.group.traverse((o) => {
    if (o.isMesh && o.material.map) {
      o.material.polygonOffsetFactor = -4;
      o.material.polygonOffsetUnits = -4;
    }
  });
  S.add(pad.group);
  S.add(pilotPost(obstacles, 0, 14));
  const sock = windsock(obstacles, -14, 10, { height: 6 });
  root.add(sock.group);

  // Night materials (never merged with look-alikes so setNight can drive them).
  const M = {
    door: lambert(0x5a3b22, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
    door2: lambert(0x3b5f7a, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
    dark: lambert(0x2b2f35, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
    lit: new MeshLambertMaterial({ color: 0x2b2f35, emissive: new Color(0xffc46e), emissiveIntensity: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
    lamp: new MeshStandardMaterial({ color: 0x555555, emissive: new Color(0xffd28a), emissiveIntensity: 0 }),
  };
  M.lit.userData.keep = true;
  M.lamp.userData.keep = true;
  const nightLights = [];

  // ------------------------------------------------ farm compound
  const fh = FARMHOUSE;
  const farmhouse = building(obstacles, { x: fh.x, z: fh.z, w: fh.w, d: fh.d, h: fh.h, wallColor: 0xece4d2, roofColor: 0x8f8a80, name: 'farmhouse', seed: houseSeed(700, true) });
  S.add(farmhouse);
  addTankStand(farmhouse, fh.h);
  addOpenings(S, fh, 'px', rnd, M);
  {
    // Veranda on the yard side.
    const postMat = lambert(0xd8d2c4);
    for (const z of [-4.2, 0, 4.2]) {
      const p = new Mesh(new CylinderGeometry(0.12, 0.12, 2.75, 8), postMat);
      p.position.set(fh.x + fh.w / 2 + 2.6, 1.375, fh.z + z);
      S.add(tagHeat(p, HEAT.building));
    }
    const slab = new Mesh(new BoxGeometry(3.1, 0.16, 9.4), lambert(0x9a958c));
    slab.position.set(fh.x + fh.w / 2 + 1.5, 2.83, fh.z);
    slab.castShadow = true;
    S.add(tagHeat(slab, HEAT.roof));
    obstacles.push({ type: 'box', name: 'veranda', minX: fh.x + fh.w / 2, maxX: fh.x + fh.w / 2 + 3.05, minZ: fh.z - 4.7, maxZ: fh.z + 4.7, h: 2.95 });
    const porch = new PointLight(0xffc98a, 0, 20, 2);
    porch.position.set(fh.x + fh.w / 2 + 1.4, 2.55, fh.z);
    S.add(porch);
    nightLights.push([porch, 35]);
  }
  {
    // Cattle shed: brick back wall, three front posts, sloping sheet roof, feeding trough.
    const cx = -31;
    const cz = -19;
    const brick = lambert(0xa65f42);
    const wall = new Mesh(new BoxGeometry(10, 3.45, 0.25), brick);
    wall.position.set(cx, 1.725, cz - 2.9);
    wall.castShadow = true;
    S.add(tagHeat(wall, HEAT.building));
    const postMat = lambert(0x7d7a74);
    for (const x of [-4.8, 0, 4.8]) {
      const p = new Mesh(new CylinderGeometry(0.1, 0.1, 2.65, 8), postMat);
      p.position.set(cx + x, 1.325, cz + 2.8);
      S.add(tagHeat(p, HEAT.metal));
    }
    const roof = new Mesh(new BoxGeometry(10.8, 0.08, 6.8), lambert(0x8c8f93));
    roof.position.set(cx, 3.05, cz);
    roof.rotation.x = 0.12;
    roof.castShadow = true;
    S.add(tagHeat(roof, HEAT.metal + 0.05));
    const trough = new Mesh(new BoxGeometry(8, 0.45, 0.6), concrete);
    trough.position.set(cx, 0.225, cz - 2.2);
    S.add(tagHeat(trough, HEAT.building));
    obstacles.push({ type: 'box', name: 'cattle shed', minX: cx - 5.4, maxX: cx + 5.4, minZ: cz - 3.4, maxZ: cz + 3.4, h: 3.5 });
  }
  {
    const c = car(0xe2e2de, { seed: 3 });
    c.position.set(-21, 0, -7);
    c.rotation.y = 0.1;
    S.add(c);
    pushRotBox(obstacles, 'car', -21, -7, 0.1, -0.95, 0.95, -2.15, 2.15, 1.6);
  }

  // ------------------------------------------------ tube-well pump house
  {
    const p = PUMP;
    const ph = building(obstacles, { x: p.x, z: p.z, w: p.w, d: p.d, h: p.h, wallColor: 0xd9d3c3, roofColor: 0x8f8a80, rooftop: false, name: 'tube-well pump house', seed: 9 });
    S.add(ph);
    addOpenings(S, p, 'px', rnd, M, { sideWindows: false });
    const tank = new Mesh(new BoxGeometry(2.0, 0.8, 2.0), concrete);
    tank.position.set(-122.4, 0.4, -48.6);
    S.add(tagHeat(tank, HEAT.building));
    const tankWater = new Mesh(new PlaneGeometry(1.7, 1.7).rotateX(-Math.PI / 2), waterMat);
    tankWater.position.set(-122.4, 0.81, -48.6);
    S.add(tagHeat(tankWater, HEAT.water));
    const pipe = new Mesh(new CylinderGeometry(0.08, 0.08, 1.4, 8).rotateZ(Math.PI / 2), lambert(0x4a4f55));
    pipe.position.set(-123.2, 1.0, -48.6);
    S.add(tagHeat(pipe, HEAT.metal - 0.1));
    const starter = new Mesh(new BoxGeometry(0.15, 0.5, 0.4), lambert(0x6a7a8a));
    starter.position.set(p.x + p.w / 2 + 0.08, 1.4, p.z + 1.0);
    S.add(tagHeat(starter, HEAT.engine * 0.85));
    const bulb = new PointLight(0xffd8a0, 0, 16, 2);
    bulb.position.set(p.x + p.w / 2 + 0.6, 2.35, p.z);
    S.add(bulb);
    nightLights.push([bulb, 25]);
  }

  // ------------------------------------------------ power: 11 kV line, DP transformers, LT and service lines
  const poles11 = [];
  for (let x = -525; x <= 525; x += 50) poles11.push({ x, z: POLE_Z });
  S.add(powerLine(obstacles, poles11, { height: 10, wires: 3, spread: 0.8, sag: 0.4, poleColor: 0x9a9a94, name: '11 kV line' }));
  S.add(powerLine(obstacles, [{ x: LT_X, z: POLE_Z }, { x: LT_X, z: -8 }, { x: LT_X, z: -44 }], { height: 8, wires: 3, spread: 0.4, sag: 0.35, poleColor: 0x9a9a94, name: 'LT line' }));
  S.add(powerLine(obstacles, [{ x: -21, z: POLE_Z }, { x: -26.6, z: 5.4 }], { height: 7, wires: 2, spread: 0.25, sag: 0.3, poleColor: 0x9a9a94, name: 'service line' }));
  for (const [xa, xb] of [[-25, -21], [-125, LT_X]]) {
    const cx = (xa + xb) / 2;
    const span = Math.abs(xb - xa) + 0.4;
    const plat = new Mesh(new BoxGeometry(span, 0.12, 1.1), lambert(0x6d6d68));
    plat.position.set(cx, 4.05, POLE_Z);
    S.add(tagHeat(plat, HEAT.metal));
    const tr = new Mesh(new BoxGeometry(1.1, 1.3, 0.8), lambert(0x6d7a6a));
    tr.position.set(cx, 4.76, POLE_Z);
    tr.castShadow = true;
    S.add(tagHeat(tr, HEAT.transformer));
    for (const bx of [-0.35, 0, 0.35]) {
      const bushing = new Mesh(new CylinderGeometry(0.05, 0.07, 0.35, 8), lambert(0x8a4a3a));
      bushing.position.set(cx + bx, 5.58, POLE_Z);
      S.add(tagHeat(bushing, HEAT.transformer));
    }
    obstacles.push({ type: 'box', name: 'transformer', minX: cx - span / 2, maxX: cx + span / 2, minZ: POLE_Z - 0.55, maxZ: POLE_Z + 0.55, h: 5.8 });
  }

  // ------------------------------------------------ village
  HOUSES.forEach((hd, i) => {
    const wantTank = i % 3 !== 2;
    const g = building(obstacles, {
      x: hd.x, z: hd.z, w: hd.w, d: hd.d, h: hd.h, wallColor: WALL_COLORS[i % WALL_COLORS.length], roofColor: 0x8f8a80,
      name: 'house', seed: houseSeed(100 + i * 37, wantTank),
    });
    S.add(g);
    if (wantTank) addTankStand(g, hd.h);
    else if (hd.h > 5) {
      // Stair room (mumty) on the roof.
      const mw = 2.8;
      const md = 2.6;
      const lx = hd.w / 2 - 1.7;
      const lz = -(hd.d / 2 - 1.6);
      const mumty = new Mesh(new BoxGeometry(mw, 2.4, md), lambert(WALL_COLORS[i % WALL_COLORS.length]));
      mumty.position.set(lx, hd.h + 1.7, lz);
      mumty.castShadow = true;
      g.add(tagHeat(mumty, HEAT.building));
      obstacles.push({ type: 'box', name: 'house', minX: hd.x + lx - mw / 2, maxX: hd.x + lx + mw / 2, minZ: hd.z + lz - md / 2, maxZ: hd.z + lz + md / 2, h: hd.h + 2.9 });
    }
    addOpenings(S, hd, hd.front, rnd, M, { lamp: i % 2 === 0 });
  });

  // Water tower (elevated service reservoir): 4 columns and a central shaft carrying a 9 m tank, top ~23 m.
  {
    const { x, z } = WATER_TOWER;
    const conc = lambert(0xc4bfb4);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const col = new Mesh(new CylinderGeometry(0.32, 0.38, 17, 10), conc);
      col.position.set(x + sx * 2.4, 8.5, z + sz * 2.4);
      col.castShadow = true;
      S.add(tagHeat(col, HEAT.building));
    }
    const shaft = new Mesh(new CylinderGeometry(0.9, 0.9, 17, 14), conc);
    shaft.position.set(x, 8.5, z);
    shaft.castShadow = true;
    S.add(tagHeat(shaft, HEAT.building));
    for (const y of [6, 12]) {
      for (const s of [-1, 1]) {
        const bx = new Mesh(new BoxGeometry(5.1, 0.35, 0.35), conc);
        bx.position.set(x, y, z + s * 2.4);
        S.add(tagHeat(bx, HEAT.building));
        const bz = new Mesh(new BoxGeometry(0.35, 0.35, 5.1), conc);
        bz.position.set(x + s * 2.4, y, z);
        S.add(tagHeat(bz, HEAT.building));
      }
    }
    const tankMat = lambert(0xd8d2c4);
    const cone = new Mesh(new CylinderGeometry(4.6, 1.6, 1.6, 24), tankMat);
    cone.position.set(x, 17.0, z);
    cone.castShadow = true;
    S.add(tagHeat(cone, HEAT.building - 0.06));
    const tank = new Mesh(new CylinderGeometry(4.6, 4.6, 4.2, 28), tankMat);
    tank.position.set(x, 19.9, z);
    tank.castShadow = true;
    S.add(tagHeat(tank, HEAT.building - 0.06));
    const band = new Mesh(new CylinderGeometry(4.65, 4.65, 0.5, 28, 1, true), lambert(0x3a6ea5));
    band.position.set(x, 21.0, z);
    S.add(tagHeat(band, HEAT.building - 0.06));
    const roof = new Mesh(new ConeGeometry(4.8, 0.9, 28), lambert(0xb5b0a5));
    roof.position.set(x, 22.45, z);
    roof.castShadow = true;
    S.add(tagHeat(roof, HEAT.roof));
    const vent = new Mesh(new CylinderGeometry(0.25, 0.25, 0.5, 10), lambert(0x6d6d68));
    vent.position.set(x, 23.1, z);
    S.add(tagHeat(vent, HEAT.metal));
    obstacles.push({ type: 'cyl', name: 'water tower', x, z, r: 4.8, h: 23.4 });
  }

  // Parked truck at the village entrance.
  {
    const t = truck(0x2f6b3a);
    t.position.set(116, 0, 30.5);
    t.rotation.y = Math.PI / 2;
    S.add(t);
    pushRotBox(obstacles, 'truck', 116, 30.5, Math.PI / 2, -1.25, 1.25, -4.0, 3.65, 3.2);
  }

  // ------------------------------------------------ spray target corner flags
  const target = fields.find((f) => f.target);
  if (target) {
    const poleMat = lambert(0xf2f2f2);
    const flagMat = lambert(0xe0312b, { side: DoubleSide });
    for (const [px, pz] of [[target.x0 - 0.5, target.z0 - 0.5], [target.x1 + 0.5, target.z0 - 0.5], [target.x0 - 0.5, target.z1 + 0.5], [target.x1 + 0.5, target.z1 + 0.5]]) {
      const p = new Mesh(new CylinderGeometry(0.03, 0.03, 1.8, 6), poleMat);
      p.position.set(px, 0.9, pz);
      S.add(tagHeat(p, HEAT.metal));
      const fl = new Mesh(new PlaneGeometry(0.55, 0.35), flagMat);
      fl.position.set(px + 0.29, 1.6, pz);
      S.add(tagHeat(fl, HEAT.vegetation + 0.1));
      obstacles.push({ type: 'cyl', name: 'field marker', x: px, z: pz, r: 0.1, h: 1.8 });
    }
  }

  // ------------------------------------------------ tractor, people, cattle
  {
    const t = tractor();
    t.position.set(TRACTOR.x, 0, TRACTOR.z);
    t.rotation.y = TRACTOR.ry;
    S.add(t);
    pushRotBox(obstacles, 'tractor', TRACTOR.x, TRACTOR.z, TRACTOR.ry, -1.15, 1.15, -2.0, 1.25, 2.4);
    pushRotBox(obstacles, 'tractor trolley', TRACTOR.x, TRACTOR.z, TRACTOR.ry, -1.15, 1.15, 1.9, 5.9, 1.7);
  }
  const people = [];
  const nearest = (type) => fields.filter((f) => f.type === type && !f.target).sort((a, b) => fieldDist(a) - fieldDist(b))[0];
  const wheatF = nearest('wheat') || nearest('stubble');
  if (wheatF) {
    const cx = (wheatF.x0 + wheatF.x1) / 2;
    const cz = (wheatF.z0 + wheatF.z1) / 2;
    people.push([cx - 6, cz + 4, 0xeeeeee, 0xdedcd2], [cx + 3, cz - 5, 0xd2457a, 0xd2457a]);
  }
  const paddyF = nearest('paddy');
  if (paddyF) people.push([(paddyF.x0 + paddyF.x1) / 2, (paddyF.z0 + paddyF.z1) / 2, 0x2f6fb3, 0x2b2b30]);
  const fodderF = nearest('fodder');
  if (fodderF) people.push([fodderF.x0 + 12, (fodderF.z0 + fodderF.z1) / 2 - 3, 0xe08a2c, 0x3a3a40]);
  people.push(
    [TRACTOR.x + 1.8, TRACTOR.z - 2.6, 0x4a8a3a, 0x2b2b30], // driver standing by the tractor
    [-121.1, -51.8, 0xf0f0ea, 0xdedcd2], // at the tube-well, beside the channel
    [-27, -13.5, 0x7a2a3a, 0x7a2a3a], // tending cattle
    [160.5, 62, 0xe0c040, 0x2b2b30], // village lane
  );
  for (const [x, z, shirt, pants] of people) {
    const p = person(shirt, { pants });
    p.position.set(x, 0, z);
    p.rotation.y = rnd() * Math.PI * 2;
    S.add(p);
    obstacles.push({ type: 'cyl', name: 'person', x, z, r: 0.35, h: 1.8 });
  }
  for (const [x, z, ry, color, buffalo] of [
    [-30, -12.5, 0.4, 0xdcd6ca, false],
    [-34, -12, -0.3, 0x8a6a4a, false],
    [-20, -45, 1.9, 0x2a2a2a, true],
  ]) {
    const c = cow(color, { buffalo });
    c.position.set(x, 0, z);
    c.rotation.y = ry;
    S.add(c);
    obstacles.push({ type: 'cyl', name: buffalo ? 'buffalo' : 'cow', x, z, r: 1.0, h: 1.6 });
  }

  // ------------------------------------------------ haystacks (cylindrical straw stacks with conical tops)
  const stacks = [
    [-45, -12, 2.0], [-45.5, -21.5, 2.3], [-44.5, 9, 1.8], [-128, -36, 1.7],
    [108, 50, 1.8], [111, 60, 1.6], [220, 96, 2.0], [221, 103, 1.7],
  ];
  for (const f of fields) {
    if (f.type !== 'stubble') continue;
    const n = rnd() < q ? 2 : 1;
    for (let i = 0; i < n; i++) {
      stacks.push([f.x0 + 8 + rnd() * (f.x1 - f.x0 - 16), f.z0 + 8 + rnd() * (f.z1 - f.z0 - 16), 1.6 + rnd() * 0.8]);
    }
  }
  {
    const baseGeo = new CylinderGeometry(1, 1.06, 1, 12);
    baseGeo.translate(0, 0.5, 0);
    const topGeo = new ConeGeometry(1.08, 1, 12);
    topGeo.translate(0, 0.5, 0);
    const strawMat = lambert(0xffffff, { map: strawTexture() });
    const bases = [];
    const tops = [];
    for (const [x, z, r] of stacks) {
      const hb = r * (0.9 + rnd() * 0.35);
      const hc = r * (0.8 + rnd() * 0.3);
      const color = new Color().setHSL(0.11 + rnd() * 0.02, 0.35 + rnd() * 0.2, 0.62 + rnd() * 0.12);
      const ry = rnd() * Math.PI;
      bases.push({ x, y: 0, z, sx: r, sy: hb, sz: r, ry, color });
      tops.push({ x, y: hb, z, sx: r, sy: hc, sz: r, ry, color });
      obstacles.push({ type: 'cyl', name: 'haystack', x, z, r: r * 1.08, h: hb + hc });
    }
    root.add(tagHeat(instanced(baseGeo, strawMat, bases), HEAT.soil + 0.03));
    root.add(tagHeat(instanced(topGeo, strawMat, tops), HEAT.soil + 0.03));
  }

  // ------------------------------------------------ trees and bushes
  const general = [];
  const mango = [];
  const avoidTree = (x, z) => (Math.abs(x - LT_X) < 7 && z > -50 && z < 34) || (x > -32 && x < -16 && z > 0 && z < 34) || Math.abs(z - POLE_Z) < 7;
  const rowGap = (base) => base / Math.pow(q, 0.75);
  // Road row (north side), canal rows on both banks; sparser beyond the field area.
  for (let x = -700; x <= 700; x += rowGap(15) * (Math.abs(x) > 350 ? 1.6 : 1)) {
    const tx = x + (rnd() - 0.5) * 3;
    if (tx > -58 && tx < 34) continue;
    if (avoidTree(tx, 15)) continue;
    general.push({ x: tx, z: 15 + (rnd() - 0.5) * 1.2, s: 0.9 + rnd() * 0.35, kind: 'broad' });
  }
  for (const bankZ of [CANAL_Z + 6.5, CANAL_Z - 6.5]) {
    for (let x = -700; x <= 700; x += rowGap(13) * (Math.abs(x) > 350 ? 1.5 : 1)) {
      const tx = x + (rnd() - 0.5) * 3;
      if (Math.abs(tx - TRACK_X) < 9) continue;
      general.push({ x: tx, z: bankZ + (rnd() - 0.5) * 1.0, s: 0.95 + rnd() * 0.35, kind: 'broad' });
    }
  }
  // Isolated trees on bund corners.
  for (let i = 0, tries = 0; i < Math.round(18 * q) && tries < 400; tries++) {
    const f = fields[Math.floor(rnd() * fields.length)];
    const x = (rnd() < 0.5 ? f.x0 - 1 : f.x1 + 1);
    const z = (rnd() < 0.5 ? f.z0 - 1 : f.z1 + 1);
    if (Math.hypot(x, z) < 35 || avoidTree(x, z) || Math.abs(z - ROAD_Z) < 12 || Math.abs(z - CANAL_Z) < 12) continue;
    if (Math.abs(x - TRACK_X) < 5 || Math.hypot(x - TRACTOR.x, z - TRACTOR.z) < 14) continue;
    if (x > VILLAGE.minX - 4 && x < VILLAGE.maxX + 4 && z > VILLAGE.minZ - 4 && z < VILLAGE.maxZ + 4) continue;
    general.push({ x, z, s: 0.9 + rnd() * 0.45, kind: 'broad' });
    i++;
  }
  // Compound shade trees, village neem/peepal and date palms.
  general.push({ x: -44, z: -3, s: 1.25, kind: 'broad' }, { x: -40, z: -28, s: 1.05, kind: 'broad' });
  for (const [x, z] of [[140, 37.5], [178, 38], [120, 80], [205, 66], [215, 90], [140, 114], [180, 118]]) general.push({ x, z, s: 1.1 + rnd() * 0.3, kind: 'broad' });
  for (const [x, z] of [[224, 50], [222, 38], [196, 54], [110, 40], [112, 95], [226, 116], [204, 122], [130, 121]]) general.push({ x, z, s: 0.85 + rnd() * 0.3, kind: 'palm' });
  // Distant tree clumps on the horizon plains (beyond 400 m: no obstacles).
  for (let i = 0, tries = 0; i < Math.round(30 * q) && tries < 400; tries++) {
    const a = rnd() * Math.PI * 2;
    const r = 430 + rnd() * 850;
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    if (Math.max(Math.abs(cx), Math.abs(cz)) < 380 || Math.abs(cz - ROAD_Z) < 12 || Math.abs(cz - CANAL_Z) < 12 || Math.abs(cx - TRACK_X) < 10) continue;
    const n = 3 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) general.push({ x: cx + (rnd() - 0.5) * 30, z: cz + (rnd() - 0.5) * 30, s: 1 + rnd() * 0.4, kind: 'broad' });
    i++;
  }
  // Mango grove south of the road.
  const mStep = 10 / Math.sqrt(q);
  for (let x = GROVE.minX + 5; x <= GROVE.maxX - 4; x += mStep) {
    for (let z = GROVE.minZ + 5; z <= GROVE.maxZ - 4; z += mStep) {
      mango.push({ x: x + (rnd() - 0.5) * 1.6, z: z + (rnd() - 0.5) * 1.6, s: 1.1 + rnd() * 0.3, kind: 'broad' });
    }
  }
  const tg = trees(obstacles, general, { seed: seed + 31, crownTint: '#3b6a2c' });
  root.add(tg.group);
  swayMaterials.push(...tg.swayMaterials);
  const mg = trees(obstacles, mango, { seed: seed + 32, crownTint: '#28501f' });
  root.add(mg.group);
  swayMaterials.push(...mg.swayMaterials);

  const bushSpots = [];
  const nonCane = fields.filter((f) => f.type !== 'cane');
  for (let i = 0; i < Math.round(150 * q); i++) {
    const f = nonCane[Math.floor(rnd() * nonCane.length)];
    const t = rnd();
    const side = Math.floor(rnd() * 4);
    let x;
    let z;
    if (side < 2) {
      x = f.x0 + t * (f.x1 - f.x0);
      z = (side ? f.z1 : f.z0) + (rnd() - 0.5) * 0.5;
    } else {
      z = f.z0 + t * (f.z1 - f.z0);
      x = (side === 3 ? f.x1 : f.x0) + (rnd() - 0.5) * 0.5;
    }
    if (Math.hypot(x, z) < 25) continue;
    bushSpots.push({ x, z, s: 0.6 + rnd() * 0.5 });
  }
  for (let z = COMPOUND.minZ + 1; z < COMPOUND.maxZ - 1; z += 3 / Math.sqrt(q)) bushSpots.push({ x: COMPOUND.minX + 0.6, z, s: 0.8 + rnd() * 0.3 });
  for (let i = 0; i < Math.round(40 * q); i++) {
    bushSpots.push({ x: (rnd() - 0.5) * 700, z: CANAL_Z + (rnd() < 0.5 ? -5.5 : 5.5) + (rnd() - 0.5), s: 0.7 + rnd() * 0.5 });
  }
  root.add(bushes(bushSpots, { seed: seed + 33 }));

  // ------------------------------------------------ horizon
  const hills = horizonHills({ seed: seed + 99, radius: 1500, count: 22, color: 0x6e7d5c });
  hills.scale.y = 0.3;
  S.add(hills);

  // ------------------------------------------------ merge statics
  root.add(mergeStatic(S));

  // ------------------------------------------------ minimap
  const mapFields = fields.map((f) => [f.x0, f.z0, f.x1, f.z1, CROPS[f.type].map]);
  function mapPaint(c, toPx, mpp) {
    let m = mpp;
    if (!(m > 0)) {
      const a = toPx(0, 0);
      const b = toPx(1, 0);
      m = 1 / (Math.abs(b[0] - a[0]) || 1);
    }
    const px = (metres, min) => Math.max(min, metres / m);
    paintRect(c, toPx, -2000, -2000, 2000, 2000, '#7c7f4c');
    paintRect(c, toPx, -362, -362, 362, 362, '#73884a');
    for (const [x0, z0, x1, z1, col] of mapFields) paintRect(c, toPx, x0, z0, x1, z1, col);
    paintRect(c, toPx, GROVE.minX, GROVE.minZ, GROVE.maxX, GROVE.maxZ, '#3e6a2c');
    paintRect(c, toPx, VILLAGE.minX, VILLAGE.minZ, VILLAGE.maxX, VILLAGE.maxZ, '#b39b77');
    paintRect(c, toPx, COMPOUND.minX, COMPOUND.minZ, COMPOUND.maxX, COMPOUND.maxZ, '#b8a07a');
    paintRect(c, toPx, YARD.minX, YARD.minZ, YARD.maxX, YARD.maxZ, '#d6c39e');
    paintPolyline(c, toPx, [[-FAR, CANAL_Z], [FAR, CANAL_Z]], '#b9b08a', px(9, 2));
    paintPolyline(c, toPx, [[-FAR, CANAL_Z], [FAR, CANAL_Z]], '#3f86c0', px(3.5, 1.5));
    paintPolyline(c, toPx, [[-122.4, -49.6], [-122.4, CHANNEL_Z], [-52, CHANNEL_Z]], '#4a90c8', px(0.6, 1));
    const [pcx, pcy] = toPx(POND.x, POND.z);
    c.fillStyle = '#3f86c0';
    c.beginPath();
    c.arc(pcx, pcy, Math.max(2, POND.r / m), 0, Math.PI * 2);
    c.fill();
    paintPolyline(c, toPx, [[TRACK_X, -FAR], [TRACK_X, FAR]], '#9a7a52', px(TRACK_W, 1.5));
    paintPolyline(c, toPx, [[-FAR, ROAD_Z], [FAR, ROAD_Z]], '#5a5c5e', px(5.5, 2));
    paintPolyline(c, toPx, [[160, ROAD_Z + ROAD_W / 2], [160, VILLAGE.maxZ - 2]], '#a8674a', px(4, 1.5));
    paintPolyline(c, toPx, [[106, 76], [226, 76]], '#a8674a', px(3.5, 1.5));
  }

  const poi = [
    { name: 'Farmhouse', x: FARMHOUSE.x, z: FARMHOUSE.z },
    { name: 'Water tower', x: WATER_TOWER.x, z: WATER_TOWER.z },
    { name: 'Village', x: 160, z: 75 },
  ];
  if (target) poi.splice(2, 0, { name: 'Spray target (mustard)', x: (target.x0 + target.x1) / 2, z: (target.z0 + target.z1) / 2 });

  return {
    root,
    obstacles,
    groundHeight,
    pilot: { x: 0, z: 14 },
    setNight(k) {
      pad.setNight(k);
      M.lit.emissiveIntensity = k * 1.3;
      M.lamp.emissiveIntensity = k * 4;
      for (const [light, max] of nightLights) light.intensity = k > 0.25 ? max * k : 0;
    },
    update(dt, t, windAt) {
      sock.update(dt, windAt(sock.sample.x, sock.sample.y, sock.sample.z, _w));
    },
    swayMaterials,
    patterns: false,
    mapPaint,
    mapExtent: 320,
    poi,
    dispose() {
      disposeTree(root);
    },
  };
}

function fieldDist(f) {
  return Math.hypot((f.x0 + f.x1) / 2, (f.z0 + f.z1) / 2);
}

// building() floats its rooftop tank 0.6 m above the parapet; give it a brick stand.
function addTankStand(g, h) {
  const tank = g.children.find((c) => c.isMesh && c.geometry.type === 'CylinderGeometry');
  if (!tank) return;
  const stand = new Mesh(new BoxGeometry(1.3, 0.62, 1.3), lambert(0x9a5a40));
  stand.position.set(tank.position.x, h + 0.8, tank.position.z);
  g.add(tagHeat(stand, HEAT.roof));
}
