import { Euler, Group, MathUtils, OrthographicCamera, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { clamp, DEG, smoothing } from '../util/math.js';
import { PILOT_STATION } from './patterns.js';

export const VIEWS = [
  { id: 'pilot', label: 'Pilot (VLOS)', short: 'Pilot' },
  { id: 'chase', label: 'Chase', short: 'Chase' },
  { id: 'fpv', label: 'FPV', short: 'FPV' },
  { id: 'overhead', label: 'Overhead analysis', short: 'Overhead' },
  { id: 'orbit', label: 'Free orbit', short: 'Orbit' },
];

const _target = new Vector3();
const _desired = new Vector3();
const _q = new Quaternion();
const _tilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 15 * DEG);
const _offset = new Vector3();
const _euler = new Euler(0, 0, 0, 'YXZ');

export class CameraRig {
  constructor(scene, dom) {
    this.dom = dom;
    this.persp = new PerspectiveCamera(42, 1, 0.05, 4000);
    this.ortho = new OrthographicCamera(-50, 50, 50, -50, 1, 1000);
    this.ortho.up.set(0, 0, -1);
    this.view = 'pilot';
    this.aspect = 1;
    this.pilot = { fov: 42, auto: false, look: new Vector3(0, 0.5, 0) };
    this.chase = { dist: 4.5, height: 1.6, pos: new Vector3(0, 2, 6) };
    this.fpv = { fov: 100 };
    this.overhead = { size: 42, center: new Vector3(0, 0, -24), follow: false };
    this.orbitLast = new Vector3();

    this.controls = new OrbitControls(this.persp, dom);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.maxDistance = 200;
    this.controls.minDistance = 0.6;

    // WebXR rig: a dolly at the pilot station, local-floor reference space supplies head height.
    this.pilotPos = new Vector3(PILOT_STATION.x, 1.7, PILOT_STATION.z);
    this.groundHeight = () => 0;
    this.dolly = new Group();
    this.dolly.position.set(PILOT_STATION.x, 0, PILOT_STATION.z);
    this.vrCam = new PerspectiveCamera(70, 1, 0.05, 4000);
    this.dolly.add(this.vrCam);
    scene.add(this.dolly);

    dom.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    this._drag = null;
    dom.addEventListener('pointerdown', (e) => {
      if (this.view === 'overhead' && e.button === 0) this._drag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      const mpp = (2 * this.overhead.size) / this.dom.clientHeight;
      this.overhead.center.x -= (e.clientX - this._drag.x) * mpp;
      this.overhead.center.z -= (e.clientY - this._drag.y) * mpp;
      this.overhead.follow = false;
      this._drag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointerup', () => (this._drag = null));
    dom.addEventListener('dblclick', () => {
      if (this.view === 'overhead') this.resetOverhead();
    });
  }

  // Pilot station for the current scene (ground position; eye height is added).
  setPilotStation(x, groundY, z) {
    this.pilotPos.set(x, groundY + 1.7, z);
    this.dolly.position.set(x, groundY, z);
  }

  // Default overhead framing for the current scene.
  setOverheadDefault(cx, cz, size) {
    this.overheadDefault = { cx, cz, size };
    this.resetOverhead();
  }

  get camera() {
    return this.view === 'overhead' ? this.ortho : this.persp;
  }

  resetOverhead() {
    const d = this.overheadDefault || { cx: 0, cz: -24, size: 42 };
    this.overhead.size = d.size;
    this.overhead.center.set(d.cx, 0, d.cz);
    this.overhead.follow = false;
  }

  // Metres per screen pixel in the overhead view (for scale bars).
  metresPerPixel(heightPx) {
    return (2 * this.overhead.size) / heightPx;
  }

  setView(id, quad) {
    if (!VIEWS.find((v) => v.id === id)) return;
    this.view = id;
    this.controls.enabled = id === 'orbit';
    if (id === 'orbit' && quad) {
      this.controls.target.copy(quad.pos);
      this.persp.position.copy(quad.pos).add(_offset.set(4, 3, 6));
      this.orbitLast.copy(quad.pos);
    }
    if (id === 'chase' && quad) this.chase.pos.copy(quad.pos).add(_offset.set(0, this.chase.height, this.chase.dist));
  }

  _wheel(e) {
    e.preventDefault();
    const k = Math.exp(e.deltaY * 0.0012);
    switch (this.view) {
      case 'pilot':
        this.pilot.fov = clamp(this.pilot.fov * k, 8, 75);
        this.pilot.auto = false;
        break;
      case 'chase':
        this.chase.dist = clamp(this.chase.dist * k, 1.5, 25);
        break;
      case 'fpv':
        this.fpv.fov = clamp(this.fpv.fov * k, 60, 130);
        break;
      case 'overhead':
        this.overhead.size = clamp(this.overhead.size * k, 6, 300);
        break;
      default:
        break;
    }
  }

  resize(w, h) {
    this.aspect = w / h;
    this.persp.aspect = this.aspect;
    this.persp.updateProjectionMatrix();
    this._updateOrtho();
  }

  _updateOrtho() {
    const s = this.overhead.size;
    this.ortho.top = s;
    this.ortho.bottom = -s;
    this.ortho.left = -s * this.aspect;
    this.ortho.right = s * this.aspect;
    this.ortho.updateProjectionMatrix();
  }

  update(dt, quad) {
    const cam = this.persp;
    switch (this.view) {
      case 'pilot': {
        cam.position.copy(this.pilotPos);
        this.pilot.look.lerp(quad.pos, smoothing(10, dt));
        cam.lookAt(this.pilot.look);
        let fov = this.pilot.fov;
        if (this.pilot.auto) {
          const d = cam.position.distanceTo(quad.pos);
          fov = clamp(2 * Math.atan(3.2 / d) * (180 / Math.PI), 8, 60);
        }
        cam.fov = MathUtils.lerp(cam.fov, fov, smoothing(8, dt));
        cam.updateProjectionMatrix();
        break;
      }
      case 'chase': {
        const yaw = _euler.setFromQuaternion(quad.quat, 'YXZ').y;
        _desired.set(Math.sin(yaw) * this.chase.dist, this.chase.height, Math.cos(yaw) * this.chase.dist).add(quad.pos);
        _desired.y = Math.max(_desired.y, this.groundHeight(_desired.x, _desired.z) + 0.6);
        this.chase.pos.lerp(_desired, smoothing(4, dt));
        cam.position.copy(this.chase.pos);
        cam.lookAt(_target.copy(quad.pos).add(_offset.set(0, 0.3, 0)));
        if (cam.fov !== 60) {
          cam.fov = 60;
          cam.updateProjectionMatrix();
        }
        break;
      }
      case 'fpv': {
        _q.copy(quad.quat).multiply(_tilt);
        cam.quaternion.copy(_q);
        cam.position.copy(_offset.set(0, 0.04, -0.13).applyQuaternion(quad.quat).add(quad.pos));
        if (cam.fov !== this.fpv.fov) {
          cam.fov = this.fpv.fov;
          cam.updateProjectionMatrix();
        }
        break;
      }
      case 'overhead': {
        const o = this.overhead;
        if (o.follow) o.center.lerp(_target.set(quad.pos.x, 0, quad.pos.z), smoothing(3, dt));
        this.ortho.position.set(o.center.x, 300, o.center.z);
        this.ortho.lookAt(o.center.x, 0, o.center.z);
        this._updateOrtho();
        break;
      }
      case 'orbit': {
        // Carry the orbit camera along with the drone.
        _offset.copy(quad.pos).sub(this.orbitLast);
        cam.position.add(_offset);
        this.controls.target.add(_offset);
        this.orbitLast.copy(quad.pos);
        this.controls.update();
        if (cam.fov !== 55) {
          cam.fov = 55;
          cam.updateProjectionMatrix();
        }
        break;
      }
      default:
        break;
    }
  }
}
