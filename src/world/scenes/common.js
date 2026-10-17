// Shared building blocks for DronoSim scenes.
//
// SCENE INTERFACE: a scene module exports `build(ctx)` returning a SceneInstance:
// {
//   root: Group                      all scene content (the engine adds it to the THREE scene)
//   obstacles: Obstacle[]            collision primitives (see below); may be mutated for moving objects
//   groundHeight(x, z): number       terrain height in metres; MUST return 0 within 8 m of the origin (home pad)
//   pilot: { x, z }                  pilot station ground position (eye height is added by the camera)
//   setNight(k): void                0 = day .. 1 = night (street lights, lit windows, pad lights)
//   update(dt, t, windAt): void      animations; windAt(x, y, z) returns a Vector3 wind velocity (m/s)
//   swayMaterials: Material[]        foliage materials that the engine patches with wind sway
//   mapPaint(ctx, toPx, mpp): void   minimap ground features (roads, water, fields); obstacles are drawn by the engine
//   mapExtent: number                half-size of the minimap area in metres
//   poi: [{ name, x, z }]            points of interest for the minimap / sensors
//   dispose(): void
// }
// ctx = { quality: 'low' | 'medium' | 'high', seed: number }
//
// Obstacles (h is the ABSOLUTE world height of the top, so obstacles on terrain include ground height):
//   { type: 'cyl', name, x, z, r, h }
//   { type: 'box', name, minX, maxX, minZ, maxZ, h }
//   { type: 'seg', name, ax, ay, az, bx, by, bz, r }   thin capsule, e.g. a power line wire
//
// Thermal camera: tag meshes with userData.heat in 0..1 via tagHeat(); untagged meshes use HEAT.ground.

import {
  BoxGeometry, CanvasTexture, CatmullRomCurve3, Color, ConeGeometry, CylinderGeometry, DoubleSide,
  Float32BufferAttribute, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial,
  MeshStandardMaterial, PlaneGeometry, PointLight, Quaternion, RepeatWrapping, SRGBColorSpace, TubeGeometry, Vector3,
} from 'three';
import { clamp, mulberry32 } from '../../util/math.js';
import { barkTexture, helipadTexture, labelTexture, windsockTexture } from '../textures.js';

export { barkTexture, grassTexture, helipadTexture, labelTexture, mowedTexture, windsockTexture } from '../textures.js';
export { mulberry32 };

export const QUALITY_SCALE = { low: 0.4, medium: 0.7, high: 1 };

export const HEAT = {
  sky: 0, water: 0.08, vegetation: 0.22, ground: 0.33, soil: 0.42, road: 0.5, building: 0.38, roof: 0.55, metal: 0.45,
  vehicle: 0.72, engine: 0.92, person: 0.97, transformer: 0.88, solar: 0.6, hotspot: 1, light: 0.8,
};

export function tagHeat(obj, heat) {
  obj.traverse((o) => {
    if (o.isMesh) o.userData.heat = heat;
  });
  return obj;
}

// ---------------------------------------------------------------- noise

export function makeNoise2D(seed = 1) {
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = (h, x, y) => {
    const g = h & 7;
    const u = g < 4 ? x : y;
    const v = g < 4 ? y : x;
    return ((g & 1) ? -u : u) + ((g & 2) ? -2 * v : 2 * v);
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  // Perlin gradient noise, roughly -1..1
  function noise(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[X] + Y];
    const ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y];
    const bb = perm[perm[X + 1] + Y + 1];
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
    return (x1 + v * (x2 - x1)) * 0.5;
  }
  function fbm(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let a = 1;
    let f = 1;
    let s = 0;
    let n = 0;
    for (let i = 0; i < octaves; i++) {
      s += a * noise(x * f, y * f);
      n += a;
      a *= gain;
      f *= lacunarity;
    }
    return s / n;
  }
  return { noise, fbm };
}

export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- textures

export function canvasTexture(w, h, draw, { repeat = null, srgb = true, anisotropy = 8 } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new CanvasTexture(c);
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.anisotropy = anisotropy;
  if (repeat) {
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

export function speckle(ctx, w, h, rnd, colors, count, size) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
    const s = size * (0.5 + rnd());
    ctx.fillRect(rnd() * w, rnd() * h, s, s * (1 + rnd()));
  }
}

export function asphaltTexture(repeat) {
  const rnd = mulberry32(21);
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#3b3e42';
    ctx.fillRect(0, 0, 256, 256);
    speckle(ctx, 256, 256, rnd, ['#45484d', '#323438', '#4c4f53', '#2c2e31'], 7000, 1.4);
  }, { repeat });
}

