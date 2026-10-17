// City Streets: a modern Indian downtown district around a paved public plaza.
//
// Layout (metres, +X east, -Z north): a 7 x 7 grid of ~64 m blocks separated by 14 m roads, with the
// central block turned into a 44 x 44 m plaza holding the home pad. Low-rise buildings ring the plaza,
// heights climb toward a glass-tower CBD in the north-east, a park sits north-west of the plaza and
// low-hanging telecom cables run along the street north and east of it. Traffic drives on the LEFT.
//
// Draw calls are kept low by merging static props per material (consolidate), folding each building
// body into a single-material draw (slimBuilding) and instancing rooftop clutter, vehicles and people.

import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide,
  Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, MeshLambertMaterial, MeshStandardMaterial,
  PlaneGeometry, Quaternion, RepeatWrapping, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  HEAT, QUALITY_SCALE, asphaltTexture, building, bushes, canvasTexture, car, disposeTree, facadeTexture,
  grassTexture, homePad, horizonHills, instanced, lambert, lightWindows, mulberry32, paintPolyline, paintRect,
  pavingTexture, person, pilotPost, powerLine, roadTexture, streetLights, tagHeat, trees, truck, windsock,
} from './common.js';

// ---------------------------------------------------------------- layout constants

const FLOOR = 3.2;
const HALF = 7; // road half-width (14 m roads)
const SW = 4; // sidewalk width
const PLAZA = 22; // plaza half-size
// Block extents along either axis (the central one is the plaza block).
const BLOCKS = [[-260, -196], [-182, -118], [-104, -40], [-26, 26], [40, 104], [118, 182], [196, 260]];
// Road centre lines along either axis.
const ROADS = [-267, -189, -111, -33, 33, 111, 189, 267];
const WIDE = new Set([-111, 111]); // 4-lane arterials
const CITY = 274; // outer edge of the ring road
const PARK = { i: 2, j: 2 }; // block x[-104,-40] z[-104,-40]
const ROAD_V = 28; // metres per road texture tile along the road (256 x 512 px over 14 m)

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const _up = new Vector3(0, 1, 0);
const _mat = new Matrix4();
const _quat = new Quaternion();
const _pos = new Vector3();
const _scl = new Vector3(1, 1, 1);
const _w = new Vector3();

// ---------------------------------------------------------------- local helpers

// Ground-level rectangles merged into one mesh (roads, sidewalks, markings).
class RectBatch {
  constructor() {
    this.p = [];
    this.u = [];
    this.i = [];
  }

  rect(x0, z0, x1, z1, y, uvAt) {
    const ax = Math.min(x0, x1);
    const bx = Math.max(x0, x1);
    const az = Math.min(z0, z1);
    const bz = Math.max(z0, z1);
    const base = this.p.length / 3;
    for (const [x, z] of [[ax, bz], [bx, bz], [bx, az], [ax, az]]) {
      this.p.push(x, y, z);
      const [u, v] = uvAt(x, z);
      this.u.push(u, v);
    }
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  mesh(material, heat) {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.p, 3));
    const n = new Float32Array(this.p.length);
    for (let k = 1; k < n.length; k += 3) n[k] = 1;
    g.setAttribute('normal', new BufferAttribute(n, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.u, 2));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    const m = new Mesh(g, material);
    m.receiveShadow = true;
    m.userData.heat = heat;
    return m;
  }
}

const worldUV = (tile) => (x, z) => [x / tile, -z / tile];

// Ground overlay material: polygon offset keeps it above the ground plane at grazing angles.
function overlay(color, level, opts = {}) {
  return new MeshLambertMaterial({ color, polygonOffset: true, polygonOffsetFactor: -level, polygonOffsetUnits: -level, ...opts });
}

// Non-indexed copy with exactly position/normal/uv so any mix of primitives can be merged.
function normGeo(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

function mergeAll(geos) {
  if (!geos.length) return null;
  const m = mergeGeometries(geos.map(normGeo), false);
  if (m) m.computeBoundingSphere();
  return m;
}

// Collapse a static group into one mesh per material (baking transforms). Lights are kept.
function consolidate(src) {
  src.updateMatrixWorld(true);
  const buckets = new Map();
  const keep = [];
  src.traverse((o) => {
    if (o === src) return;
    if (o.isMesh && !o.isInstancedMesh && !Array.isArray(o.material)) {
      let b = buckets.get(o.material);
      if (!b) buckets.set(o.material, (b = { geos: [], heat: undefined, cast: false }));
      const g = normGeo(o.geometry);
      g.applyMatrix4(o.matrixWorld);
      b.geos.push(g);
      if (b.heat === undefined && o.userData.heat !== undefined) b.heat = o.userData.heat;
      b.cast = b.cast || o.castShadow;
    } else if (o.isLight || o.isMesh) {
      keep.push(o); // lights, instanced or multi-material meshes stay as they are
    }
  });
  const out = new Group();
  for (const [material, b] of buckets) {
    const geo = mergeGeometries(b.geos, false);
    if (!geo) continue;
    geo.computeBoundingSphere();
    const m = new Mesh(geo, material);
    m.castShadow = b.cast;
    m.receiveShadow = true;
    if (b.heat !== undefined) m.userData.heat = b.heat;
    out.add(m);
  }
  for (const o of keep) {
    o.matrixWorld.decompose(o.position, o.quaternion, o.scale);
    out.add(o);
  }
  return out;
}

// Collect geometries baked in world space; flushed to meshes per material at the end.
class Props {
  constructor() {
    this.map = new Map();
  }

  add(material, geo, heat) {
    let b = this.map.get(material);
    if (!b) this.map.set(material, (b = { geos: [], heat }));
    b.geos.push(geo);
  }

  box(material, heat, x, y, z, w, h, d, ry = 0) {
    const g = new BoxGeometry(w, h, d);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    this.add(material, g, heat);
  }

  cyl(material, heat, x, y, z, rTop, rBot, h, seg = 10) {
    const g = new CylinderGeometry(rTop, rBot, h, seg);
    g.translate(x, y, z);
    this.add(material, g, heat);
  }

  rod(material, heat, a, b, r, seg = 4) {
    const d = new Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return;
    const g = new CylinderGeometry(r, r, len, seg, 1, true);
    g.applyQuaternion(new Quaternion().setFromUnitVectors(_up, d.normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    this.add(material, g, heat);
  }

  flush(parent, { castShadow = true } = {}) {
    const meshes = new Map();
    for (const [material, b] of this.map) {
      const geo = mergeAll(b.geos);
      if (!geo) continue;
      const m = new Mesh(geo, material);
      m.castShadow = castShadow;
      m.receiveShadow = true;
      if (b.heat !== undefined) m.userData.heat = b.heat;
      parent.add(m);
      meshes.set(material, m);
    }
    this.map.clear();
    return meshes;
  }
}

// building() draws a box with six material groups (~6 draws) plus parapet/tank/AC meshes. Fold the
// four walls into a single material by writing the facade tiling into the UVs (columns of `colW`
// metres, floors of FLOOR metres) and drop the roof and floor faces; an instanced roof cap covers the top.
function slimBuilding(g, { floors, colW, texCols, texFloors }) {
  const body = g.children.find((c) => c.isMesh && Array.isArray(c.material));
  if (!body || !body.geometry.index || body.geometry.groups.length !== 6) return;
  const geo = body.geometry;
  const { width, depth } = geo.parameters;
  const wall = body.material[4];
  const uv = geo.attributes.uv;
  const idx = geo.index.array;
  const keep = [];
  const vRep = floors / texFloors;
  geo.groups.forEach((grp, gi) => {
    if (gi === 2 || gi === 3) return; // +y / -y
    const len = gi < 2 ? depth : width;
    const uRep = Math.max(1, Math.round(len / colW)) / texCols;
    const seen = new Set();
    for (let k = grp.start; k < grp.start + grp.count; k++) {
      const vi = idx[k];
      keep.push(vi);
      if (seen.has(vi)) continue;
      seen.add(vi);
      uv.setXY(vi, uv.getX(vi) * uRep, uv.getY(vi) * vRep);
    }
  });
  geo.setIndex(keep);
  geo.clearGroups();
  body.material = wall;
  if (wall.map) wall.map.repeat.set(1, 1);
  if (wall.emissiveMap) wall.emissiveMap.repeat.set(1, 1);
  g.userData.facadeMaterials = wall.emissiveMap ? [wall] : [];
}

// Merge a template group (car(), truck(), person()) into one geometry per material colour so the
// parts can be instanced. Returns Map(colorHex -> { geometry, material, heat }).
function harvest(template, rotateY = 0) {
  template.updateMatrixWorld(true);
  const parts = new Map();
  template.traverse((o) => {
    if (!o.isMesh) return;
    const key = o.material.color ? o.material.color.getHex() : 0;
    let p = parts.get(key);
    if (!p) parts.set(key, (p = { geos: [], material: o.material, heat: o.userData.heat }));
    const g = normGeo(o.geometry);
    g.applyMatrix4(o.matrixWorld);
    if (rotateY) g.rotateY(rotateY);
    p.geos.push(g);
  });
  const out = new Map();
  for (const [k, p] of parts) out.set(k, { geometry: mergeGeometries(p.geos, false), material: p.material, heat: p.heat });
  return out;
}

// A set of instanced parts that move together (one instance per vehicle / person).
class Fleet {
  constructor(parts, count) {
    this.meshes = parts.map((p) => {
      const im = new InstancedMesh(p.geometry, p.material, Math.max(count, 1));
      im.count = count;
      im.frustumCulled = false;
      im.castShadow = true;
      im.receiveShadow = true;
      im.userData.heat = p.heat;
      return im;
    });
  }

  place(i, x, y, z, ry) {
    _quat.setFromAxisAngle(_up, ry);
    _mat.compose(_pos.set(x, y, z), _quat, _scl);
    for (const m of this.meshes) m.setMatrixAt(i, _mat);
  }

  color(part, i, c) {
    this.meshes[part].setColorAt(i, c);
  }

  flush() {
    for (const m of this.meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}

// Closed lane path around a rectangle with rounded corners. corners: 4 points in driving order.
function lanePath(corners, R) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = corners[i];
    const p1 = corners[(i + 1) % 4];
    const p2 = corners[(i + 2) % 4];
    const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const a = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L];
    const L2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const b = [(p2[0] - p1[0]) / L2, (p2[1] - p1[1]) / L2];
    segs.push({ kind: 'line', s0: total, len: L - 2 * R, x: p0[0] + a[0] * R, z: p0[1] + a[1] * R, a });
    total += L - 2 * R;
    const cx = p1[0] - a[0] * R + b[0] * R;
    const cz = p1[1] - a[1] * R + b[1] * R;
    segs.push({ kind: 'arc', s0: total, len: (Math.PI / 2) * R, cx, cz, a, b });
    total += (Math.PI / 2) * R;
  }
  return {
    total,
    // Writes { x, z, ry } (ry: yaw for a model whose nose points -Z).
    at(s, out) {
      let u = s % total;
      if (u < 0) u += total;
      let seg = segs[segs.length - 1];
      for (const sg of segs) {
        if (u < sg.s0 + sg.len) {
          seg = sg;
          break;
        }
      }
      const d = u - seg.s0;
      let tx;
      let tz;
      if (seg.kind === 'line') {
        out.x = seg.x + seg.a[0] * d;
        out.z = seg.z + seg.a[1] * d;
        tx = seg.a[0];
        tz = seg.a[1];
      } else {
        const th = d / R;
        const c = Math.cos(th);
        const sn = Math.sin(th);
        out.x = seg.cx + R * (-seg.b[0] * c + seg.a[0] * sn);
        out.z = seg.cz + R * (-seg.b[1] * c + seg.a[1] * sn);
        tx = seg.a[0] * c + seg.b[0] * sn;
        tz = seg.a[1] * c + seg.b[1] * sn;
      }
      out.ry = Math.atan2(-tx, -tz);
      return out;
    },
  };
}

// Axis-aligned half extents of a rotated rectangle (half width hw across, half length hl along).
function aabbHalf(ry, hw, hl) {
  const c = Math.abs(Math.cos(ry));
  const s = Math.abs(Math.sin(ry));
  return [c * hw + s * hl, s * hw + c * hl];
}

// Draw balconies (slab + railing) over a facade canvas pair.
function addBalconies(f, floors, cols, slab = '#efe8da', rail = '#3b3f44') {
  const ctx = f.map.image.getContext('2d');
  const ectx = f.emissiveMap.image.getContext('2d');
  const W = f.map.image.width;
  const H = f.map.image.height;
  const fh = H / floors;
  const cw = W / cols;
  for (let fl = 0; fl < floors; fl++) {
    const y = fl * fh;
    ctx.fillStyle = slab;
    ctx.fillRect(0, y + fh * 0.8, W, fh * 0.08);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, y + fh * 0.88, W, fh * 0.05);
    for (let c = 0; c < cols; c++) {
      if ((c + fl) % 2) continue;
      const x = c * cw + cw * 0.06;
      const w = cw * 0.88;
      ctx.fillStyle = rail;
      ctx.fillRect(x, y + fh * 0.56, w, fh * 0.035);
      for (let k = 0; k <= 8; k++) ctx.fillRect(x + (k * w) / 8 - 1, y + fh * 0.56, 2, fh * 0.24);
      ectx.fillStyle = 'rgba(0,0,0,0.55)';
      ectx.fillRect(x, y + fh * 0.56, w, fh * 0.24);
    }
  }
  f.map.needsUpdate = true;
  f.emissiveMap.needsUpdate = true;
}

// Rain streaks and grime for older plastered facades.
function addWeathering(f, seed) {
  const rnd = mulberry32(seed);
  const ctx = f.map.image.getContext('2d');
  const W = f.map.image.width;
  const H = f.map.image.height;
  for (let i = 0; i < 70; i++) {
    ctx.fillStyle = `rgba(70,55,40,${0.05 + rnd() * 0.1})`;
    ctx.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 6, 20 + rnd() * 90);
  }
  ctx.fillStyle = 'rgba(60,50,40,0.12)';
  ctx.fillRect(0, H - 14, W, 14);
  f.map.needsUpdate = true;
}

