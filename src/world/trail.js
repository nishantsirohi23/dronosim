import { BufferGeometry, Color, Float32BufferAttribute, Line, LineBasicMaterial, LineDashedMaterial } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { clamp } from '../util/math.js';

const MODE_COLORS = {
  STABILIZE: 0x22d3ee,
  ALT_HOLD: 0xa3e635,
  LOITER: 0xfacc15,
  ACRO: 0xf97316,
  RTL: 0xf43f5e,
  LAND: 0xc084fc,
  AUTO: 0x818cf8,
};

const _c = new Color();

function altitudeColor(alt, out) {
  // 0 m blue -> 5 m cyan -> 10 m green -> 15 m yellow -> 25 m+ red
  const stops = [
    [0, 0x3b82f6], [5, 0x22d3ee], [10, 0x4ade80], [15, 0xfacc15], [25, 0xef4444],
  ];
  if (alt <= stops[0][0]) return out.set(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (alt <= stops[i][0]) {
      const t = (alt - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return out.set(stops[i - 1][1]).lerp(_c.set(stops[i][1]), t);
    }
  }
  return out.set(stops[stops.length - 1][1]);
}

function speedColor(v, out) {
  const t = clamp(v / 12, 0, 1);
  return out.setHSL(0.66 - 0.66 * t, 0.9, 0.55);
}

// Flight path trail: thick screen-space line (visible day and night, unlit) with
// per-segment colouring, plus an optional ground track projected onto the field.
export class FlightTrail {
  constructor(scene, maxPoints = 40000) {
    this.max = maxPoints;
    this.points = [];
    this.colorMode = 'altitude';
    this.solid = new Color(0xff2bd6);
    this.minDist = 0.2;
    this.maxInterval = 0.5;

    this.pos = new Float32Array(maxPoints * 6);
    this.col = new Float32Array(maxPoints * 6);
    this.geometry = new LineSegmentsGeometry();
    this.geometry.setPositions(this.pos);
    this.geometry.setColors(this.col);
    this.geometry.instanceCount = 0;
    this.material = new LineMaterial({ linewidth: 3, vertexColors: true, worldUnits: false, transparent: false, depthTest: true });
    this.line = new LineSegments2(this.geometry, this.material);
    this.line.frustumCulled = false;
    this.line.renderOrder = 5;
    scene.add(this.line);

    this.groundPos = new Float32Array(maxPoints * 3);
    const gg = new BufferGeometry();
    gg.setAttribute('position', new Float32BufferAttribute(this.groundPos, 3));
    gg.setDrawRange(0, 0);
    this.ground = new Line(gg, new LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.45, depthWrite: false }));
    this.ground.frustumCulled = false;
    this.ground.renderOrder = 4;
    scene.add(this.ground);

    // Vertical drop line from the drone to the ground (height cue for line-of-sight flying).
    const dg = new BufferGeometry();
    dg.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
    this.drop = new Line(dg, new LineDashedMaterial({ color: 0xffffff, dashSize: 0.4, gapSize: 0.3, transparent: true, opacity: 0.55 }));
    this.drop.frustumCulled = false;
    scene.add(this.drop);
  }

  setResolution(w, h) {
    this.material.resolution.set(w, h);
  }

  setWidth(px) {
    this.material.linewidth = px;
  }

  setVisible(v) {
    this.line.visible = v;
    this.ground.visible = v && this.groundVisible !== false;
  }

  setGroundTrack(v) {
    this.groundVisible = v;
    this.ground.visible = v && this.line.visible;
  }

  setColorMode(mode) {
    this.colorMode = mode;
    for (let i = 1; i < this.points.length; i++) this._writeColor(i - 1, this.points[i - 1], this.points[i]);
    this._markDirty();
  }

  clear() {
    this.points.length = 0;
    this.geometry.instanceCount = 0;
    this.ground.geometry.setDrawRange(0, 0);
  }

  _color(p, out) {
    switch (this.colorMode) {
      case 'speed': return speedColor(p.speed, out);
      case 'mode': return out.set(MODE_COLORS[p.mode] || 0xffffff);
      case 'solid': return out.copy(this.solid);
      default: return altitudeColor(p.alt, out);
    }
  }

  _writeColor(i, a, b) {
    const o = i * 6;
    this._color(a, _c);
    this.col[o] = _c.r;
    this.col[o + 1] = _c.g;
    this.col[o + 2] = _c.b;
    this._color(b, _c);
    this.col[o + 3] = _c.r;
    this.col[o + 4] = _c.g;
    this.col[o + 5] = _c.b;
  }

  // Full re-upload of all buffers.
  _markDirty() {
    for (const b of this._buffers()) {
      b.clearUpdateRanges();
      b.needsUpdate = true;
    }
  }

  _buffers() {
    return [this.geometry.attributes.instanceStart.data, this.geometry.attributes.instanceColorStart.data, this.ground.geometry.attributes.position];
  }

  // Partial upload of just the newest segment / vertex.
  _markRange(seg, vert) {
    const [sb, cb, gb] = this._buffers();
    if (seg >= 0) {
      sb.addUpdateRange(seg * 6, 6);
      cb.addUpdateRange(seg * 6, 6);
      sb.needsUpdate = true;
      cb.needsUpdate = true;
    }
    gb.addUpdateRange(vert * 3, 3);
    gb.needsUpdate = true;
  }

  // Returns true when a new sample was recorded.
  add(p) {
    const n = this.points.length;
    if (n > 0) {
      const last = this.points[n - 1];
      const d = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
      if (d < this.minDist && p.t - last.t < this.maxInterval) return false;
      if (d < 0.02) return false;
    }
    const dropped = n >= this.max;
    if (dropped) this._dropOldest(Math.floor(this.max * 0.1));
    this.points.push(p);
    const m = this.points.length;
    this.groundPos.set([p.x, (p.gy || 0) + 0.04, p.z], (m - 1) * 3);
    if (m >= 2) {
      const a = this.points[m - 2];
      const i = m - 2;
      this.pos.set([a.x, a.y, a.z, p.x, p.y, p.z], i * 6);
      this._writeColor(i, a, p);
      this.geometry.instanceCount = m - 1;
    }
    this.ground.geometry.setDrawRange(0, m);
    if (dropped) this._markDirty();
    else this._markRange(m - 2, m - 1);
    return true;
  }

  _dropOldest(k) {
    this.points.splice(0, k);
    this.pos.copyWithin(0, k * 6);
    this.col.copyWithin(0, k * 6);
    this.groundPos.copyWithin(0, k * 3);
    this.geometry.instanceCount = Math.max(this.points.length - 1, 0);
  }

  updateDropLine(pos, visible, groundY = 0) {
    const a = this.drop.geometry.attributes.position;
    a.setXYZ(0, pos.x, pos.y - 0.15, pos.z);
    a.setXYZ(1, pos.x, groundY + 0.02, pos.z);
    a.needsUpdate = true;
    this.drop.computeLineDistances();
    this.drop.visible = visible && pos.y - groundY > 0.6;
  }
}