// A road segment texture: asphalt with a dashed centre line, edge lines. v runs along the road.
export function roadTexture({ lanes = 2 } = {}) {
  const rnd = mulberry32(22);
  return canvasTexture(256, 512, (ctx, w, h) => {
    ctx.fillStyle = '#3a3d41';
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rnd, ['#45484d', '#323438', '#4c4f53'], 9000, 1.3);
    ctx.fillStyle = '#e8e8e2';
    ctx.fillRect(8, 0, 5, h);
    ctx.fillRect(w - 13, 0, 5, h);
    ctx.fillStyle = '#f2c230';
    for (let y = 0; y < h; y += 128) ctx.fillRect(w / 2 - 3, y + 16, 6, 64);
    if (lanes >= 4) {
      ctx.fillStyle = '#e8e8e2';
      for (let y = 0; y < h; y += 128) {
        ctx.fillRect(w / 4 - 2, y + 30, 4, 50);
        ctx.fillRect((3 * w) / 4 - 2, y + 30, 4, 50);
      }
    }
  });
}

export function pavingTexture(repeat, base = '#a9a59b') {
  const rnd = mulberry32(23);
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rnd, ['rgba(0,0,0,0.08)', 'rgba(255,255,255,0.08)'], 3000, 2);
    ctx.strokeStyle = 'rgba(60,55,50,0.35)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (i * h) / 4);
      ctx.lineTo(w, (i * h) / 4);
      ctx.moveTo((i * w) / 4, 0);
      ctx.lineTo((i * w) / 4, h);
      ctx.stroke();
    }
  }, { repeat });
}

export function soilTexture(repeat, { base = '#7a5a3c', rows = 0, rowColor = '#5e432c' } = {}) {
  const rnd = mulberry32(24);
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rnd, ['rgba(0,0,0,0.15)', 'rgba(255,240,220,0.08)', 'rgba(60,40,20,0.2)'], 6000, 1.6);
    if (rows) {
      ctx.fillStyle = rowColor;
      for (let i = 0; i < rows; i++) ctx.fillRect(0, (i + 0.5) * (h / rows) - 2, w, 4);
    }
  }, { repeat });
}

// Crop field: rows of plants (v direction) over soil.
export function cropTexture(repeat, { soil = '#6b4f33', plant = '#5f9a3a', plant2 = '#7cb24a', rows = 8, density = 0.8 } = {}) {
  const rnd = mulberry32(25);
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = soil;
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rnd, ['rgba(0,0,0,0.15)', 'rgba(255,255,255,0.05)'], 2000, 1.5);
    const rw = w / rows;
    for (let r = 0; r < rows; r++) {
      const cx = (r + 0.5) * rw;
      for (let i = 0; i < 260 * density; i++) {
        ctx.fillStyle = rnd() < 0.5 ? plant : plant2;
        const y = rnd() * h;
        const s = 3 + rnd() * rw * 0.45;
        ctx.beginPath();
        ctx.ellipse(cx + (rnd() - 0.5) * rw * 0.35, y, s * 0.5, s * 0.8, rnd() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, { repeat });
}

// Building facade with a window grid. Returns { map, emissiveMap } so windows light up at night.
export function facadeTexture({ seed = 1, cols = 6, floors = 8, wall = '#c9c2b5', glass = '#4a5a6a', frame = '#8a8478', litRatio = 0.45, shop = false } = {}) {
  const rnd = mulberry32(seed);
  const W = 256;
  const H = 512;
  const lit = [];
  const map = canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, W, H);
    speckle(ctx, W, H, rnd, ['rgba(0,0,0,0.05)', 'rgba(255,255,255,0.05)'], 1500, 2);
    const cw = W / cols;
    const fh = H / floors;
    for (let f = 0; f < floors; f++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cw + cw * 0.18;
        const y = f * fh + fh * 0.22;
        const ww = cw * 0.64;
        const wh = fh * 0.56;
        const ground = shop && f === floors - 1;
        ctx.fillStyle = frame;
        ctx.fillRect(x - 2, y - 2, ww + 4, (ground ? fh * 0.7 : wh) + 4);
        const shade = 0.75 + rnd() * 0.35;
        const g = new Color(glass).multiplyScalar(shade);
        ctx.fillStyle = `#${g.getHexString()}`;
        ctx.fillRect(x, y, ww, ground ? fh * 0.7 : wh);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x, y, ww * 0.35, ground ? fh * 0.7 : wh);
        if (rnd() < litRatio || ground) lit.push([x, y, ww, ground ? fh * 0.7 : wh]);
      }
    }
  });
  const emissiveMap = canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    for (const [x, y, w, h] of lit) {
      const warm = rnd();
      ctx.fillStyle = warm < 0.6 ? '#ffd9a0' : warm < 0.85 ? '#fff4e0' : '#b8d8ff';
      ctx.fillRect(x, y, w, h);
    }
  });
  return { map, emissiveMap };
}

