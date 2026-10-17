import { Color, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { PATTERN_LIST } from './patterns.js';
import { ribbon } from './scenery.js';

export const TOLERANCE_M = 2;

// Reference pattern overlays (centre line + tolerance band) for training and assessment.
export class PatternOverlay {
  constructor(scene) {
    this.groups = {};
    this.materials = [];
    for (const p of PATTERN_LIST) {
      const g = new Group();
      const seg = [];
      const n = p.points.length;
      for (let i = 0; i < n; i++) {
        const [x0, z0] = p.points[i];
        const [x1, z1] = p.points[(i + 1) % n];
        seg.push(x0, 0.06, z0, x1, 0.06, z1);
      }
      const geo = new LineSegmentsGeometry();
      geo.setPositions(seg);
      const mat = new LineMaterial({ color: p.color, linewidth: 2, dashed: true, dashSize: 1.2, gapSize: 0.8, worldUnits: false });
      const line = new LineSegments2(geo, mat);
      line.computeLineDistances();
      line.renderOrder = 3;
      g.add(line);
      this.materials.push(mat);
      const bandOuter = new Mesh(
        ribbon(p.points, TOLERANCE_M * 2, 0.035, true),
        new MeshBasicMaterial({ color: new Color(p.color), transparent: true, opacity: 0.16, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }),
      );
      bandOuter.renderOrder = 2;
      g.add(bandOuter);
      g.visible = false;
      scene.add(g);
      this.groups[p.id] = g;
    }
    this.current = 'none';
  }

  show(id) {
    this.current = id;
    for (const [k, g] of Object.entries(this.groups)) g.visible = id === 'all' || id === k;
  }

  setResolution(w, h) {
    for (const m of this.materials) m.resolution.set(w, h);
  }
}

export class FenceVisual {
  constructor(scene) {
    this.mat = new MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.12, side: DoubleSide, depthWrite: false });
    this.mesh = new Mesh(new CylinderGeometry(1, 1, 1, 96, 1, true), this.mat);
    this.mesh.visible = false;
    this.mesh.renderOrder = 6;
    this.ceiling = new Mesh(new CylinderGeometry(1, 1, 0.01, 96, 1, false), new MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.03, side: DoubleSide, depthWrite: false }));
    this.ceiling.visible = false;
    scene.add(this.mesh, this.ceiling);
  }

  set(fence, home) {
    const on = !!fence.enabled;
    this.mesh.visible = on;
    this.ceiling.visible = on;
    if (!on) return;
    this.mesh.scale.set(fence.radius, fence.maxAlt, fence.radius);
    this.mesh.position.set(home.x, fence.maxAlt / 2, home.z);
    this.ceiling.scale.set(fence.radius, 1, fence.radius);
    this.ceiling.position.set(home.x, fence.maxAlt, home.z);
  }

  // Fade the wall in as the drone approaches it.
  update(dist, alt, fence) {
    if (!fence.enabled) return;
    const near = Math.max(1 - (fence.radius - dist) / 20, 1 - (fence.maxAlt - alt) / 8, 0.15);
    this.mat.opacity = 0.03 + 0.13 * Math.min(near, 1);
  }
}
