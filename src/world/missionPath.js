import { BufferGeometry, CanvasTexture, DoubleSide, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, RingGeometry, Sprite, SpriteMaterial, SRGBColorSpace } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { missionPath } from '../fc/mission.js';

const COLOR = { pending: 0xe2e8f0, active: 0xfbbf24, done: 0x64748b };
const MARKER_PX = 24;

// Planned AUTO mission shown in the 3D scene: dashed path at flight height, a drop line and
// a 2 m acceptance ring under every waypoint, and numbered markers that keep a constant
// screen size in both the perspective views and the overhead orthographic view.
export class MissionPath {
  constructor(scene, yOffset = 0) {
    this.yOffset = yOffset;
    this.root = new Group();
    this.root.visible = false;
    scene.add(this.root);
    this.lineMat = new LineMaterial({ color: 0xf8fafc, linewidth: 2.5, dashed: true, dashSize: 1.6, gapSize: 1.1, worldUnits: false, transparent: true, opacity: 0.95 });
    this.stalkMat = new LineBasicMaterial({ color: 0xf8fafc, transparent: true, opacity: 0.35, depthWrite: false });
    this.ringGeo = new RingGeometry(1.85, 2, 40).rotateX(-Math.PI / 2);
    this.textures = new Map();
    this.markers = [];
    this.disposables = [];
    this.state = '';
    this.enabled = true;
    this.mission = null;
  }

  setResolution(w, h) {
    this.lineMat.resolution.set(w, h);
  }

  setEnabled(on) {
    this.enabled = on;
    this.root.visible = on && !!this.mission;
  }

  _texture(n) {
    let t = this.textures.get(n);
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.beginPath();
    g.arc(32, 32, 29, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = '#0b1220';
    g.stroke();
    g.fillStyle = '#0b1220';
    g.font = `800 ${n > 99 ? 22 : 28}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(n), 32, 34);
    t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    this.textures.set(n, t);
    return t;
  }

  _clear() {
    for (const o of [...this.root.children]) this.root.remove(o);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.markers = [];
    this.state = '';
  }

  set(mission, opts = {}) {
    this._clear();
    this.mission = mission;
    this.root.visible = this.enabled && !!mission;
    if (!mission) return;
    const y = (alt) => alt + this.yOffset;
    const path = missionPath(mission, opts);
    const seg = [];
    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1];
      const b = path.points[i];
      seg.push(a.x, y(a.alt), a.z, b.x, y(b.alt), b.z);
    }
    if (seg.length) {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(seg);
      const line = new LineSegments2(geo, this.lineMat);
      line.computeLineDistances();
      line.renderOrder = 7;
      this.root.add(line);
      this.disposables.push(geo);
    }
    const stalks = [];
    for (const m of path.markers) {
      stalks.push(m.x, 0.05, m.z, m.x, y(m.alt), m.z);
      const ringMat = new MeshBasicMaterial({ color: COLOR.pending, transparent: true, opacity: 0.5, side: DoubleSide, depthWrite: false });
      const ring = new Mesh(this.ringGeo, ringMat);
      ring.position.set(m.x, y(m.alt), m.z);
      ring.renderOrder = 8;
      const mat = new SpriteMaterial({ map: this._texture(m.item + 1), color: COLOR.pending, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true });
      const sprite = new Sprite(mat);
      sprite.position.set(m.x, y(m.alt), m.z);
      sprite.renderOrder = 26;
      this.root.add(ring, sprite);
      this.disposables.push(ringMat, mat);
      this.markers.push({ item: m.item, sprite, ring });
    }
    if (stalks.length) {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(stalks, 3));
      const ls = new LineSegments(g, this.stalkMat);
      ls.renderOrder = 6;
      this.root.add(ls);
      this.disposables.push(g);
    }
  }

  // Per frame: keep markers a constant pixel size and colour them by mission progress.
  update(camera, heightPx, fc) {
    if (!this.root.visible || !this.markers.length) return;
    const s = camera.isOrthographicCamera
      ? (MARKER_PX * (camera.top - camera.bottom)) / heightPx
      : (MARKER_PX * 2 * Math.tan((camera.fov * Math.PI) / 360)) / heightPx;
    for (const m of this.markers) m.sprite.scale.set(s, s, 1);
    const own = fc.mission === this.mission;
    const idx = own && fc.armed ? (fc.auto.complete ? Infinity : fc.auto.index) : -1;
    const state = `${idx}|${fc.mode}`;
    if (state === this.state) return;
    this.state = state;
    for (const m of this.markers) {
      const c = m.item < idx ? COLOR.done : m.item === idx ? COLOR.active : COLOR.pending;
      m.sprite.material.color.setHex(c);
      m.ring.material.color.setHex(c);
    }
  }
}