export function solarPanelTexture() {
  return canvasTexture(256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#c9ced4';
    ctx.fillRect(0, 0, w, h);
    const cols = 12;
    const rows = 6;
    const cw = (w - 8) / cols;
    const ch = (h - 8) / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = (r + c) % 2 ? '#1b2d55' : '#1e3260';
        ctx.fillRect(4 + c * cw + 1, 4 + r * ch + 1, cw - 2, ch - 2);
      }
    }
  });
}

// ---------------------------------------------------------------- materials

export function lambert(color, opts = {}) {
  return new MeshLambertMaterial({ color, ...opts });
}

export function standard(color, opts = {}) {
  return new MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...opts });
}

export function flat(color, opts = {}) {
  return new MeshLambertMaterial({ color, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...opts });
}

// ---------------------------------------------------------------- geometry helpers

export function groundPlane(size, material, y = 0) {
  const g = new PlaneGeometry(size, size);
  g.rotateX(-Math.PI / 2);
  const m = new Mesh(g, material);
  m.position.y = y;
  m.receiveShadow = true;
  return m;
}

// Flat strip lying on the ground between two points (roads, paths). uv.v runs along the strip in metres / vRepeatMetres.
export function strip(ax, az, bx, bz, width, y, material, vRepeatMetres = 8) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  const g = new PlaneGeometry(width, len);
  g.rotateX(-Math.PI / 2);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * (len / vRepeatMetres));
  const m = new Mesh(g, material);
  m.position.set((ax + bx) / 2, y, (az + bz) / 2);
  m.rotation.y = Math.atan2(dx, dz);
  m.receiveShadow = true;
  return m;
}