// Billboard artwork (generic, no real brands).
function adTexture(kind) {
  return canvasTexture(512, 256, (ctx, w, h) => {
    if (kind === 0) {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#d62f5b');
      g.addColorStop(1, '#f28c28');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 74px sans-serif';
      ctx.fillText('MONSOON', 28, 100);
      ctx.fillText('SALE', 28, 180);
      ctx.fillStyle = '#ffe14d';
      ctx.beginPath();
      ctx.arc(400, 128, 88, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#c0213f';
      ctx.font = 'bold 60px sans-serif';
      ctx.fillText('50%', 345, 150);
    } else if (kind === 1) {
      ctx.fillStyle = '#0f2a4a';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#2fd3c8';
      for (let i = 0; i < 5; i++) ctx.fillRect(380 + i * 22, 190 - i * 34, 16, 30 + i * 34);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 66px sans-serif';
      ctx.fillText('FAST 5G', 30, 110);
      ctx.font = '34px sans-serif';
      ctx.fillText('unlimited city data', 32, 170);
    } else {
      ctx.fillStyle = '#f5ead2';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#7a3b12';
      ctx.fillRect(0, 196, w, 60);
      ctx.fillStyle = '#b5541c';
      ctx.beginPath();
      ctx.moveTo(360, 70);
      ctx.lineTo(470, 70);
      ctx.lineTo(450, 180);
      ctx.lineTo(380, 180);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#3a2412';
      ctx.font = 'bold 64px sans-serif';
      ctx.fillText('Masala', 28, 100);
      ctx.fillText('Chai', 28, 170);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 30px sans-serif';
      ctx.fillText('FRESH  •  HOT  •  24x7', 30, 236);
    }
  });
}

// Simple window-grid texture for the distant silhouettes (map + emissive for night).
function distantTextures() {
  const rnd = mulberry32(77);
  const lit = [];
  const map = canvasTexture(128, 256, (ctx, w, h) => {
    ctx.fillStyle = '#9a968e';
    ctx.fillRect(0, 0, w, h);
    for (let y = 6; y < h; y += 12) {
      for (let x = 4; x < w; x += 10) {
        ctx.fillStyle = rnd() < 0.5 ? '#4d5560' : '#5d6570';
        ctx.fillRect(x, y, 6, 6);
        if (rnd() < 0.35) lit.push([x, y]);
      }
    }
  });
  const emissiveMap = canvasTexture(128, 256, (ctx, w, h) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffd9a0';
    for (const [x, y] of lit) ctx.fillRect(x, y, 6, 6);
  });
  return { map, emissiveMap };
}

// ---------------------------------------------------------------- scene

