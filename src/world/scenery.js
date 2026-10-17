import {
  BoxGeometry, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, Float32BufferAttribute,
  Group, IcosahedronGeometry, InstancedMesh, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, MeshStandardMaterial, PlaneGeometry, PointLight, Quaternion, SpotLight, Vector3,
} from 'three';
import { clamp, mulberry32 } from '../util/math.js';
import { HOME, PATTERN_LIST, PILOT_STATION } from './patterns.js';
import { barkTexture, grassTexture, helipadTexture, labelTexture, mowedTexture, windsockTexture } from './textures.js';

const FIELD = { minX: -75, maxX: 75, minZ: -85, maxZ: 35 };

// Flat ribbon along a 2D polyline, lying on the ground.
export function ribbon(points, width, y, closed = true) {
  const pos = [];
  const n = points.length;
  const count = closed ? n : n - 1;
  const half = width / 2;
  for (let i = 0; i < count; i++) {
    const [x0, z0] = points[i];
    const [x1, z1] = points[(i + 1) % n];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const l = Math.hypot(dx, dz) || 1;
    const nx = (-dz / l) * half;
    const nz = (dx / l) * half;
    // Extend slightly to hide seams at corners.
    const ex = (dx / l) * half;
    const ez = (dz / l) * half;
    const a = [x0 - ex + nx, y, z0 - ez + nz];
    const b = [x0 - ex - nx, y, z0 - ez - nz];
    const c = [x1 + ex + nx, y, z1 + ez + nz];
    const d = [x1 + ex - nx, y, z1 + ez - nz];
    pos.push(...a, ...b, ...c, ...b, ...d, ...c);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function flatMaterial(color, opts = {}) {
  return new MeshLambertMaterial({ color, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...opts });
}

export class Scenery {
  constructor(scene) {
    this.scene = scene;
    this.root = new Group();
    this.root.name = 'scenery';
    scene.add(this.root);
    this.obstacles = [];
    this.nightObjects = [];
    this.groundHeight = 0;
    this.rnd = mulberry32(2024);
    this._ground();
    this._field();
    this._helipad();
    this._patternMarkings();
    this._pilotStation();
    this._windsock();
    this._buildings();
    this._trees();
    this._fence();
    this._floodlights();
    this._hills();
    this._overheadGrid();
  }

  _ground() {
    const g = new PlaneGeometry(4000, 4000);
    g.rotateX(-Math.PI / 2);
    const m = new MeshLambertMaterial({ map: grassTexture([800, 800]) });
    const ground = new Mesh(g, m);
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.root.add(ground);
  }

  _field() {
    const w = FIELD.maxX - FIELD.minX;
    const h = FIELD.maxZ - FIELD.minZ;
    const g = new PlaneGeometry(w, h);
    g.rotateX(-Math.PI / 2);
    const m = flatMaterial(0xffffff, { map: mowedTexture([w / 10, h / 10]) });
    const field = new Mesh(g, m);
    field.position.set((FIELD.minX + FIELD.maxX) / 2, 0.005, (FIELD.minZ + FIELD.maxZ) / 2);
    field.receiveShadow = true;
    this.root.add(field);

    // Distance rings from the pilot station (VLOS judgement aid) every 25 m.
    const ringMat = flatMaterial(0xe8f0e0, { transparent: true, opacity: 0.35 });
    for (const r of [25, 50, 75]) {
      const pts = [];
      for (let i = 0; i <= 48; i++) {
        const a = Math.PI + (Math.PI * i) / 48;
        const x = PILOT_STATION.x + r * Math.cos(a);
        const z = PILOT_STATION.z + r * Math.sin(a);
        if (x > FIELD.minX && x < FIELD.maxX && z > FIELD.minZ && z < FIELD.maxZ) pts.push([x, z]);
      }
      if (pts.length > 2) {
        const mesh = new Mesh(ribbon(pts, 0.12, 0.012, false), ringMat);
        mesh.receiveShadow = true;
        this.root.add(mesh);
        const [lx, lz] = pts[Math.floor(pts.length / 2)];
        this._groundLabel(`${r} m`, lx, lz - 1.2, 3, 0.9, 0.35);
      }
    }
  }

  _groundLabel(text, x, z, w, h, opacity = 0.9, color = '#ffffff') {
    const tex = labelTexture(text, { bg: 'rgba(0,0,0,0)', fg: color, w: 256, h: 80, font: 'bold 60px sans-serif' });
    const m = new MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    const g = new PlaneGeometry(w, h);
    g.rotateX(-Math.PI / 2);
    const mesh = new Mesh(g, m);
    mesh.position.set(x, 0.02, z);
    this.root.add(mesh);
    return mesh;
  }

  _helipad() {
    const g = new PlaneGeometry(6, 6);
    g.rotateX(-Math.PI / 2);
    const pad = new Mesh(g, flatMaterial(0xffffff, { map: helipadTexture() }));
    pad.position.set(HOME.x, 0.015, HOME.z);
    pad.receiveShadow = true;
    this.root.add(pad);

    // Edge lights, visible at night.
    const lightGeo = new CylinderGeometry(0.06, 0.08, 0.12, 10);
    const lightMat = new MeshStandardMaterial({ color: 0x223322, emissive: new Color(0x3cff7a), emissiveIntensity: 0.4 });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const l = new Mesh(lightGeo, lightMat);
      l.position.set(HOME.x + Math.cos(a) * 3.6, 0.06, HOME.z + Math.sin(a) * 3.6);
      this.root.add(l);
    }
    this.padLightMat = lightMat;
  }

  _patternMarkings() {
    const paint = flatMaterial(0xf4f4f0, { emissive: new Color(0x404040) });
    this.paintMat = paint;
    const coneGeo = new ConeGeometry(0.28, 0.75, 14);
    const coneMat = new MeshLambertMaterial({ color: 0xff6a00, emissive: new Color(0x331100) });
    const poleGeo = new CylinderGeometry(0.05, 0.05, 2.4, 8);
    const poleMat = new MeshLambertMaterial({ color: 0xeeeeee });
    const flagGeo = new PlaneGeometry(0.7, 0.45);
    for (const p of PATTERN_LIST) {
      const mesh = new Mesh(ribbon(p.points, 0.3, 0.018, true), paint);
      mesh.receiveShadow = true;
      this.root.add(mesh);
      // Checkpoint cones.
      for (const [x, z] of p.checkpoints) {
        const c = new Mesh(coneGeo, coneMat);
        c.position.set(x, 0.375, z);
        c.castShadow = true;
        this.root.add(c);
      }
      // Centre / corner poles with coloured flags.
      for (const [x, z] of p.poles) {
        const pole = new Mesh(poleGeo, poleMat);
        pole.position.set(x, 1.2, z);
        pole.castShadow = true;
        this.root.add(pole);
        const flag = new Mesh(flagGeo, new MeshLambertMaterial({ color: p.color, side: DoubleSide, emissive: new Color(p.color).multiplyScalar(0.25) }));
        flag.position.set(x + 0.36, 2.15, z);
        this.root.add(flag);
      }
      this._groundLabel(p.name.toUpperCase(), p.centre.x, p.centre.z + p.radius + 3.2, 9, 1.6, 0.85);
    }
  }

  _pilotStation() {
    const g = new Group();
    g.position.set(PILOT_STATION.x, 0, PILOT_STATION.z + 1.5);
    const postGeo = new CylinderGeometry(0.05, 0.05, 2.4, 8);
    const postMat = new MeshLambertMaterial({ color: 0x9aa3ad });
    for (const [x, z] of [[-1.8, -1.5], [1.8, -1.5], [-1.8, 1.5], [1.8, 1.5]]) {
      const p = new Mesh(postGeo, postMat);
      p.position.set(x, 1.2, z);
      p.castShadow = true;
      g.add(p);
    }
    const roof = new Mesh(new BoxGeometry(4.2, 0.08, 3.6), new MeshLambertMaterial({ color: 0x1e5aa8 }));
    roof.position.y = 2.42;
    roof.castShadow = true;
    g.add(roof);
    const table = new Mesh(new BoxGeometry(1.6, 0.06, 0.7), new MeshLambertMaterial({ color: 0xdddddd }));
    table.position.set(0, 0.75, 0.6);
    g.add(table);
    const sign = new Mesh(
      new PlaneGeometry(2.4, 0.5),
      new MeshLambertMaterial({ map: labelTexture('PILOT STATION', { bg: '#1e5aa8', fg: '#ffffff' }), side: DoubleSide }),
    );
    sign.position.set(0, 2.1, -1.82);
    sign.rotation.y = Math.PI;
    g.add(sign);
    this.root.add(g);
    this._groundLabel('PILOT', PILOT_STATION.x, PILOT_STATION.z - 0.8, 3, 1);
    this.obstacles.push({ type: 'box', name: 'pilot station canopy', minX: g.position.x - 2.1, maxX: g.position.x + 2.1, minZ: g.position.z - 1.8, maxZ: g.position.z + 1.8, h: 2.5 });
  }

  _windsock() {
    const pole = new Mesh(new CylinderGeometry(0.06, 0.08, 6, 10), new MeshLambertMaterial({ color: 0xdddddd }));
    const base = new Vector3(-12, 0, 8);
    pole.position.set(base.x, 3, base.z);
    pole.castShadow = true;
    this.root.add(pole);
    const pivot = new Group();
    pivot.position.set(base.x, 5.9, base.z);
    const sockGeo = new CylinderGeometry(0.32, 0.12, 2.2, 16, 1, true);
    sockGeo.rotateZ(Math.PI / 2);
    sockGeo.translate(1.1, 0, 0);
    const sock = new Mesh(sockGeo, new MeshLambertMaterial({ map: windsockTexture(), side: DoubleSide }));
    sock.castShadow = true;
    const swing = new Group();
    swing.add(sock);
    pivot.add(swing);
    this.root.add(pivot);
    this.windsock = { pivot, swing, flutter: 0 };
    this.obstacles.push({ type: 'cyl', name: 'windsock mast', x: base.x, z: base.z, r: 0.15, h: 6.2 });
  }

  updateWindsock(dt, windVec) {
    const ws = this.windsock;
    const speed = Math.hypot(windVec.x, windVec.z);
    // Sock points downwind: local +X aligned with wind direction.
    const yaw = Math.atan2(-windVec.z, windVec.x);
    ws.pivot.rotation.y = lerpAngle(ws.pivot.rotation.y, yaw, clamp(dt * 2, 0, 1));
    // Fully extended at about 15 kt (7.7 m/s).
    const ext = clamp(speed / 7.7, 0, 1);
    ws.flutter += dt * (3 + speed);
    const droop = -(1 - ext) * (Math.PI / 2 - 0.15) + Math.sin(ws.flutter) * 0.04 * ext;
    ws.swing.rotation.z += (droop - ws.swing.rotation.z) * clamp(dt * 3, 0, 1);
  }

  _box(name, x, z, w, d, h, color, roofColor) {
    const g = new Group();
    const body = new Mesh(new BoxGeometry(w, h, d), new MeshLambertMaterial({ color }));
    body.position.y = h / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);
    if (roofColor) {
      const roof = new Mesh(new BoxGeometry(w + 0.4, 0.3, d + 0.4), new MeshLambertMaterial({ color: roofColor }));
      roof.position.y = h + 0.15;
      roof.castShadow = true;
      g.add(roof);
    }
    g.position.set(x, 0, z);
    this.root.add(g);
    this.obstacles.push({ type: 'box', name, minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h: h + 0.3 });
    return g;
  }

  _buildings() {
    const hangar = this._box('hangar', 52, 26, 22, 14, 8, 0xb8bec6, 0x5a6470);
    const door = new Mesh(new PlaneGeometry(10, 6), new MeshLambertMaterial({ color: 0x3d4650 }));
    door.position.set(0, 3, -7.01);
    door.rotation.y = Math.PI;
    hangar.add(door);
    const name = new Mesh(new PlaneGeometry(9, 1.4), new MeshLambertMaterial({ map: labelTexture('DRONOSIM RPTO', { bg: '#1e3a5f', fg: '#ffffff' }) }));
    name.position.set(0, 7, -7.02);
    name.rotation.y = Math.PI;
    hangar.add(name);
    this._box('briefing room', -34, 30, 10, 7, 3.6, 0xe9e2d0, 0x8a3b2b);
    const rnd = this.rnd;
    for (let i = 0; i < 18; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 320 + rnd() * 380;
      const w = 10 + rnd() * 25;
      const h = 5 + rnd() * 14;
      this._box('building', Math.cos(a) * r, Math.sin(a) * r, w, 8 + rnd() * 18, h, [0xd8d0c0, 0xc0c4c8, 0xe6dcc8, 0xa8b0b8][i % 4], 0x6b4a3a);
    }
  }

  _trees() {
    const rnd = this.rnd;
    const spots = [];
    // Hazard trees near the field edge.
    spots.push([-66, -78, 1.15], [70, -20, 1.2], [-72, 6, 1.0], [24, -92, 1.1], [-20, -95, 1.25]);
    while (spots.length < 520) {
      const a = rnd() * Math.PI * 2;
      const r = 95 + Math.pow(rnd(), 0.7) * 520;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (x > -90 && x < 90 && z > -100 && z < 50) continue;
      spots.push([x, z, 0.7 + rnd() * 0.8]);
    }
    const trunkGeo = new CylinderGeometry(0.22, 0.32, 1, 7);
    trunkGeo.translate(0, 0.5, 0);
    const crownGeo = new IcosahedronGeometry(1, 1);
    const coneGeo = new ConeGeometry(1, 1, 8);
    coneGeo.translate(0, 0.5, 0);
    const trunks = new InstancedMesh(trunkGeo, new MeshLambertMaterial({ map: barkTexture() }), spots.length);
    const crowns = new InstancedMesh(crownGeo, new MeshLambertMaterial({ color: 0xffffff }), spots.length);
    const pines = new InstancedMesh(coneGeo, new MeshLambertMaterial({ color: 0xffffff }), spots.length);
    const m = new Matrix4();
    const q = new Quaternion();
    const s = new Vector3();
    const p = new Vector3();
    const col = new Color();
    let nc = 0;
    let np = 0;
    spots.forEach(([x, z, k], i) => {
      const trunkH = 2.5 * k + rnd() * 1.5;
      m.compose(p.set(x, 0, z), q.identity(), s.set(k, trunkH, k));
      trunks.setMatrixAt(i, m);
      const pine = rnd() < 0.35;
      const crownR = (2.2 + rnd() * 1.6) * k;
      if (pine) {
        const ph = crownR * 3.2;
        m.compose(p.set(x, trunkH * 0.6, z), q.identity(), s.set(crownR * 0.75, ph, crownR * 0.75));
        pines.setMatrixAt(np, m);
        pines.setColorAt(np++, col.setHSL(0.33 + rnd() * 0.04, 0.45, 0.2 + rnd() * 0.06));
        this.obstacles.push({ type: 'cyl', name: 'tree', x, z, r: crownR * 0.6, h: trunkH * 0.6 + ph });
      } else {
        m.compose(p.set(x, trunkH + crownR * 0.6, z), q.identity(), s.set(crownR, crownR * 1.1, crownR));
        crowns.setMatrixAt(nc, m);
        crowns.setColorAt(nc++, col.setHSL(0.25 + rnd() * 0.08, 0.45, 0.24 + rnd() * 0.08));
        this.obstacles.push({ type: 'cyl', name: 'tree', x, z, r: crownR * 0.85, h: trunkH + crownR * 1.7 });
      }
    });
    crowns.count = nc;
    pines.count = np;
    for (const im of [trunks, crowns, pines]) {
      im.castShadow = true;
      im.receiveShadow = true;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      this.root.add(im);
    }
    // Only keep nearby trees in the collision list.
    this.obstacles = this.obstacles.filter((o) => o.name !== 'tree' || Math.hypot(o.x, o.z) < 300);
  }

  _fence() {
    const posts = [];
    const add = (x, z) => posts.push([x, z]);
    for (let x = FIELD.minX; x <= FIELD.maxX; x += 5) {
      add(x, FIELD.minZ);
      add(x, FIELD.maxZ);
    }
    for (let z = FIELD.minZ + 5; z < FIELD.maxZ; z += 5) {
      add(FIELD.minX, z);
      add(FIELD.maxX, z);
    }
    const im = new InstancedMesh(new BoxGeometry(0.1, 1.3, 0.1), new MeshLambertMaterial({ color: 0x8b6b4a }), posts.length);
    const m = new Matrix4();
    posts.forEach(([x, z], i) => im.setMatrixAt(i, m.makeTranslation(x, 0.65, z)));
    im.castShadow = true;
    this.root.add(im);
    const wire = [];
    const c = [[FIELD.minX, FIELD.minZ], [FIELD.maxX, FIELD.minZ], [FIELD.maxX, FIELD.maxZ], [FIELD.minX, FIELD.maxZ]];
    for (const h of [0.6, 1.15]) {
      for (let i = 0; i < 4; i++) {
        const [x0, z0] = c[i];
        const [x1, z1] = c[(i + 1) % 4];
        wire.push(x0, h, z0, x1, h, z1);
      }
    }
    const wg = new BufferGeometry();
    wg.setAttribute('position', new Float32BufferAttribute(wire, 3));
    this.root.add(new LineSegments(wg, new LineBasicMaterial({ color: 0x555555 })));
  }

  _floodlights() {
    this.floods = [];
    for (const [x, z] of [[-48, 24], [48, 18]]) {
      const pole = new Mesh(new CylinderGeometry(0.12, 0.18, 12, 8), new MeshLambertMaterial({ color: 0x9aa0a6 }));
      pole.position.set(x, 6, z);
      pole.castShadow = true;
      this.root.add(pole);
      const lampMat = new MeshStandardMaterial({ color: 0x333333, emissive: new Color(0xfff2d0), emissiveIntensity: 0 });
      const lamp = new Mesh(new BoxGeometry(1.4, 0.6, 0.4), lampMat);
      lamp.position.set(x, 12, z);
      lamp.lookAt(0, 0, -30);
      this.root.add(lamp);
      const spot = new SpotLight(0xfff2d8, 0, 220, Math.PI / 4.2, 0.5, 1.6);
      spot.position.set(x, 12, z);
      spot.target.position.set(x * 0.2, 0, -38);
      this.root.add(spot, spot.target);
      this.floods.push({ spot, lampMat });
      this.obstacles.push({ type: 'cyl', name: 'floodlight mast', x, z, r: 0.3, h: 12.5 });
    }
    this.padGlow = new PointLight(0x9fffc0, 0, 14, 2);
    this.padGlow.position.set(0, 1.2, 0);
    this.root.add(this.padGlow);
  }

  setNight(k) {
    // k: 0 = day, 1 = full night.
    for (const f of this.floods) {
      f.spot.intensity = k * 2600;
      f.lampMat.emissiveIntensity = k * 3;
    }
    this.padLightMat.emissiveIntensity = 0.4 + k * 3;
    this.padGlow.intensity = k * 6;
    this.paintMat.emissive.setScalar(0.04 + k * 0.1);
  }

  _hills() {
    const rnd = mulberry32(99);
    const mat = new MeshLambertMaterial({ color: 0x5d7a55, flatShading: true });
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + rnd() * 0.2;
      const r = 1100 + rnd() * 400;
      const h = 60 + rnd() * 140;
      const geo = new ConeGeometry(160 + rnd() * 180, h, 7, 1);
      const hill = new Mesh(geo, mat);
      hill.position.set(Math.cos(a) * r, h / 2 - 4, Math.sin(a) * r);
      hill.rotation.y = rnd() * Math.PI;
      this.root.add(hill);
    }
  }

  _overheadGrid() {
    // 5 m analysis grid shown in the overhead view (major lines every 25 m).
    const minor = [];
    const major = [];
    const ext = 150;
    for (let v = -ext; v <= ext; v += 5) {
      const arr = v % 25 === 0 ? major : minor;
      arr.push(-ext, 0.03, v, ext, 0.03, v, v, 0.03, -ext, v, 0.03, ext);
    }
    const mk = (arr, color, opacity) => {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(arr, 3));
      return new LineSegments(g, new LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    };
    this.grid = new Group();
    this.grid.add(mk(minor, 0xffffff, 0.18), mk(major, 0xffffff, 0.45));
    this.grid.position.set(0, 0, -30);
    this.grid.visible = false;
    this.root.add(this.grid);
  }
}

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export { FIELD };