// Heightfield terrain mesh. heightFn(x, z) in world metres; colorFn optional (vertex colours).
export function terrainMesh({ size, segments, heightFn, material, centerX = 0, centerZ = 0, colorFn = null }) {
  const g = new PlaneGeometry(size, size, segments, segments);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  const colors = colorFn ? new Float32Array(pos.count * 3) : null;
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + centerX;
    const z = pos.getZ(i) + centerZ;
    const y = heightFn(x, z);
    pos.setY(i, y);
    if (colors) {
      colorFn(x, z, y, c);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
  }
  if (colors) g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const m = new Mesh(g, material);
  m.position.set(centerX, 0, centerZ);
  m.receiveShadow = true;
  return m;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();
const _p = new Vector3();
const _e = new Vector3(0, 1, 0);

// items: [{ x, y, z, sx, sy, sz, ry, color }]
export function instanced(geometry, material, items, { castShadow = true, receiveShadow = true } = {}) {
  const im = new InstancedMesh(geometry, material, Math.max(items.length, 1));
  const col = new Color();
  items.forEach((it, i) => {
    _q.setFromAxisAngle(_e, it.ry || 0);
    _m.compose(_p.set(it.x, it.y || 0, it.z), _q, _s.set(it.sx ?? 1, it.sy ?? 1, it.sz ?? 1));
    im.setMatrixAt(i, _m);
    if (it.color !== undefined) im.setColorAt(i, col.set(it.color));
  });
  im.count = items.length;
  im.castShadow = castShadow;
  im.receiveShadow = receiveShadow;
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.computeBoundingSphere();
  return im;
}

// ---------------------------------------------------------------- vegetation

// spots: [{ x, z, s (scale ~0.6-1.6), kind: 'broad' | 'pine' | 'palm' }]. Adds 'cyl' obstacles (within maxObstacleDist).
// Returns { group, swayMaterials }.
export function trees(obstacles, spots, { groundHeight = () => 0, seed = 5, maxObstacleDist = 400, crownTint = null } = {}) {
  const rnd = mulberry32(seed);
  const group = new Group();
  const trunkGeo = new CylinderGeometry(0.2, 0.32, 1, 7);
  trunkGeo.translate(0, 0.5, 0);
  const crownGeo = new IcosahedronGeometry(1, 1);
  const pineGeo = new ConeGeometry(1, 1, 8);
  pineGeo.translate(0, 0.5, 0);
  const frondGeo = new ConeGeometry(1, 0.6, 7, 1, true);
  frondGeo.translate(0, -0.1, 0);
  const trunkMat = lambert(0xffffff, { map: barkTexture() });
  const crownMat = lambert(0xffffff);
  const pineMat = lambert(0xffffff);
  const palmMat = lambert(0xffffff, { side: DoubleSide });
  const trunks = [];
  const crowns = [];
  const pines = [];
  const palms = [];
  for (const sp of spots) {
    const k = sp.s ?? 1;
    const gy = groundHeight(sp.x, sp.z);
    const kind = sp.kind || (rnd() < 0.35 ? 'pine' : 'broad');
    const ry = rnd() * Math.PI * 2;
    if (kind === 'pine') {
      const th = 1.8 * k;
      const cr = (1.6 + rnd() * 1.2) * k;
      const ch = cr * 3.6;
      trunks.push({ x: sp.x, y: gy, z: sp.z, sx: k * 0.8, sy: th + 0.5, sz: k * 0.8, ry });
      pines.push({ x: sp.x, y: gy + th, z: sp.z, sx: cr, sy: ch, sz: cr, ry, color: new Color().setHSL(0.32 + rnd() * 0.05, 0.42, 0.17 + rnd() * 0.06) });
      if (Math.hypot(sp.x, sp.z) < maxObstacleDist) obstacles.push({ type: 'cyl', name: 'tree', x: sp.x, z: sp.z, r: cr * 0.55, h: gy + th + ch });
    } else if (kind === 'palm') {
      const th = (6 + rnd() * 4) * k;
      trunks.push({ x: sp.x, y: gy, z: sp.z, sx: k * 0.6, sy: th, sz: k * 0.6, ry });
      palms.push({ x: sp.x, y: gy + th, z: sp.z, sx: 3 * k, sy: 1.6 * k, sz: 3 * k, ry, color: new Color().setHSL(0.27 + rnd() * 0.04, 0.5, 0.28) });
      if (Math.hypot(sp.x, sp.z) < maxObstacleDist) obstacles.push({ type: 'cyl', name: 'palm tree', x: sp.x, z: sp.z, r: 2.4 * k, h: gy + th + 0.6 });
    } else {
      const th = (2.4 + rnd() * 1.6) * k;
      const cr = (2.2 + rnd() * 1.8) * k;
      trunks.push({ x: sp.x, y: gy, z: sp.z, sx: k, sy: th + cr * 0.4, sz: k, ry });
      const col = crownTint ? new Color(crownTint).offsetHSL((rnd() - 0.5) * 0.04, 0, (rnd() - 0.5) * 0.08) : new Color().setHSL(0.24 + rnd() * 0.09, 0.42, 0.22 + rnd() * 0.09);
      crowns.push({ x: sp.x, y: gy + th + cr * 0.55, z: sp.z, sx: cr, sy: cr * (0.9 + rnd() * 0.3), sz: cr, ry, color: col });
      if (Math.hypot(sp.x, sp.z) < maxObstacleDist) obstacles.push({ type: 'cyl', name: 'tree', x: sp.x, z: sp.z, r: cr * 0.85, h: gy + th + cr * 1.5 });
    }
  }
  if (trunks.length) group.add(tagHeat(instanced(trunkGeo, trunkMat, trunks), HEAT.vegetation + 0.05));
  if (crowns.length) group.add(tagHeat(instanced(crownGeo, crownMat, crowns), HEAT.vegetation));
  if (pines.length) group.add(tagHeat(instanced(pineGeo, pineMat, pines), HEAT.vegetation));
  if (palms.length) group.add(tagHeat(instanced(frondGeo, palmMat, palms), HEAT.vegetation));
  return { group, swayMaterials: [crownMat, pineMat, palmMat] };
}

export function bushes(spots, { groundHeight = () => 0, seed = 6 } = {}) {
  const rnd = mulberry32(seed);
  const items = spots.map((sp) => ({
    x: sp.x, y: groundHeight(sp.x, sp.z) + 0.3 * (sp.s ?? 1), z: sp.z,
    sx: (0.7 + rnd() * 0.8) * (sp.s ?? 1), sy: (0.5 + rnd() * 0.4) * (sp.s ?? 1), sz: (0.7 + rnd() * 0.8) * (sp.s ?? 1),
    ry: rnd() * 6, color: new Color().setHSL(0.25 + rnd() * 0.07, 0.4, 0.2 + rnd() * 0.08),
  }));
  return tagHeat(instanced(new IcosahedronGeometry(1, 0), lambert(0xffffff, { flatShading: true }), items), HEAT.vegetation);
}

export function rocks(spots, { groundHeight = () => 0, seed = 7, color = 0x8a8680 } = {}) {
  const rnd = mulberry32(seed);
  const items = spots.map((sp) => ({
    x: sp.x, y: groundHeight(sp.x, sp.z) + 0.1, z: sp.z,
    sx: (0.4 + rnd()) * (sp.s ?? 1), sy: (0.3 + rnd() * 0.6) * (sp.s ?? 1), sz: (0.4 + rnd()) * (sp.s ?? 1), ry: rnd() * 6,
    color: new Color(color).offsetHSL(0, 0, (rnd() - 0.5) * 0.12),
  }));
  return tagHeat(instanced(new IcosahedronGeometry(1, 0), lambert(0xffffff, { flatShading: true }), items), HEAT.ground);
}

// ---------------------------------------------------------------- structures

// Axis-aligned building with facade texture and obstacle. Returns the group.
export function building(obstacles, { x, z, w, d, h, y0 = 0, facade, roofColor = 0x6b6f75, wallColor = 0xffffff, name = 'building', rooftop = true, seed = 1 }) {
  const g = new Group();
  const rnd = mulberry32(seed);
  const mats = [];
  const side = (len) => {
    if (!facade) return lambert(wallColor);
    const m = new MeshLambertMaterial({ map: facade.map.clone(), emissiveMap: facade.emissiveMap, emissive: new Color(0x000000) });
    m.map.needsUpdate = true;
    m.map.repeat.set(Math.max(1, Math.round(len / 12)), Math.max(1, Math.round(h / 24)));
    m.map.wrapS = RepeatWrapping;
    m.map.wrapT = RepeatWrapping;
    m.emissiveMap = facade.emissiveMap.clone();
    m.emissiveMap.needsUpdate = true;
    m.emissiveMap.repeat.copy(m.map.repeat);
    m.emissiveMap.wrapS = RepeatWrapping;
    m.emissiveMap.wrapT = RepeatWrapping;
    mats.push(m);
    return m;
  };
  const roofMat = lambert(roofColor);
  const sx = side(w);
  const sz = side(d);
  // BoxGeometry material order: +x, -x, +y, -y, +z, -z
  const body = new Mesh(new BoxGeometry(w, h, d), [sz, sz, roofMat, roofMat, sx, sx]);
  body.position.set(0, h / 2, 0);
  body.castShadow = true;
  body.receiveShadow = true;
  tagHeat(body, HEAT.building);
  g.add(body);
  let top = h;
  if (rooftop) {
    const parapet = new Mesh(new BoxGeometry(w + 0.3, 0.8, d + 0.3), lambert(roofColor));
    parapet.position.y = h + 0.1;
    g.add(tagHeat(parapet, HEAT.roof));
    // Rooftop water tank and AC units.
    if (rnd() < 0.7) {
      const tank = new Mesh(new CylinderGeometry(0.9, 0.9, 1.6, 12), lambert(rnd() < 0.5 ? 0x2a2a2a : 0x2f6fb3));
      tank.position.set((rnd() - 0.5) * (w - 3), h + 1.9, (rnd() - 0.5) * (d - 3));
      tank.castShadow = true;
      g.add(tagHeat(tank, HEAT.roof));
      top = h + 2.8;
    }
    const acCount = Math.floor(rnd() * 4);
    for (let i = 0; i < acCount; i++) {
      const ac = new Mesh(new BoxGeometry(1, 0.7, 0.7), lambert(0xd0d0cc));
      ac.position.set((rnd() - 0.5) * (w - 2), h + 0.85, (rnd() - 0.5) * (d - 2));
      g.add(tagHeat(ac, HEAT.engine * 0.8));
    }
  }
  g.position.set(x, y0, z);
  obstacles.push({ type: 'box', name, minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h: y0 + top });
  g.userData.facadeMaterials = mats;
  return g;
}

// Set night factor on facade materials collected from buildings.
export function lightWindows(materials, k) {
  for (const m of materials) m.emissive.setScalar(k * 0.65);
}

// Power line: poles at given points, `wires` catenary wires between consecutive poles.
// Adds 'cyl' obstacles for poles and 'seg' obstacles along each wire.
export function powerLine(obstacles, poles, { height = 9, wires = 3, sag = 0.5, spread = 1.2, groundHeight = () => 0, poleColor = 0x8b8b88, name = 'power line', lattice = false } = {}) {
  const g = new Group();
  const poleGeo = lattice ? new CylinderGeometry(0.6, 1.6, height, 4, 1, true) : new CylinderGeometry(0.13, 0.18, height, 8);
  const poleMat = lattice ? lambert(poleColor, { wireframe: true }) : lambert(poleColor);
  const armGeo = new BoxGeometry(spread * 2 + 0.4, 0.14, 0.14);
  const wireMat = new MeshBasicMaterial({ color: 0x1a1a1a });
  const tops = [];
  for (let i = 0; i < poles.length; i++) {
    const p = poles[i];
    const gy = groundHeight(p.x, p.z);
    const pole = new Mesh(poleGeo, poleMat);
    pole.position.set(p.x, gy + height / 2, p.z);
    pole.castShadow = true;
    g.add(tagHeat(pole, HEAT.metal));
    // Arm perpendicular to the line direction.
    const q = poles[Math.min(i + 1, poles.length - 1)];
    const r = poles[Math.max(i - 1, 0)];
    const dir = Math.atan2(q.x - r.x, q.z - r.z);
    const arm = new Mesh(armGeo, poleMat.wireframe ? lambert(poleColor) : poleMat);
    arm.position.set(p.x, gy + height - 0.3, p.z);
    // Local +X of the arm must point across the line, i.e. along perp below.
    arm.rotation.y = dir;
    g.add(arm);
    const perp = { x: Math.cos(dir), z: -Math.sin(dir) };
    const att = [];
    for (let w = 0; w < wires; w++) {
      const off = wires === 1 ? 0 : -spread + (2 * spread * w) / (wires - 1);
      att.push(new Vector3(p.x + perp.x * off, gy + height - 0.25, p.z + perp.z * off));
    }
    tops.push(att);
    obstacles.push({ type: 'cyl', name: `${name} pole`, x: p.x, z: p.z, r: lattice ? 1.6 : 0.25, h: gy + height });
  }
  for (let i = 0; i < tops.length - 1; i++) {
    for (let w = 0; w < wires; w++) {
      const a = tops[i][w];
      const b = tops[i + 1][w];
      const span = a.distanceTo(b);
      const mid = a.clone().lerp(b, 0.5);
      mid.y -= sag + span * 0.012;
      const curve = new CatmullRomCurve3([a, a.clone().lerp(mid, 0.5).setY((a.y + mid.y) / 2 - (sag + span * 0.012) * 0.2), mid, mid.clone().lerp(b, 0.5).setY((b.y + mid.y) / 2 - (sag + span * 0.012) * 0.2), b]);
      const tube = new Mesh(new TubeGeometry(curve, 16, 0.025, 4, false), wireMat);
      g.add(tagHeat(tube, HEAT.metal + 0.1));
      // Two capsule segments approximate the sagging wire.
      obstacles.push({ type: 'seg', name, ax: a.x, ay: a.y, az: a.z, bx: mid.x, by: mid.y, bz: mid.z, r: 0.06 });
      obstacles.push({ type: 'seg', name, ax: mid.x, ay: mid.y, az: mid.z, bx: b.x, by: b.y, bz: b.z, r: 0.06 });
    }
  }
  return g;
}

// Home pad at the origin (6 x 6 m) with edge lights. Returns { group, setNight }.
export function homePad({ size = 6, y = 0.02 } = {}) {
  const g = new Group();
  const geo = new PlaneGeometry(size, size);
  geo.rotateX(-Math.PI / 2);
  const pad = new Mesh(geo, flat(0xffffff, { map: helipadTexture() }));
  pad.position.y = y;
  pad.receiveShadow = true;
  g.add(tagHeat(pad, HEAT.road));
  const lightMat = new MeshStandardMaterial({ color: 0x223322, emissive: new Color(0x3cff7a), emissiveIntensity: 0.4 });
  const lg = new CylinderGeometry(0.06, 0.08, 0.12, 10);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const l = new Mesh(lg, lightMat);
    l.position.set(Math.cos(a) * (size * 0.6), y + 0.05, Math.sin(a) * (size * 0.6));
    g.add(tagHeat(l, HEAT.light));
  }
  const glow = new PointLight(0x9fffc0, 0, 14, 2);
  glow.position.set(0, 1.2, 0);
  g.add(glow);
  return {
    group: g,
    setNight(k) {
      lightMat.emissiveIntensity = 0.4 + k * 3;
      glow.intensity = k * 6;
    },
  };
}