export function build(ctx = {}) {
  const quality = QUALITY_SCALE[ctx.quality] ? ctx.quality : 'high';
  const QS = QUALITY_SCALE[quality];
  const seed = Number.isFinite(ctx.seed) ? ctx.seed | 0 : 4242;
  const rnd = mulberry32(seed ^ 0x51c7);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  const root = new Group();
  root.name = 'city';
  const obstacles = [];
  const facadeMats = [];
  const swayMaterials = [];
  const nightFns = [];
  const mapRects = []; // [x0, z0, x1, z1, fill]
  const mapLines = []; // [points, stroke, widthPx]
  const poi = [{ name: 'Plaza (home)', x: 0, z: 0 }];
  const props = new Props();
  let night = 0;

  // ---- ground and street surfaces

  const groundGeo = new PlaneGeometry(4000, 4000);
  groundGeo.rotateX(-Math.PI / 2);
  const ground = new Mesh(groundGeo, lambert(0xc9bd9c, { map: grassTexture([400, 400]) }));
  ground.receiveShadow = true;
  ground.userData.heat = HEAT.ground;
  root.add(ground);

  const YS = 0.03; // street surfaces
  const YM = 0.05; // markings and park paths
  const road2 = new RectBatch();
  const road4 = new RectBatch();
  const xings = new RectBatch();
  const walks = new RectBatch();
  const lots = new RectBatch();
  const plazaB = new RectBatch();
  const parkB = new RectBatch();
  const paths = new RectBatch();
  const marks = new RectBatch();
  const noUV = () => [0, 0];

  mapRects.push([-CITY, -CITY, CITY, CITY, '#55585c']);
  for (const R of ROADS) {
    const batch = WIDE.has(R) ? road4 : road2;
    const uNS = (x, z) => [(x - (R - HALF)) / (2 * HALF), -z / ROAD_V];
    const uEW = (x, z) => [(z - (R - HALF)) / (2 * HALF), x / ROAD_V];
    for (let k = 0; k < ROADS.length - 1; k++) {
      const a = ROADS[k] + HALF;
      const b = ROADS[k + 1] - HALF;
      batch.rect(R - HALF, a, R + HALF, b, YS, uNS);
      batch.rect(a, R - HALF, b, R + HALF, YS, uEW);
    }
    for (const X of ROADS) xings.rect(X - HALF, R - HALF, X + HALF, R + HALF, YS, worldUV(8));
  }
  // Arterials continue out of town so the grid does not end abruptly.
  for (const R of [-111, 111]) {
    const uNS = (x, z) => [(x - (R - HALF)) / (2 * HALF), -z / ROAD_V];
    const uEW = (x, z) => [(z - (R - HALF)) / (2 * HALF), x / ROAD_V];
    for (const [a, b] of [[-1000, -CITY], [CITY, 1000]]) {
      road4.rect(R - HALF, a, R + HALF, b, YS, uNS);
      road4.rect(a, R - HALF, b, R + HALF, YS, uEW);
      mapRects.push([R - HALF, a, R + HALF, b, '#55585c'], [a, R - HALF, b, R + HALF, '#55585c']);
    }
  }

  for (let i = 0; i < BLOCKS.length; i++) {
    for (let j = 0; j < BLOCKS.length; j++) {
      const [x0, x1] = BLOCKS[i];
      const [z0, z1] = BLOCKS[j];
      const uvW = worldUV(4);
      walks.rect(x0, z0, x1, z0 + SW, YS, uvW);
      walks.rect(x0, z1 - SW, x1, z1, YS, uvW);
      walks.rect(x0, z0 + SW, x0 + SW, z1 - SW, YS, uvW);
      walks.rect(x1 - SW, z0 + SW, x1, z1 - SW, YS, uvW);
      mapRects.push([x0, z0, x1, z1, '#b3ada0']);
      if (i === 3 && j === 3) {
        plazaB.rect(-PLAZA, -PLAZA, PLAZA, PLAZA, YS, worldUV(3));
        mapRects.push([-PLAZA, -PLAZA, PLAZA, PLAZA, '#d6c6a2']);
      } else if (i === PARK.i && j === PARK.j) {
        parkB.rect(x0 + SW, z0 + SW, x1 - SW, z1 - SW, YS, worldUV(10));
        mapRects.push([x0 + SW, z0 + SW, x1 - SW, z1 - SW, '#5f8f3e']);
      } else {
        lots.rect(x0 + SW, z0 + SW, x1 - SW, z1 - SW, YS, worldUV(6));
        mapRects.push([x0 + SW, z0 + SW, x1 - SW, z1 - SW, '#8d897f']);
      }
    }
  }

  // Park paths: a ring, a cross and a small central square (no overlaps).
  const parkPaths = [
    [-98, -98, -46, -95.5], [-98, -48.5, -46, -46], [-98, -95.5, -95.5, -48.5], [-48.5, -95.5, -46, -48.5],
    [-73.5, -95.5, -70.5, -76], [-73.5, -68, -70.5, -48.5], [-95.5, -73.5, -76, -70.5], [-68, -73.5, -48.5, -70.5],
    [-76, -76, -68, -68],
    [-73.5, -46, -70.5, -44], [-73.5, -100, -70.5, -98], [-100, -73.5, -98, -70.5], [-46, -73.5, -44, -70.5],
  ];
  for (const [a, b, c, d] of parkPaths) {
    paths.rect(a, b, c, d, YM, worldUV(3));
    mapRects.push([a, b, c, d, '#cdbf98']);
  }

  // Zebra crossings and stop lines at the four plaza intersections.
  for (const X of [-33, 33]) {
    for (const Z of [-33, 33]) {
      for (const sgn of [-1, 1]) {
        const za = Z + sgn * (HALF + 0.6);
        const zb = Z + sgn * (HALF + 3.6);
        for (let x = X - HALF + 0.8; x < X + HALF - 0.6; x += 1.1) marks.rect(x, za, x + 0.55, zb, YM, noUV);
        const xa = X + sgn * (HALF + 0.6);
        const xb = X + sgn * (HALF + 3.6);
        for (let z = Z - HALF + 0.8; z < Z + HALF - 0.6; z += 1.1) marks.rect(xa, z, xb, z + 0.55, YM, noUV);
        // Stop lines across the incoming (left-hand) half of each approach.
        const xs = sgn > 0 ? [X - 6.6, X - 0.2] : [X + 0.2, X + 6.6];
        marks.rect(xs[0], Z + sgn * 4.5 + sgn * HALF, xs[1], Z + sgn * 4.9 + sgn * HALF, YM, noUV);
        const zs = sgn > 0 ? [Z + 0.2, Z + 6.6] : [Z - 6.6, Z - 0.2];
        marks.rect(X + sgn * 4.5 + sgn * HALF, zs[0], X + sgn * 4.9 + sgn * HALF, zs[1], YM, noUV);
      }
    }
  }

  const roadTex = (lanes) => {
    const t = roadTexture({ lanes });
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.needsUpdate = true;
    return t;
  };
  root.add(
    road2.mesh(overlay(0xffffff, 2, { map: roadTex(2) }), HEAT.road),
    road4.mesh(overlay(0xffffff, 2, { map: roadTex(4) }), HEAT.road),
    xings.mesh(overlay(0xffffff, 2, { map: asphaltTexture([1, 1]) }), HEAT.road),
    walks.mesh(overlay(0xffffff, 2, { map: pavingTexture([1, 1]) }), HEAT.road * 0.9),
    lots.mesh(overlay(0xffffff, 2, { map: pavingTexture([1, 1], '#8f8a80') }), HEAT.ground + 0.04),
    plazaB.mesh(overlay(0xffffff, 2, { map: pavingTexture([1, 1], '#c9b593') }), HEAT.road * 0.9),
    parkB.mesh(overlay(0xffffff, 2, { map: grassTexture([1, 1]) }), HEAT.vegetation + 0.04),
    paths.mesh(overlay(0xffffff, 4, { map: pavingTexture([1, 1], '#cbbb94') }), HEAT.road * 0.85),
    marks.mesh(overlay(0xf0f0ea, 4), HEAT.road - 0.06),
  );

  // ---- facades: office glass, residential with balconies, older plastered with ground-floor shops

  const FACADES = [
    { tex: facadeTexture({ seed: seed + 101, cols: 8, floors: 8, wall: '#3f4b57', glass: '#5f88aa', frame: '#27313a', litRatio: 0.55 }), colW: 1.6, cols: 8, floors: 8, kind: 'office' },
    { tex: facadeTexture({ seed: seed + 102, cols: 6, floors: 8, wall: '#a3adb0', glass: '#3f716d', frame: '#6c787c', litRatio: 0.5 }), colW: 2.0, cols: 6, floors: 8, kind: 'office' },
    { tex: facadeTexture({ seed: seed + 103, cols: 4, floors: 8, wall: '#ddd2bd', glass: '#56606b', frame: '#a89a82', litRatio: 0.42 }), colW: 3.0, cols: 4, floors: 8, kind: 'res' },
    { tex: facadeTexture({ seed: seed + 104, cols: 5, floors: 6, wall: '#cfa874', glass: '#3d4652', frame: '#7c6548', litRatio: 0.35, shop: true }), colW: 2.6, cols: 5, floors: 6, kind: 'old' },
    { tex: facadeTexture({ seed: seed + 105, cols: 4, floors: 8, wall: '#e0b19a', glass: '#4e5862', frame: '#b98d76', litRatio: 0.42 }), colW: 3.0, cols: 4, floors: 8, kind: 'res' },
    { tex: facadeTexture({ seed: seed + 106, cols: 5, floors: 6, wall: '#e4dfd3', glass: '#3a4a5c', frame: '#4a78a8', litRatio: 0.38, shop: true }), colW: 2.6, cols: 5, floors: 6, kind: 'old' },
    { tex: facadeTexture({ seed: seed + 107, cols: 6, floors: 8, wall: '#a8664a', glass: '#3c4650', frame: '#73452f', litRatio: 0.45 }), colW: 2.2, cols: 6, floors: 8, kind: 'office' },
  ];
  addBalconies(FACADES[2].tex, 8, 4);
  addBalconies(FACADES[4].tex, 8, 4, '#f3e6dc', '#5a4a40');
  addWeathering(FACADES[3].tex, seed + 11);
  addWeathering(FACADES[5].tex, seed + 12);
  // Shop facades (3, 5) tile once per 6 floors, so they are only used up to 6 floors.
  const facadeFor = (fl) => {
    const r = rnd();
    if (fl >= 12) return r < 0.4 ? 0 : r < 0.65 ? 1 : r < 0.8 ? 6 : 2;
    if (fl >= 7) return r < 0.35 ? 2 : r < 0.6 ? 4 : r < 0.8 ? 6 : 1;
    return r < 0.3 ? 3 : r < 0.55 ? 5 : r < 0.75 ? 2 : r < 0.9 ? 4 : 6;
  };

  // ---- building plan: low-rise around the plaza, rising to a CBD in the north-east

  const recs = [];
  for (let i = 0; i < BLOCKS.length; i++) {
    for (let j = 0; j < BLOCKS.length; j++) {
      if ((i === 3 && j === 3) || (i === PARK.i && j === PARK.j)) continue;
      const [x0, x1] = BLOCKS[i];
      const [z0, z1] = BLOCKS[j];
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3));
      const s = clamp((cx - cz) / 400, 0, 1);
      const zx0 = x0 + SW + 1.5;
      const zx1 = x1 - SW - 1.5;
      const zz0 = z0 + SW + 1.5;
      const zz1 = z1 - SW - 1.5;
      const spanX = zx1 - zx0; // 53 m, or 41 m for the central row / column
      const spanZ = zz1 - zz0;
      const block = `${i},${j}`;
      const floorsFn = () => (ring === 1
        ? 3 + Math.floor(rnd() * 4)
        : clamp(Math.round(3 + rnd() * 4 + s * 17 * (0.55 + 0.45 * rnd()) + (ring === 2 ? 1 : 0)), 3, 24));
      const push = (x, z, w, d, floors, extra = {}) => recs.push({ x, z, w, d, floors, y0: 0, block, ring, ...extra });

      if (ring >= 2 && s >= 0.6) {
        // CBD: podium with a glass tower on top.
        const pf = 3 + Math.floor(rnd() * 2);
        const pw = Math.min(50, spanX - 2);
        const pd = Math.min(50, spanZ - 2);
        push(cx, cz, pw, pd, pf, { podium: true, facade: rnd() < 0.5 ? 1 : 6 });
        const tw = Math.min(24 + rnd() * 7, pw - 8);
        const td = Math.min(24 + rnd() * 7, pd - 8);
        const tf = clamp(Math.round(14 + s * 7 + rnd() * 5), 12, 26 - pf);
        push(cx + (rnd() - 0.5) * (pw - tw) * 0.6, cz + (rnd() - 0.5) * (pd - td) * 0.6, tw, td, tf, { y0: pf * FLOOR, facade: rnd() < 0.6 ? 0 : 1 });
        continue;
      }
      const r = rnd();
      const layout = ring === 1 ? (r < 0.6 ? 'pair' : 'three') : ring === 3 ? (r < 0.3 ? 'single' : r < 0.75 ? 'pair' : 'three') : (r < 0.35 ? 'pair' : r < 0.8 ? 'three' : 'quad');
      if (layout === 'single') {
        const w = Math.min(40 + rnd() * 10, spanX - 2);
        const d = Math.min(40 + rnd() * 10, spanZ - 2);
        push(cx + (rnd() - 0.5) * (spanX - w), cz + (rnd() - 0.5) * (spanZ - d), w, d, Math.min(floorsFn(), 10));
      } else if (layout === 'pair') {
        const splitX = rnd() < 0.5;
        for (const side of [0, 1]) {
          const a = Math.min(21 + rnd() * 4, (splitX ? spanX : spanZ) / 2 - 2);
          const b = (splitX ? spanZ : spanX) - rnd() * 12;
          if (splitX) push(side ? zx1 - a / 2 : zx0 + a / 2, cz + (rnd() - 0.5) * (spanZ - b), a, b, floorsFn());
          else push(cx + (rnd() - 0.5) * (spanX - b), side ? zz1 - a / 2 : zz0 + a / 2, b, a, floorsFn());
        }
      } else {
        const skip = layout === 'three' ? Math.floor(rnd() * 4) : -1;
        for (let q = 0; q < 4; q++) {
          if (q === skip) continue;
          const qi = q & 1;
          const qj = q >> 1;
          const w = Math.min(17 + rnd() * 7, spanX / 2 - 2);
          const d = Math.min(17 + rnd() * 7, spanZ / 2 - 2);
          push(qi ? zx1 - w / 2 : zx0 + w / 2, qj ? zz1 - d / 2 : zz0 + d / 2, w, d, floorsFn());
        }
      }
    }
  }
  for (const r of recs) {
    if (r.facade === undefined) r.facade = facadeFor(r.floors);
    r.top = r.y0 + r.floors * FLOOR + 0.35;
    r.reserved = [];
  }

  // ---- rooftop hosts: phone masts and billboards

  const inBlock = (b) => recs.filter((r) => r.block === b && !r.podium);
  const billboardHosts = [];
  const bbPlan = [['4,3', '-x', 0], ['3,2', '+z', 1], ['5,3', '-x', 2]];
  for (const [b, face, tex] of bbPlan) {
    const c = inBlock(b);
    if (!c.length) continue;
    const key = (r) => (face === '-x' ? r.x - r.w / 2 : -(r.z + r.d / 2));
    c.sort((p, q) => key(p) - key(q));
    billboardHosts.push({ r: c[0], face, tex });
  }
  const mastHosts = [];
  const near = inBlock('2,3').sort((p, q) => q.floors - p.floors)[0];
  if (near) mastHosts.push({ r: near, H: 13 });
  const cands = recs.filter((r) => !r.podium && r.ring >= 2 && r.floors >= 6 && r.floors <= 16 && !billboardHosts.some((b) => b.r === r));
  for (let k = cands.length - 1; k > 0; k--) {
    const m = Math.floor(rnd() * (k + 1));
    [cands[k], cands[m]] = [cands[m], cands[k]];
  }
  for (const r of cands) {
    if (mastHosts.length >= 4) break;
    if (mastHosts.some((m) => Math.hypot(m.r.x - r.x, m.r.z - r.z) < 130)) continue;
    mastHosts.push({ r, H: 10 + Math.round(rnd() * 5) });
  }

  // ---- buildings

  const overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  const placeOnRoof = (r, sw, sd) => {
    for (let t = 0; t < 12; t++) {
      const px = r.x + (rnd() - 0.5) * Math.max(0, r.w - sw - 2.5);
      const pz = r.z + (rnd() - 0.5) * Math.max(0, r.d - sd - 2.5);
      const rect = [px - sw / 2 - 0.4, pz - sd / 2 - 0.4, px + sw / 2 + 0.4, pz + sd / 2 + 0.4];
      if (r.reserved.some((q) => overlap(q, rect))) continue;
      r.reserved.push(rect);
      return [px, pz];
    }
    return null;
  };

  const steelMat = lambert(0x8d9399);
  const whiteMat = lambert(0xe9e9e4);
  const darkMat = lambert(0x2c3034);
  const aviaMat = new MeshStandardMaterial({ color: 0x400000, emissive: new Color(0xff2a1a), emissiveIntensity: 0.6 });

  const caps = [];
  const rooms = [];
  const machines = [];
  const tanks = [];
  const roofCols = [0x6b6f75, 0x7a776f, 0x8b8378, 0x5f6367, 0x9a8f80];

  // Phone masts first so rooftop clutter keeps clear of them.
  for (const m of mastHosts) {
    const r = m.r;
    const spot = placeOnRoof(r, 3.6, 3.6);
    if (!spot) continue;
    const [mx, mz] = spot;
    const y0 = r.top;
    const H = m.H;
    const b = 0.9;
    const t = 0.35;
    const half = (y) => b + (t - b) * (y / H);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      props.rod(steelMat, HEAT.metal, new Vector3(mx + sx * b, y0, mz + sz * b), new Vector3(mx + sx * t, y0 + H, mz + sz * t), 0.07);
    }
    const step = 1.6;
    for (let y = 0; y < H - 0.1; y += step) {
      const y1 = Math.min(H, y + step);
      const h0 = half(y);
      const h1 = half(y1);
      const ring0 = [[-h0, -h0], [h0, -h0], [h0, h0], [-h0, h0]];
      const ring1 = [[-h1, -h1], [h1, -h1], [h1, h1], [-h1, h1]];
      for (let k = 0; k < 4; k++) {
        const a0 = ring0[k];
        const b1 = ring1[(k + 1) % 4];
        const a1 = ring1[k];
        props.rod(steelMat, HEAT.metal, new Vector3(mx + a0[0], y0 + y, mz + a0[1]), new Vector3(mx + b1[0], y0 + y1, mz + b1[1]), 0.035);
        props.rod(steelMat, HEAT.metal, new Vector3(mx + a1[0], y0 + y1, mz + a1[1]), new Vector3(mx + ring1[(k + 1) % 4][0], y0 + y1, mz + ring1[(k + 1) % 4][1]), 0.035);
      }
    }
    props.box(steelMat, HEAT.metal, mx, y0 + H, mz, 1.3, 0.1, 1.3);
    props.rod(steelMat, HEAT.metal, new Vector3(mx, y0 + H, mz), new Vector3(mx, y0 + H + 1.6, mz), 0.04);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.3;
      props.box(whiteMat, HEAT.metal + 0.05, mx + Math.sin(a) * 0.65, y0 + H - 0.9, mz + Math.cos(a) * 0.65, 0.32, 1.7, 0.14, a);
      const dish = new CylinderGeometry(0.38, 0.38, 0.22, 12);
      dish.rotateX(Math.PI / 2);
      dish.rotateY(a + 1);
      dish.translate(mx + Math.sin(a + 1) * 0.75, y0 + H - 3.2 - k * 0.9, mz + Math.cos(a + 1) * 0.75);
      props.add(whiteMat, dish, HEAT.metal + 0.05);
    }
    props.cyl(aviaMat, HEAT.light, mx, y0 + H + 1.7, mz, 0.12, 0.12, 0.22, 8);
    obstacles.push({ type: 'cyl', name: 'rooftop phone mast', x: mx, z: mz, r: 1.5, h: y0 + H + 1.8 });
    poi.push({ name: 'Rooftop phone mast', x: Math.round(mx), z: Math.round(mz) });
  }

  // Rooftop billboards facing the plaza / arterial.
  const adMats = [0, 1, 2].map((k) => {
    const tex = adTexture(k);
    return new MeshLambertMaterial({ map: tex, emissiveMap: tex, emissive: new Color(0x000000) });
  });
  for (const bb of billboardHosts) {
    const r = bb.r;
    const alongX = bb.face === '+z' || bb.face === '-z';
    const edgeLen = alongX ? r.w : r.d;
    const W = Math.min(10, edgeLen - 3);
    const Hb = 4.2;
    const yb = r.top + 1.6;
    const nx = bb.face === '-x' ? -1 : bb.face === '+x' ? 1 : 0;
    const nz = bb.face === '-z' ? -1 : bb.face === '+z' ? 1 : 0;
    const ex = nx ? r.x + nx * (r.w / 2 - 1.2) : r.x;
    const ez = nz ? r.z + nz * (r.d / 2 - 1.2) : r.z;
    const ry = nx ? nx * Math.PI / 2 : nz > 0 ? 0 : Math.PI;
    const plane = new PlaneGeometry(W, Hb);
    plane.rotateY(ry);
    plane.translate(ex + nx * 0.14, yb + Hb / 2, ez + nz * 0.14);
    props.add(adMats[bb.tex], plane, HEAT.metal + 0.08);
    props.box(darkMat, HEAT.metal, ex, yb + Hb / 2, ez, W + 0.3, Hb + 0.3, 0.25, ry);
    const tx = alongX ? 1 : 0;
    const tz = alongX ? 0 : 1;
    for (const k of [-0.42, 0, 0.42]) {
      const px = ex + tx * k * W - nx * 0.4;
      const pz = ez + tz * k * W - nz * 0.4;
      props.rod(steelMat, HEAT.metal, new Vector3(px, r.top, pz), new Vector3(px, yb + Hb, pz), 0.08, 6);
      props.rod(steelMat, HEAT.metal, new Vector3(px - nx * 1.6, r.top, pz - nz * 1.6), new Vector3(px, yb + Hb * 0.6, pz), 0.05, 6);
    }
    const hw = W / 2 + 0.2;
    r.reserved.push(alongX
      ? [ex - hw, Math.min(ez + nz * 1.3, ez - nz * 2.6), ex + hw, Math.max(ez + nz * 1.3, ez - nz * 2.6)]
      : [Math.min(ex + nx * 1.3, ex - nx * 2.6), ez - hw, Math.max(ex + nx * 1.3, ex - nx * 2.6), ez + hw]);
    obstacles.push(alongX
      ? { type: 'box', name: 'rooftop billboard', minX: ex - hw, maxX: ex + hw, minZ: ez - 0.5, maxZ: ez + 0.5, h: yb + Hb + 0.2 }
      : { type: 'box', name: 'rooftop billboard', minX: ex - 0.5, maxX: ex + 0.5, minZ: ez - hw, maxZ: ez + hw, h: yb + Hb + 0.2 });
  }

  recs.forEach((r, idx) => {
    const F = FACADES[r.facade];
    const h = r.floors * FLOOR;
    const g = building(obstacles, {
      x: r.x, z: r.z, w: r.w, d: r.d, h, y0: r.y0, facade: F.tex, rooftop: false, seed: seed + idx,
      name: r.y0 > 0 || r.floors >= 14 ? 'tower block' : 'building',
    });
    const ob = obstacles[obstacles.length - 1];
    slimBuilding(g, { floors: r.floors, colW: F.colW, texCols: F.cols, texFloors: F.floors });
    facadeMats.push(...(g.userData.facadeMaterials || []));
    root.add(g);
    ob.h = r.top;
    caps.push({ x: r.x, y: r.top - 0.3, z: r.z, sx: r.w + 0.3, sy: 0.6, sz: r.d + 0.3, color: pick(roofCols) });
    if (r.podium) return;
    const office = F.kind === 'office';
    // Stair / lift room ("mumty"), often with a water tank on top.
    let roomTop = 0;
    if (r.floors >= 4 && rnd() < 0.65) {
      const spot = placeOnRoof(r, 3.4, 3.0);
      if (spot) {
        const rh = 2.8;
        rooms.push({ x: spot[0], y: r.top + rh / 2, z: spot[1], sx: 3.4, sy: rh, sz: 3.0, color: office ? 0x8e949a : 0xc9c0ae });
        obstacles.push({ type: 'box', name: 'rooftop stair room', minX: spot[0] - 1.7, maxX: spot[0] + 1.7, minZ: spot[1] - 1.5, maxZ: spot[1] + 1.5, h: r.top + rh });
        roomTop = r.top + rh;
        if (!office && rnd() < 0.55) {
          tanks.push({ x: spot[0], y: roomTop + 0.7, z: spot[1], sx: 0.85, sy: 1.4, sz: 0.85, color: 0x1e1e1e });
          obstacles.push({ type: 'cyl', name: 'water tank', x: spot[0], z: spot[1], r: 0.9, h: roomTop + 1.4 });
        }
      }
    }
    // Black plastic water tanks on residential and older roofs.
    const nTanks = office ? 0 : 1 + Math.floor(rnd() * 2.6);
    for (let k = 0; k < nTanks; k++) {
      const spot = placeOnRoof(r, 1.8, 1.8);
      if (!spot) break;
      const tr = 0.7 + rnd() * 0.2;
      tanks.push({ x: spot[0], y: r.top + 0.7, z: spot[1], sx: tr, sy: 1.4, sz: tr, color: rnd() < 0.8 ? 0x1e1e1e : 0x2f6fb3 });
      obstacles.push({ type: 'cyl', name: 'water tank', x: spot[0], z: spot[1], r: tr + 0.05, h: r.top + 1.4 });
    }
    // AC condensers (residential) or cooling units (offices).
    const nMach = office ? 1 + Math.floor(rnd() * 2) : Math.floor(rnd() * 3);
    for (let k = 0; k < nMach; k++) {
      const [mw, mh, md] = office ? [2.6, 1.7, 1.8] : [0.95, 0.65, 0.55];
      const spot = placeOnRoof(r, mw, md);
      if (!spot) break;
      machines.push({ x: spot[0], y: r.top + mh / 2, z: spot[1], sx: mw, sy: mh, sz: md, color: office ? 0xb9bdc0 : 0xdcdcd6 });
      obstacles.push({ type: 'box', name: 'rooftop unit', minX: spot[0] - mw / 2, maxX: spot[0] + mw / 2, minZ: spot[1] - md / 2, maxZ: spot[1] + md / 2, h: r.top + mh });
    }
    // Obstruction lights on tall buildings.
    if (r.y0 + h >= 45) {
      for (const [sx, sz] of [[-1, -1], [1, 1]]) {
        props.cyl(aviaMat, HEAT.light, r.x + sx * (r.w / 2 - 0.3), r.top + 0.15, r.z + sz * (r.d / 2 - 0.3), 0.14, 0.14, 0.3, 8);
      }
    }
  });

  const unitBox = new BoxGeometry(1, 1, 1);
  const unitCyl = new CylinderGeometry(1, 1, 1, 14);
  root.add(tagHeat(instanced(unitBox, lambert(0xffffff), caps), HEAT.roof));
  if (rooms.length) root.add(tagHeat(instanced(unitBox, lambert(0xffffff), rooms), HEAT.roof));
  if (machines.length) root.add(tagHeat(instanced(unitBox, lambert(0xffffff), machines), HEAT.engine * 0.8));
  if (tanks.length) root.add(tagHeat(instanced(unitCyl, lambert(0xffffff), tanks), HEAT.roof + 0.05));
  const tallest = recs.reduce((a, r) => (r.top > a.top ? r : a), recs[0]);
  poi.push({ name: 'CBD towers', x: Math.round(tallest.x), z: Math.round(tallest.z) });

  // ---- street lights (one sidewalk per road, both sides around the plaza)

  const occupied = []; // { x, z, r } footprints that street trees must avoid
  const lightSpots = [];
  for (const R of ROADS) {
    for (const [a, b] of BLOCKS) {
      const n = Math.max(1, Math.round((b - a) / 25));
      for (let q = 0; q < n; q++) {
        const t = a + ((q + 0.5) * (b - a)) / n;
        // N-S road: west sidewalk with the arm reaching east (outer ring road: inner side).
        if (R === -267) lightSpots.push({ x: R + 7.6, z: t, dir: -Math.PI / 2 });
        else lightSpots.push({ x: R - 7.6, z: t, dir: Math.PI / 2 });
        // E-W road: south sidewalk with the arm reaching north.
        if (R === 267) lightSpots.push({ x: t, z: R - 7.6, dir: 0 });
        else lightSpots.push({ x: t, z: R + 7.6, dir: Math.PI });
      }
    }
  }
  for (const t of [-13, 13]) {
    lightSpots.push({ x: t, z: 25.4, dir: 0 }, { x: -25.4, z: t, dir: -Math.PI / 2 });
  }
  for (const s of lightSpots) occupied.push({ x: s.x, z: s.z, r: 1.5 });
  const lights = streetLights(obstacles, lightSpots, { height: 8, maxLights: 6 });
  root.add(consolidate(lights.group));
  nightFns.push(lights.setNight);

  // ---- traffic signals at the four plaza intersections (amber flashing)

  const lampMats = [0xff2a1a, 0xffb020, 0x30ff70].map((c) => new MeshStandardMaterial({ color: 0x202020, emissive: new Color(c), emissiveIntensity: 0.25 }));
  const amberMat = lampMats[1];
  for (const X of [-33, 33]) {
    for (const Z of [-33, 33]) {
      const poles = [
        [X - 8.2, Z + 8.2, 1, 0], [X + 8.2, Z - 8.2, -1, 0], [X - 8.2, Z - 8.2, 0, 1], [X + 8.2, Z + 8.2, 0, -1],
      ];
      for (const [px, pz, ax, az] of poles) {
        const tipX = px + ax * 4.8;
        const tipZ = pz + az * 4.8;
        props.cyl(darkMat, HEAT.metal, px, 3.05, pz, 0.09, 0.12, 6.1, 8);
        props.rod(darkMat, HEAT.metal, new Vector3(px, 5.85, pz), new Vector3(tipX, 5.85, tipZ), 0.07, 6);
        const alongX = ax !== 0;
        props.box(darkMat, HEAT.metal, tipX, 5.05, tipZ, alongX ? 0.42 : 0.36, 1.15, alongX ? 0.36 : 0.42);
        props.box(darkMat, HEAT.metal, px, 3.0, pz, 0.3, 0.75, 0.3);
        for (let k = 0; k < 3; k++) {
          const lamp = new CylinderGeometry(0.11, 0.11, 0.48, 10);
          if (alongX) lamp.rotateX(Math.PI / 2);
          else lamp.rotateZ(Math.PI / 2);
          lamp.translate(tipX, 5.42 - k * 0.36, tipZ);
          props.add(lampMats[k], lamp, HEAT.light);
        }
        occupied.push({ x: px, z: pz, r: 1.5 });
        obstacles.push({ type: 'cyl', name: 'traffic signal', x: px, z: pz, r: 0.18, h: 6.1 });
        obstacles.push({ type: 'seg', name: 'traffic signal arm', ax: px, ay: 5.85, az: pz, bx: tipX, by: 5.85, bz: tipZ, r: 0.12 });
        obstacles.push({ type: 'seg', name: 'traffic signal', ax: tipX, ay: 4.45, az: tipZ, bx: tipX, by: 5.65, bz: tipZ, r: 0.32 });
      }
    }
  }

  // ---- low-hanging telecom cables north and east of the plaza (8 m, 4 wires)

  const cableRoute = [[-100, -41.5], [-72, -41.5], [-44, -41.5], [-16, -41.5], [12, -41.5], [41.5, -41.5], [41.5, -14], [41.5, 14], [41.5, 42], [41.5, 70], [41.5, 98]];
  const cables = powerLine(obstacles, cableRoute.map(([x, z]) => ({ x, z })), { height: 8, wires: 4, sag: 0.45, spread: 0.6, name: 'overhead cable', poleColor: 0x6e6a64 });
  root.add(consolidate(cables));
  for (const [x, z] of cableRoute) occupied.push({ x, z, r: 1.5 });
  mapLines.push([cableRoute, '#e8a23a', 1.5]);
  poi.push({ name: 'Overhead cables (8 m)', x: 41.5, z: -41.5 });
  const segDist = (px, pz, a, b) => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const t = clamp(((px - a[0]) * dx + (pz - a[1]) * dz) / (dx * dx + dz * dz), 0, 1);
    return Math.hypot(px - a[0] - t * dx, pz - a[1] - t * dz);
  };
  const nearCable = (x, z, d) => cableRoute.some((p, k) => k > 0 && segDist(x, z, cableRoute[k - 1], p) < d);
  const freeSpot = (x, z, r) => occupied.every((o) => Math.hypot(o.x - x, o.z - z) >= r + o.r) && !nearCable(x, z, 6);

  // ---- trees: street trees, park trees and plaza palms

  const treeSpots = [];
  const spacing = 16 / QS;
  const streetRows = [
    { axis: 'z', c: -111 - 9.6 }, { axis: 'z', c: -111 + 9.6 }, { axis: 'x', c: 111 + 9.6 },
    { axis: 'x', c: 33 + 9.6 }, { axis: 'z', c: -33 - 9.6 },
  ];
  for (const row of streetRows) {
    for (const [a, b] of BLOCKS) {
      const n = Math.max(1, Math.floor((b - a - 12) / spacing) + 1);
      for (let q = 0; q < n; q++) {
        const t = n === 1 ? (a + b) / 2 : a + 6 + (q * (b - a - 12)) / (n - 1);
        const x = row.axis === 'z' ? row.c : t;
        const z = row.axis === 'z' ? t : row.c;
        if (!freeSpot(x, z, 3)) continue;
        treeSpots.push({ x, z, s: 0.6 + rnd() * 0.12, kind: 'broad' });
        occupied.push({ x, z, r: 2 });
      }
    }
  }
  const inPathZone = (x, z, m) => parkPaths.some(([a, b, c, d]) => x > a - m && x < c + m && z > b - m && z < d + m);
  const parkTrees = Math.round(26 * QS);
  for (let k = 0, tries = 0; k < parkTrees && tries < 600; tries++) {
    const x = -99 + rnd() * 54;
    const z = -99 + rnd() * 54;
    if (inPathZone(x, z, 3) || !freeSpot(x, z, 3)) continue;
    treeSpots.push({ x, z, s: 0.8 + rnd() * 0.35, kind: rnd() < 0.22 ? 'pine' : 'broad' });
    occupied.push({ x, z, r: 2.5 });
    k++;
  }
  const stoneMat = lambert(0xbdb5a4);
  for (const [x, z] of [[19, -19], [-19, -19], [19, 19]]) {
    treeSpots.push({ x, z, s: 0.8, kind: 'palm' });
    props.cyl(stoneMat, HEAT.ground, x, 0.25, z, 1.5, 1.6, 0.5, 18);
  }
  const tr = trees(obstacles, treeSpots, { seed: seed + 5 });
  root.add(tr.group);
  swayMaterials.push(...tr.swayMaterials);
  poi.push({ name: 'Park', x: -72, z: -72 });

  // ---- street furniture helpers

  const woodMat = lambert(0x8a5a34);
  const partBox = (mat, heat, w, h, d, lx, ly, lz, ry, x, z) => {
    const g = new BoxGeometry(w, h, d);
    g.translate(lx, ly, lz);
    g.rotateY(ry);
    g.translate(x, 0, z);
    props.add(mat, g, heat);
  };
  // Bench whose sitter faces direction (-sin ry, -cos ry).
  const bench = (x, z, ry) => {
    partBox(woodMat, HEAT.ground, 1.8, 0.08, 0.5, 0, 0.45, 0, ry, x, z);
    partBox(woodMat, HEAT.ground, 1.8, 0.45, 0.06, 0, 0.75, 0.24, ry, x, z);
    for (const s of [-0.75, 0.75]) partBox(darkMat, HEAT.metal, 0.08, 0.45, 0.5, s, 0.22, 0, ry, x, z);
    obstacles.push({ type: 'cyl', name: 'bench', x, z, r: 1.0, h: 1.0 });
  };
  const faceTo = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));

  // ---- plaza: fountain, planters, kiosks, bollards, benches

  const F = { x: -14, z: -14 };
  props.cyl(stoneMat, HEAT.ground, F.x, 0.35, F.z, 3.6, 3.7, 0.7, 32);
  props.cyl(stoneMat, HEAT.ground, F.x, 0.85, F.z, 0.45, 0.5, 1.7, 12);
  props.cyl(stoneMat, HEAT.ground, F.x, 1.85, F.z, 1.3, 0.5, 0.35, 20);
  const waterMat = new MeshStandardMaterial({ color: 0x3f7f9f, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.88 });
  props.cyl(waterMat, HEAT.water, F.x, 0.66, F.z, 3.32, 3.32, 0.06, 32);
  const spray = new Mesh(new CylinderGeometry(0.08, 0.6, 1.1, 14, 1, true), new MeshStandardMaterial({ color: 0xdff2ff, transparent: true, opacity: 0.5, side: DoubleSide, depthWrite: false }));
  spray.position.set(F.x, 2.55, F.z);
  root.add(tagHeat(spray, HEAT.water));
  obstacles.push({ type: 'cyl', name: 'fountain', x: F.x, z: F.z, r: 3.7, h: 0.75 });
  obstacles.push({ type: 'cyl', name: 'fountain', x: F.x, z: F.z, r: 1.35, h: 3.2 });
  poi.push({ name: 'Fountain', x: F.x, z: F.z });
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const bx = F.x + Math.cos(a) * 6.2;
    const bz = F.z + Math.sin(a) * 6.2;
    bench(bx, bz, faceTo(bx, bz, F.x, F.z));
  }
  bench(8, 20.6, faceTo(8, 20.6, 8, 0));
  bench(-8, 20.6, faceTo(-8, 20.6, -8, 0));

  const soilMat = lambert(0x5a4330);
  const planters = [[14, -12, 6, 1.8], [-14, 9, 1.8, 6], [14, 9, 6, 1.8]];
  const bushSpots = [];
  for (const [x, z, w, d] of planters) {
    props.box(stoneMat, HEAT.ground, x, 0.3, z, w, 0.6, d);
    props.box(soilMat, HEAT.soil, x, 0.61, z, w - 0.3, 0.04, d - 0.3);
    obstacles.push({ type: 'box', name: 'planter', minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h: 1.3 });
    for (let k = -1; k <= 1; k++) bushSpots.push({ x: x + (w > d ? k * w * 0.3 : 0), z: z + (w > d ? 0 : k * d * 0.3), s: 0.75 });
  }
  const inPlanter = (x, z) => planters.some(([px, pz, w, d]) => Math.abs(x - px) < w / 2 && Math.abs(z - pz) < d / 2);

  const kioskBody = lambert(0xc4462a);
  const awningMat = lambert(0xf2c230);
  for (const [kx, kz, dir] of [[20.2, -2, -1], [-20.2, -4, 1]]) {
    props.box(kioskBody, HEAT.building + 0.08, kx, 1.25, kz, 2.0, 2.5, 2.6);
    props.box(awningMat, HEAT.building, kx + dir * 1.45, 2.35, kz, 0.9, 0.08, 2.9);
    props.box(whiteMat, HEAT.building, kx + dir * 1.02, 1.0, kz, 0.06, 0.12, 2.4);
    obstacles.push({ type: 'box', name: 'kiosk', minX: Math.min(kx - 1, kx + dir * 1.9), maxX: Math.max(kx + 1, kx + dir * 1.9), minZ: kz - 1.45, maxZ: kz + 1.45, h: 2.6 });
  }

  const bollards = [];
  for (let k = 0; k < 8; k++) {
    const t = -19.25 + k * 5.5;
    for (const [x, z] of [[t, -22.6], [t, 22.6], [-22.6, t], [22.6, t]]) {
      if (Math.hypot(x + 20, z - 20) < 3) continue; // windsock corner
      bollards.push({ x, y: 0.45, z });
      obstacles.push({ type: 'cyl', name: 'bollard', x, z, r: 0.15, h: 0.9 });
    }
  }
  root.add(tagHeat(instanced(new CylinderGeometry(0.11, 0.13, 0.9, 8), lambert(0x3a3d40), bollards), HEAT.metal));

  const ws = windsock(obstacles, -20, 20, { height: 6 });
  root.add(ws.group);

  // The plaza paving sits at YS (0.03 m), so the pad goes just above it.
  const pad = homePad({ y: 0.045 });
  root.add(consolidate(pad.group));
  nightFns.push(pad.setNight);
  root.add(consolidate(pilotPost(obstacles, 0, 16)));

  // ---- park: pavilion, benches, lamps, bushes

  const P = { x: -72, z: -72 };
  props.cyl(stoneMat, HEAT.ground, P.x, 0.15, P.z, 3.3, 3.4, 0.3, 16);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    props.cyl(whiteMat, HEAT.building, P.x + Math.cos(a) * 2.7, 1.65, P.z + Math.sin(a) * 2.7, 0.13, 0.15, 3.0, 8);
  }
  const roofGeo = new ConeGeometry(3.7, 1.9, 8);
  roofGeo.translate(P.x, 4.1, P.z);
  props.add(lambert(0xa4532e), roofGeo, HEAT.roof);
  obstacles.push({ type: 'cyl', name: 'park pavilion', x: P.x, z: P.z, r: 3.7, h: 5.1 });
  for (const [bx, bz, ry] of [[-75.4, -88, -Math.PI / 2], [-75.4, -57, -Math.PI / 2], [-68.6, -84, Math.PI / 2], [-68.6, -60, Math.PI / 2], [-88, -75.4, Math.PI], [-57, -75.4, Math.PI]]) {
    bench(bx, bz, ry);
  }
  const parkLights = streetLights(obstacles, [
    { x: -69.4, z: -88, dir: -Math.PI / 2 }, { x: -69.4, z: -56, dir: -Math.PI / 2 },
    { x: -88, z: -69.4, dir: Math.PI }, { x: -56, z: -69.4, dir: Math.PI },
  ], { height: 4.5, maxLights: 0 });
  root.add(consolidate(parkLights.group));
  nightFns.push(parkLights.setNight);
  const parkBushes = Math.round(40 * QS);
  for (let k = 0, tries = 0; k < parkBushes && tries < 800; tries++) {
    const x = -99 + rnd() * 54;
    const z = -99 + rnd() * 54;
    if (inPathZone(x, z, 0.8) || !inPathZone(x, z, 3.5) || Math.hypot(x - P.x, z - P.z) < 5) continue;
    bushSpots.push({ x, z, s: 0.8 + rnd() * 0.6 });
    k++;
  }
  root.add(bushes(bushSpots, { seed: seed + 6, groundHeight: (x, z) => (inPlanter(x, z) ? 0.62 : 0) }));

  // ---- vehicles: instanced cars and trucks (traffic drives on the LEFT)

  const headMat = new MeshStandardMaterial({ color: 0xeeeeee, emissive: new Color(0xfff2d0), emissiveIntensity: 0.3 });
  const tailMat = new MeshStandardMaterial({ color: 0x550000, emissive: new Color(0xff2010), emissiveIntensity: 0.3 });
  const lightPair = (w, h, d, x, y, z) => mergeAll([-1, 1].map((s) => new BoxGeometry(w, h, d).translate(s * x, y, z)));
  const vehicleKind = (template, rotateY, bodyKey, lights) => {
    const parts = harvest(template, rotateY);
    const list = [...parts.entries()];
    list.sort((a, b) => (a[0] === bodyKey ? -1 : b[0] === bodyKey ? 1 : 0));
    const out = list.map(([, p]) => p);
    out[0].material.color.set(0xffffff); // tinted per instance
    out.push({ geometry: lights.head, material: headMat, heat: HEAT.light }, { geometry: lights.tail, material: tailMat, heat: HEAT.vehicle });
    return out;
  };
  const carKind = vehicleKind(car(0xffffff, { seed: seed + 9 }), 0, 0xffffff, {
    head: lightPair(0.36, 0.16, 0.06, 0.58, 0.75, -2.12), tail: lightPair(0.32, 0.14, 0.06, 0.62, 0.78, 2.12),
  });
  const truckKind = vehicleKind(truck(0xffffff), Math.PI, 0xffffff, {
    head: lightPair(0.34, 0.2, 0.06, 0.8, 1.0, -3.62), tail: lightPair(0.3, 0.18, 0.06, 0.95, 0.75, 3.98),
  });
  const CAR = { hw: 0.9, hl: 2.15, h: 1.6 };
  const TRUCK = { hw: 1.2, hl: 3.98, h: 3.2 };

  const loops = [
    // Plaza ring: every turn is a left turn, inner lane.
    { corners: [[29.5, 29.5], [29.5, -29.5], [-29.5, -29.5], [-29.5, 29.5]], R: 6, n: 4, speed: 8.5, trucks: [] },
    // 4-lane arterial ring: right turns, kerb (left) lane.
    { corners: [[116.25, -116.25], [116.25, 116.25], [-116.25, 116.25], [-116.25, -116.25]], R: 7, n: 6, speed: 11, trucks: [2, 5] },
    // North-east loop toward the CBD.
    { corners: [[36.5, -36.5], [185.5, -36.5], [185.5, -185.5], [36.5, -185.5]], R: 7, n: 4, speed: 9.5, trucks: [1] },
  ];
  const carColors = [0xf2f2ee, 0xf2f2ee, 0xb8bcc0, 0x6b6f75, 0xb02a2a, 0x2a4f8a, 0x1d1f22, 0xf2c230, 0x8a2a3a, 0xd8d2c0];
  const truckColors = [0xe06a1a, 0x2f6b3a, 0x2a4f8a, 0xc23b22];
  const movers = [];
  for (const L of loops) {
    const path = lanePath(L.corners, L.R);
    const n = Math.max(1, Math.round(L.n * QS));
    for (let k = 0; k < n; k++) {
      const isTruck = L.trucks.includes(Math.round((k * L.n) / n)) && L.trucks.length > 0;
      movers.push({ path, s: ((k + rnd() * 0.3) * path.total) / n, speed: L.speed, truck: isTruck });
    }
  }

  // Parked cars along the kerbs of 2-lane streets near the plaza.
  const slots = [];
  for (const R of [-189, -33, 33, 189]) {
    for (const [a, b] of BLOCKS) {
      if (Math.abs((a + b) / 2) > 150) continue;
      for (let t = a + 12; t <= b - 12; t += 6.5) {
        slots.push({ x: R - 5.9, z: t, ry: 0 }, { x: R + 5.9, z: t, ry: Math.PI });
        slots.push({ x: t, z: R - 5.9, ry: -Math.PI / 2 }, { x: t, z: R + 5.9, ry: Math.PI / 2 });
      }
    }
  }
  const nearSlots = slots.filter((s) => Math.hypot(s.x, s.z) < 140);
  for (let k = nearSlots.length - 1; k > 0; k--) {
    const m = Math.floor(rnd() * (k + 1));
    [nearSlots[k], nearSlots[m]] = [nearSlots[m], nearSlots[k]];
  }
  const parked = nearSlots.slice(0, Math.max(3, Math.round(12 * QS)));

  const nCars = movers.filter((m) => !m.truck).length + parked.length;
  const nTrucks = movers.filter((m) => m.truck).length;
  const cars = new Fleet(carKind, nCars);
  const trucksF = new Fleet(truckKind, nTrucks);
  for (const m of [...cars.meshes, ...trucksF.meshes]) root.add(m);
  const col = new Color();
  let ci = 0;
  let ti = 0;
  for (const m of movers) {
    m.fleet = m.truck ? trucksF : cars;
    m.index = m.truck ? ti++ : ci++;
    m.dims = m.truck ? TRUCK : CAR;
    m.fleet.color(0, m.index, col.set(m.truck ? pick(truckColors) : pick(carColors)));
    m.ob = { type: 'box', name: m.truck ? 'truck' : 'car', dynamic: true, minX: 0, maxX: 0, minZ: 0, maxZ: 0, h: m.dims.h };
    obstacles.push(m.ob);
  }
  for (const p of parked) {
    const i = ci++;
    cars.place(i, p.x, 0, p.z, p.ry);
    cars.color(0, i, col.set(pick(carColors)));
    const [hx, hz] = aabbHalf(p.ry, CAR.hw, CAR.hl);
    obstacles.push({ type: 'box', name: 'parked car', minX: p.x - hx, maxX: p.x + hx, minZ: p.z - hz, maxZ: p.z + hz, h: CAR.h });
  }
  const _at = { x: 0, z: 0, ry: 0 };
  const moveTraffic = (dt) => {
    for (const m of movers) {
      m.s += m.speed * dt;
      m.path.at(m.s, _at);
      m.fleet.place(m.index, _at.x, 0, _at.z, _at.ry);
      const [hx, hz] = aabbHalf(_at.ry, m.dims.hw, m.dims.hl);
      m.ob.minX = _at.x - hx;
      m.ob.maxX = _at.x + hx;
      m.ob.minZ = _at.z - hz;
      m.ob.maxZ = _at.z + hz;
    }
    cars.flush();
    trucksF.flush();
  };
  moveTraffic(0);

  // ---- people (thermal targets; no obstacles)

  const personKind = [...harvest(person(0xffffff, { pants: 0x808080, skin: 0x404040 })).entries()]
    .sort((a, b) => [0x808080, 0xffffff, 0x404040].indexOf(a[0]) - [0x808080, 0xffffff, 0x404040].indexOf(b[0]))
    .map(([, p]) => {
      p.material.color.set(0xffffff);
      return { ...p, heat: HEAT.person };
    });
  const peopleDef = [
    { a: [-16.4, -9], b: [-16.4, 4], v: 1.0 },
    { a: [-72, -94], b: [-72, -78], v: 1.0 },
    { x: -9.6, z: -7.9, ry: 2.4 },
    { a: [-16, -21], b: [16, -21], v: 1.2 },
    { a: [-94, -72], b: [-78, -72], v: 0.9 },
    { x: 17.7, z: -2.3, ry: -Math.PI / 2 },
    { a: [16, -9], b: [16, 6], v: 1.0 },
    { a: [-97, -96.7], b: [-48, -96.7], v: 1.2 },
    { x: -17.7, z: -4.4, ry: Math.PI / 2 },
    { a: [3, 21.7], b: [16, 21.7], v: 0.8 },
    { a: [-72, -66], b: [-72, -50], v: 1.1 },
    { x: -12, z: 4, ry: 0.6 },
    { x: -60, z: -70.8, ry: 1.2 },
  ];
  const nPeople = Math.max(4, Math.round(peopleDef.length * QS));
  const walkers = peopleDef.slice(0, nPeople).map((d) => ({ ...d, phase: rnd() }));
  const crowd = new Fleet(personKind, walkers.length);
  for (const m of crowd.meshes) root.add(m);
  const shirts = [0xd94b3c, 0x2f6fb3, 0xf0c419, 0x3a9b5c, 0xe8e2d0, 0x8e44ad, 0xf27c38, 0xe0607e];
  const pants = [0x2b2b30, 0x3b4a6b, 0x5b4a3a, 0xd8d0c0, 0x1f2a44];
  const skins = [0xc68e62, 0xa86f4c, 0x8d5a3b, 0xd9a47c];
  walkers.forEach((w, i) => {
    crowd.color(0, i, col.set(pick(pants)));
    crowd.color(1, i, col.set(pick(shirts)));
    crowd.color(2, i, col.set(pick(skins)));
    if (w.a) w.len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  });
  const moveCrowd = (dt, t) => {
    walkers.forEach((w, i) => {
      if (!w.a) {
        crowd.place(i, w.x, 0, w.z, w.ry + Math.sin(t * 0.3 + i) * 0.4);
        return;
      }
      w.phase = (w.phase + (w.v * dt) / (2 * w.len)) % 1;
      const fwd = w.phase < 0.5;
      const k = fwd ? w.phase * 2 : 2 - w.phase * 2;
      const x = w.a[0] + (w.b[0] - w.a[0]) * k;
      const z = w.a[1] + (w.b[1] - w.a[1]) * k;
      const dx = (w.b[0] - w.a[0]) * (fwd ? 1 : -1);
      const dz = (w.b[1] - w.a[1]) * (fwd ? 1 : -1);
      crowd.place(i, x, Math.abs(Math.sin(t * 6 + i)) * 0.03, z, Math.atan2(-dx, -dz));
    });
    crowd.flush();
  };
  moveCrowd(0, 0);

  // ---- beyond the ring road: low-detail skyline silhouettes and hills (no obstacles)

  const distTex = distantTextures();
  const distMat = new MeshLambertMaterial({ map: distTex.map, emissiveMap: distTex.emissiveMap, emissive: new Color(0x000000) });
  const far = [];
  const nFar = Math.round(300 * QS);
  const farTints = [0xd8d2c4, 0xc9c3b8, 0xbfc4c8, 0xe0d0b8, 0xb0b6ba];
  for (let k = 0, tries = 0; k < nFar && tries < nFar * 25; tries++) {
    const a = rnd() * Math.PI * 2;
    const rad = 320 + Math.pow(rnd(), 1.4) * 680;
    const x = Math.cos(a) * rad;
    const z = Math.sin(a) * rad;
    const w = 16 + rnd() * 30;
    const d = 16 + rnd() * 30;
    if (Math.max(Math.abs(x) - w / 2, Math.abs(z) - d / 2) < 300) continue;
    if ([-111, 111].some((R) => Math.abs(x - R) < HALF + 5 + w / 2 || Math.abs(z - R) < HALF + 5 + d / 2)) continue;
    const s = clamp((x - z) / 1400, 0, 1);
    const h = 9 + rnd() * 24 + s * 60 * rnd();
    far.push({ x, y: h / 2, z, sx: w, sy: h, sz: d, color: pick(farTints) });
    k++;
  }
  const farMesh = instanced(new BoxGeometry(1, 1, 1), distMat, far, { castShadow: false, receiveShadow: false });
  root.add(tagHeat(farMesh, HEAT.building));
  const hills = consolidate(horizonHills({ seed: seed + 99, radius: 1400, color: 0x76806e }));
  hills.traverse((o) => {
    if (o.isMesh) o.castShadow = false;
  });
  root.add(tagHeat(hills, HEAT.ground));

  // Merge all static props (masts, billboards, signals, plaza and park furniture) per material.
  props.flush(root);

  // ---- night, animation, minimap

  const setNight = (k) => {
    night = k;
    lightWindows(facadeMats, k);
    distMat.emissive.setScalar(k * 0.75);
    for (const m of adMats) m.emissive.setScalar(k * 0.9);
    headMat.emissiveIntensity = 0.3 + k * 3;
    tailMat.emissiveIntensity = 0.3 + k * 2;
    lampMats[0].emissiveIntensity = 0.06;
    lampMats[2].emissiveIntensity = 0.06;
    for (const f of nightFns) f(k);
  };
  setNight(0);

  const update = (dt, t, windAt) => {
    const step = Math.min(Math.max(dt || 0, 0), 0.1);
    const time = t || 0;
    moveTraffic(step);
    moveCrowd(step, time);
    if (windAt) ws.update(step, windAt(-20, 6, 20, _w) || _w);
    // Signals run in flashing-amber mode; obstruction lights blink at night.
    amberMat.emissiveIntensity = Math.sin(time * Math.PI * 1.6) > 0 ? 1.6 + night * 1.5 : 0.06;
    aviaMat.emissiveIntensity = night > 0.3 ? (time % 1.5 < 0.5 ? 3.5 : 0.25) : 0.8;
    spray.scale.y = 1 + Math.sin(time * 7) * 0.06;
  };

  const mapPaint = (c, toPx) => {
    for (const [x0, z0, x1, z1, fill] of mapRects) paintRect(c, toPx, x0, z0, x1, z1, fill);
    for (const [pts, stroke, w] of mapLines) paintPolyline(c, toPx, pts, stroke, w);
  };

  return {
    root,
    obstacles,
    groundHeight: () => 0,
    pilot: { x: 0, z: 16 },
    setNight,
    update,
    swayMaterials,
    patterns: false,
    mapPaint,
    mapExtent: 180,
    poi,
    dispose() {
      disposeTree(root);
    },
  };
}