// Pilot post: small canopy and a ground label at (x, z). Adds an obstacle. Returns the group.
export function pilotPost(obstacles, x, z, { groundHeight = () => 0, color = 0x1e5aa8 } = {}) {
  const g = new Group();
  const gy = groundHeight(x, z);
  const postGeo = new CylinderGeometry(0.05, 0.05, 2.4, 8);
  const postMat = lambert(0x9aa3ad);
  for (const [px, pz] of [[-1.6, -1.2], [1.6, -1.2], [-1.6, 1.2], [1.6, 1.2]]) {
    const p = new Mesh(postGeo, postMat);
    p.position.set(px, 1.2, pz);
    g.add(p);
  }
  const roof = new Mesh(new BoxGeometry(3.8, 0.08, 3), lambert(color));
  roof.position.y = 2.42;
  roof.castShadow = true;
  g.add(roof);
  g.position.set(x, gy, z + 1.4);
  const lbl = new Mesh(new PlaneGeometry(3, 1).rotateX(-Math.PI / 2), new MeshBasicMaterial({ map: labelTexture('PILOT', { bg: 'rgba(0,0,0,0)', fg: '#ffffff', w: 256, h: 80, font: 'bold 60px sans-serif' }), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
  lbl.position.set(0, 0.03, -2.2);
  g.add(lbl);
  obstacles.push({ type: 'box', name: 'pilot canopy', minX: x - 1.9, maxX: x + 1.9, minZ: z + 1.4 - 1.5, maxZ: z + 1.4 + 1.5, h: gy + 2.5 });
  return g;
}

// Windsock mast at (x, z). Returns { group, update(dt, wind) }.
export function windsock(obstacles, x, z, { groundHeight = () => 0, height = 6 } = {}) {
  const g = new Group();
  const gy = groundHeight(x, z);
  const pole = new Mesh(new CylinderGeometry(0.06, 0.08, height, 10), lambert(0xdddddd));
  pole.position.set(x, gy + height / 2, z);
  g.add(pole);
  const pivot = new Group();
  pivot.position.set(x, gy + height - 0.1, z);
  const sockGeo = new CylinderGeometry(0.32, 0.12, 2.2, 16, 1, true);
  sockGeo.rotateZ(Math.PI / 2);
  sockGeo.translate(1.1, 0, 0);
  const swing = new Group();
  swing.add(new Mesh(sockGeo, lambert(0xffffff, { map: windsockTexture(), side: DoubleSide })));
  pivot.add(swing);
  g.add(pivot);
  obstacles.push({ type: 'cyl', name: 'windsock mast', x, z, r: 0.15, h: gy + height + 0.2 });
  let flutter = 0;
  return {
    group: g,
    sample: new Vector3(x, gy + height, z),
    update(dt, wind) {
      const speed = Math.hypot(wind.x, wind.z);
      const yaw = Math.atan2(-wind.z, wind.x);
      let d = (yaw - pivot.rotation.y) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      pivot.rotation.y += d * clamp(dt * 2, 0, 1);
      const ext = clamp(speed / 7.7, 0, 1);
      flutter += dt * (3 + speed);
      const droop = -(1 - ext) * (Math.PI / 2 - 0.15) + Math.sin(flutter) * 0.04 * ext;
      swing.rotation.z += (droop - swing.rotation.z) * clamp(dt * 3, 0, 1);
    },
  };
}

// Street lights along a list of positions. Emissive heads always; a limited number of real
// point lights (nearest to `lightCentre`) so the cost stays fixed. Returns { group, setNight }.
export function streetLights(obstacles, spots, { groundHeight = () => 0, height = 8, maxLights = 6, lightCentre = { x: 0, z: 0 } } = {}) {
  const g = new Group();
  const poleMat = lambert(0x5d636b);
  const headMat = new MeshStandardMaterial({ color: 0x333333, emissive: new Color(0xffd7a0), emissiveIntensity: 0 });
  const poleGeo = new CylinderGeometry(0.08, 0.12, height, 8);
  const armGeo = new BoxGeometry(1.6, 0.1, 0.1);
  const headGeo = new BoxGeometry(0.6, 0.15, 0.3);
  const sorted = [...spots].sort((a, b) => Math.hypot(a.x - lightCentre.x, a.z - lightCentre.z) - Math.hypot(b.x - lightCentre.x, b.z - lightCentre.z));
  const lights = [];
  for (const s of spots) {
    const gy = groundHeight(s.x, s.z);
    const pole = new Mesh(poleGeo, poleMat);
    pole.position.set(s.x, gy + height / 2, s.z);
    pole.castShadow = true;
    g.add(tagHeat(pole, HEAT.metal));
    const ax = Math.sin(s.dir || 0);
    const az = Math.cos(s.dir || 0);
    const arm = new Mesh(armGeo, poleMat);
    arm.position.set(s.x + ax * 0.8, gy + height - 0.1, s.z + az * 0.8);
    arm.rotation.y = (s.dir || 0) + Math.PI / 2;
    g.add(arm);
    const head = new Mesh(headGeo, headMat);
    head.position.set(s.x + ax * 1.5, gy + height - 0.2, s.z + az * 1.5);
    head.rotation.y = (s.dir || 0) + Math.PI / 2;
    g.add(tagHeat(head, HEAT.light));
    obstacles.push({ type: 'cyl', name: 'street light', x: s.x, z: s.z, r: 0.2, h: gy + height });
    if (sorted.indexOf(s) < maxLights) {
      const pl = new PointLight(0xffd2a0, 0, 26, 1.6);
      pl.position.set(s.x + ax * 1.5, gy + height - 0.5, s.z + az * 1.5);
      g.add(pl);
      lights.push(pl);
    }
  }
  return {
    group: g,
    setNight(k) {
      headMat.emissiveIntensity = k > 0.3 ? 2.5 * k : 0;
      for (const l of lights) l.intensity = k > 0.3 ? 220 * k : 0;
    },
  };
}

// ---------------------------------------------------------------- vehicles and people

export function car(color = 0xb02a2a, { seed = 1 } = {}) {
  const rnd = mulberry32(seed);
  const g = new Group();
  const bodyMat = standard(color, { roughness: 0.35, metalness: 0.4 });
  const body = new Mesh(new BoxGeometry(1.8, 0.7, 4.2), bodyMat);
  body.position.y = 0.65;
  g.add(body);
  const cabin = new Mesh(new BoxGeometry(1.6, 0.6, 2.2), standard(0x22303a, { roughness: 0.2, metalness: 0.5 }));
  cabin.position.set(0, 1.25, -0.2 + (rnd() - 0.5) * 0.2);
  g.add(cabin);
  const wheelGeo = new CylinderGeometry(0.34, 0.34, 0.25, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = lambert(0x151515);
  for (const [wx, wz] of [[-0.85, 1.35], [0.85, 1.35], [-0.85, -1.35], [0.85, -1.35]]) {
    const w = new Mesh(wheelGeo, wheelMat);
    w.position.set(wx, 0.34, wz);
    g.add(w);
  }
  g.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  tagHeat(g, HEAT.vehicle);
  tagHeat(body, HEAT.engine * 0.85);
  return g;
}

export function truck(color = 0x2f6b3a) {
  const g = new Group();
  const cab = new Mesh(new BoxGeometry(2.3, 2.2, 2), standard(color));
  cab.position.set(0, 1.5, 2.6);
  g.add(tagHeat(cab, HEAT.engine));
  const box = new Mesh(new BoxGeometry(2.4, 2.6, 5.5), standard(0xd8d4c8));
  box.position.set(0, 1.8, -1.2);
  g.add(tagHeat(box, HEAT.vehicle));
  const wheelGeo = new CylinderGeometry(0.5, 0.5, 0.3, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  for (const [wx, wz] of [[-1.1, 2.4], [1.1, 2.4], [-1.1, -2.6], [1.1, -2.6]]) {
    const w = new Mesh(wheelGeo, lambert(0x151515));
    w.position.set(wx, 0.5, wz);
    g.add(w);
  }
  g.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  return g;
}

export function person(shirt = 0x2f6fb3, { pants = 0x2b2b30, skin = 0xc68e62 } = {}) {
  const g = new Group();
  const legGeo = new CylinderGeometry(0.09, 0.08, 0.85, 6);
  for (const s of [-0.11, 0.11]) {
    const leg = new Mesh(legGeo, lambert(pants));
    leg.position.set(s, 0.43, 0);
    g.add(leg);
  }
  const torso = new Mesh(new CylinderGeometry(0.2, 0.17, 0.62, 8), lambert(shirt));
  torso.position.y = 1.17;
  g.add(torso);
  const head = new Mesh(new IcosahedronGeometry(0.12, 1), lambert(skin));
  head.position.y = 1.62;
  g.add(head);
  for (const s of [-0.26, 0.26]) {
    const arm = new Mesh(new CylinderGeometry(0.05, 0.045, 0.6, 6), lambert(shirt));
    arm.position.set(s, 1.15, 0);
    arm.rotation.z = s * 0.25;
    g.add(arm);
  }
  g.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  return tagHeat(g, HEAT.person);
}

// Distant low-poly hills ring for the horizon.
export function horizonHills({ seed = 99, radius = 1300, count = 26, color = 0x5d7a55 } = {}) {
  const rnd = mulberry32(seed);
  const g = new Group();
  const mat = lambert(color, { flatShading: true });
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rnd() * 0.2;
    const r = radius + rnd() * 400;
    const h = 60 + rnd() * 140;
    const hill = new Mesh(new ConeGeometry(160 + rnd() * 180, h, 7, 1), mat);
    hill.position.set(Math.cos(a) * r, h / 2 - 4, Math.sin(a) * r);
    hill.rotation.y = rnd() * Math.PI;
    g.add(hill);
  }
  return g;
}

// Generic dispose for a scene root.
export function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k of ['map', 'emissiveMap', 'normalMap', 'alphaMap']) if (m[k]) m[k].dispose();
      m.dispose();
    }
  });
}

// Helper to paint obstacles-independent features on the minimap.
export function paintRect(ctx, toPx, minX, minZ, maxX, maxZ, fill) {
  const [x0, y0] = toPx(minX, minZ);
  const [x1, y1] = toPx(maxX, maxZ);
  ctx.fillStyle = fill;
  ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
}

export function paintPolyline(ctx, toPx, pts, stroke, widthPx) {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = widthPx;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach(([x, z], i) => {
    const [px, py] = toPx(x, z);
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  });
  ctx.stroke();
}

