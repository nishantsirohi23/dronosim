// Gymnasium-style drone environment for training and evaluating AI agents.
// Runs the same physics, flight controller, wind, battery and scenes as the simulator,
// headless (no rendering). See docs/AGENT_API.md.
//
//   const env = await DroneEnv.create({ task: 'waypoints', control: 'sticks', scene: 'city' });
//   let { obs, info } = env.reset(42);
//   const { obs, reward, terminated, truncated, info } = env.step([0, 0, 0.3, 0]);

import { Euler, Vector3 } from 'three';
import { Quadcopter } from '../physics/quadcopter.js';
import { FlightController, MODE_INFO } from '../fc/flightController.js';
import { WindModel } from '../physics/wind.js';
import { Battery } from '../physics/battery.js';
import { DEFAULT_GAINS, DRONE_X4, FC_PARAMS } from '../config.js';
import { ObstacleIndex } from '../world/obstacleIndex.js';
import { ProximitySensors } from '../sensors/proximity.js';
import { PATTERNS, distanceToPolyline } from '../world/patterns.js';
import { PatternTracker } from '../assess/analysis.js';
import { G, clamp, gauss, mulberry32, resetGauss } from '../util/math.js';
import { installHeadlessDom } from './headless.js';

export const TASKS = ['hover', 'waypoints', 'pattern', 'land', 'free'];
export const CONTROLS = ['sticks', 'motors'];
export const SCENE_IDS = ['training', 'city', 'forest', 'farm', 'industrial'];

// Observation vector layout. World frame: +x east, +y up, +z south. Heights are relative to
// home (the pad), which is at ground level 0.
export const OBS_KEYS = [
  'target_dx', 'target_dy', 'target_dz', // target minus drone position (m)
  'vel_x', 'vel_y', 'vel_z', // velocity (m/s)
  'quat_x', 'quat_y', 'quat_z', 'quat_w', // attitude (body: +x right, +y up, -z forward)
  'rate_pitch', 'rate_yaw', 'rate_roll', // body angular rates (rad/s)
  'alt', 'agl', // height above home and above the ground directly below (m)
  'battery', // state of charge 0..1
  'sensor_front', 'sensor_right', 'sensor_back', 'sensor_left', 'sensor_down', // obstacle distance / range, 1 = clear
  'motor_1', 'motor_2', 'motor_3', 'motor_4', // motor outputs 0..1 (FR, RL, FL, RR)
];

const DEFAULTS = {
  task: 'hover',
  control: 'sticks', // 'sticks': act as a pilot through the flight controller; 'motors': raw motor commands
  flightMode: 'ALT_HOLD', // flight mode used with stick control
  scene: null, // null = open flat ground (fastest); or one of SCENE_IDS
  sceneQuality: 'medium',
  agentHz: 50,
  physicsHz: 400,
  maxSeconds: 30,
  start: 'air', // 'air' (hovering) or 'ground' (armed on the pad)
  startAlt: 5,
  wind: null, // null = random when randomize is on, else calm; or { speed, dirDeg, gustiness, turbulence }
  randomize: true, // true, false or { mass, thrust, wind, start }
  obsNoise: 0, // std-dev of Gaussian noise added to position/velocity/attitude/rate observations
  seed: 0,
  pattern: 'circle', // 'circle' | 'square' | 'figure8' for the pattern task
  patternAlt: 8,
  waypoints: 3,
  waypointRadius: 1.5,
  waypointArea: 30,
  sensorRange: 20,
  crashPenalty: -10,
  bounds: 600,
  batteryDrain: 1,
};

const _euler = new Euler(0, 0, 0, 'YXZ');
const _p = new Vector3();

function sanitize(a) {
  const out = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const v = Number(a?.[i]);
    out[i] = Number.isFinite(v) ? clamp(v, -1, 1) : 0;
  }
  return out;
}

export class DroneEnv {
  static async create(options = {}) {
    const env = new DroneEnv(options);
    await env.ready;
    return env;
  }

  constructor(options = {}) {
    const o = (this.opts = { ...DEFAULTS, ...options });
    if (!TASKS.includes(o.task)) throw new Error(`Unknown task "${o.task}" (expected ${TASKS.join(', ')})`);
    if (!CONTROLS.includes(o.control)) throw new Error(`Unknown control "${o.control}" (expected ${CONTROLS.join(', ')})`);
    if (o.control === 'sticks' && (!MODE_INFO[o.flightMode] || MODE_INFO[o.flightMode].auto)) {
      throw new Error(`flightMode must be a pilot mode: STABILIZE, ALT_HOLD, LOITER or ACRO`);
    }
    if (o.scene !== null && !SCENE_IDS.includes(o.scene)) throw new Error(`Unknown scene "${o.scene}" (expected ${SCENE_IDS.join(', ')})`);
    if (o.task === 'pattern' && !PATTERNS[o.pattern]) throw new Error(`Unknown pattern "${o.pattern}"`);

    this.spec = JSON.parse(JSON.stringify(DRONE_X4));
    this.quad = new Quadcopter(this.spec);
    this.wind = new WindModel();
    this.battery = new Battery(this.spec.battery);
    this.sensors = new ProximitySensors({ range: o.sensorRange });
    this.physics = { wind: new Vector3(), groundHeight: 0, obstacles: [], torqueNoise: this.wind.torque };
    this.windAt = (x, y, z, out = new Vector3()) => this.wind.sample(_p.set(x, y, z), out);
    this.sceneInst = null;
    this.index = new ObstacleIndex([]);
    this.groundHeight = () => 0;
    this.rng = mulberry32(o.seed >>> 0);
    this.events = [];
    this.done = true;
    this.steps = 0;
    this.sceneDynamic = false;

    this.observationSpace = { shape: [OBS_KEYS.length], low: -Infinity, high: Infinity, keys: OBS_KEYS };
    this.actionSpace = {
      shape: [4],
      low: -1,
      high: 1,
      keys: o.control === 'sticks' ? ['throttle', 'yaw', 'pitch', 'roll'] : ['motor_1', 'motor_2', 'motor_3', 'motor_4'],
    };
    this.ready = o.scene ? this._loadScene(o.scene) : Promise.resolve();
  }

  async _loadScene(id) {
    installHeadlessDom();
    const { sceneInfo } = await import('../world/scenes/index.js');
    this.sceneModule = await sceneInfo(id).load();
    this._buildScene();
  }

  _buildScene() {
    this.sceneInst?.dispose?.();
    // Scene builders may use Math.random; pin it so every build is identical.
    const orig = Math.random;
    Math.random = mulberry32(0x5eed);
    try {
      this.sceneInst = this.sceneModule.build({ quality: this.opts.sceneQuality, seed: 1 });
    } finally {
      Math.random = orig;
    }
    this.index = new ObstacleIndex(this.sceneInst.obstacles);
    this.groundHeight = this.sceneInst.groundHeight;
    this.sceneDynamic = this.sceneInst.obstacles.some((ob) => ob.dynamic);
  }

  // Math.random is replaced by the env's seeded generator while it runs, so wind
  // turbulence, gusts and randomisation are reproducible for a given seed.
  _seeded(fn) {
    const orig = Math.random;
    Math.random = this.rng;
    try {
      return fn();
    } finally {
      Math.random = orig;
    }
  }

  reset(seed) {
    if (seed !== undefined && seed !== null) this.rng = mulberry32(seed >>> 0);
    resetGauss();
    return this._seeded(() => this._reset());
  }

  step(action) {
    if (this.done) throw new Error('Episode finished: call reset() first');
    return this._seeded(() => this._step(action));
  }

  close() {
    this.sceneInst?.dispose?.();
    this.sceneInst = null;
  }

  // ------------------------------------------------------------------ reset

  _rand() {
    const r = this.opts.randomize;
    if (r === false) return null;
    return r === true ? { mass: 0.1, thrust: 0.05, wind: true, start: true } : { mass: 0, thrust: 0, wind: false, start: false, ...r };
  }

  _reset() {
    const o = this.opts;
    const rnd = this._rand();
    const r = this.rng;
    const sym = () => r() * 2 - 1;

    this.spec.mass = DRONE_X4.mass * (1 + (rnd ? sym() * rnd.mass : 0));
    this.spec.maxThrustPerMotor = DRONE_X4.maxThrustPerMotor * (1 + (rnd ? sym() * rnd.thrust : 0));
    if (o.wind) this.wind.configure({ turbulence: true, gustiness: 0.3, dirDeg: 270, ...o.wind });
    else if (rnd && rnd.wind) this.wind.configure({ speed: r() * 8, dirDeg: r() * 360, gustiness: r() * 0.6, turbulence: true });
    else this.wind.configure({ speed: 0, gustiness: 0, turbulence: false });
    this.wind.resetState();
    this.battery.reset();
    // Moving traffic would otherwise carry over between episodes; rebuilding keeps seeds exact.
    if (this.sceneDynamic && this.steps > 0) this._buildScene();
    this.fc = new FlightController(this.quad, FC_PARAMS, DEFAULT_GAINS, (type, e) => {
      if (type === 'msg') this.events.push(e.text);
    });
    this.events.length = 0;

    // Task layout.
    this.target = new Vector3();
    this.waypointList = [];
    this.wpIndex = 0;
    this.cpIndex = 0;
    this.tracker = null;
    let sx = 0;
    let sz = 0;
    let alt = o.start === 'air' ? o.startAlt : 0;
    let heading = rnd && rnd.start ? r() * 360 : 0;
    switch (o.task) {
      case 'hover':
      case 'free':
        this.target.set(0, o.startAlt, 0);
        if (rnd && rnd.start && o.start === 'air') {
          sx = sym() * 1.5;
          sz = sym() * 1.5;
          alt = Math.max(1.5, o.startAlt + sym());
        }
        break;
      case 'waypoints':
        this.waypointList = this._makeWaypoints();
        this.target.copy(this.waypointList[0]);
        break;
      case 'pattern': {
        const pat = PATTERNS[o.pattern];
        this.patternDef = pat;
        this.tracker = new PatternTracker(pat, 10);
        const [cx, cz] = pat.checkpoints[0];
        sx = cx;
        sz = cz;
        alt = o.patternAlt;
        const [nx, nz] = pat.checkpoints[1];
        this.target.set(nx, o.patternAlt, nz);
        heading = (Math.atan2(nx - cx, -(nz - cz)) * 180) / Math.PI;
        break;
      }
      case 'land': {
        const a = r() * Math.PI * 2;
        const d = 4 + r() * 10;
        sx = Math.cos(a) * d;
        sz = Math.sin(a) * d;
        alt = 6 + r() * 6;
        this.target.set(0, 0, 0);
        break;
      }
      default:
        break;
    }

    // Initial state: on the ground at the start point, or hovering at `alt`.
    const q = this.quad;
    q.reset(sx, sz, heading);
    const gy = this.groundHeight(sx, sz);
    const airborne = o.task === 'land' || o.task === 'pattern' || o.start === 'air';
    const hoverOut = (this.spec.mass * G) / (4 * this.spec.maxThrustPerMotor);
    if (airborne) {
      q.pos.y = gy + Math.max(alt, 0.8) + this.spec.gearHeight;
      q.contact = false;
      q.out.fill(hoverOut);
      q.cmd.fill(hoverOut);
      if (rnd && rnd.start) q.vel.set(sym() * 0.5, sym() * 0.3, sym() * 0.5);
    } else {
      q.pos.y = gy + this.spec.gearHeight;
    }

    if (o.control === 'sticks') {
      const fc = this.fc;
      fc.setMode(o.flightMode, 'agent');
      fc.rc = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
      fc.arm('agent');
      if (airborne) {
        fc._readState();
        fc._resetControllers();
        fc.landed = false;
        fc.ctl.collective = hoverOut;
        fc.hoverThr = hoverOut;
      }
    }

    this.t = 0;
    this.steps = 0;
    this.done = false;
    this.success = false;
    this.reason = '';
    this.landTimer = 0;
    this.touchdown = 0;
    this.sumDist = 0;
    this.near = this.index.near(q.pos.x, q.pos.z, 45);
    this._sense();
    this.prevDist = this._targetDist();
    return { obs: this._obs(), info: this._info() };
  }

  _makeWaypoints() {
    const o = this.opts;
    const r = this.rng;
    const list = [];
    let px = 0;
    let pz = 0;
    for (let i = 0; i < o.waypoints; i++) {
      let wp = null;
      for (let k = 0; k < 80 && !wp; k++) {
        const a = r() * Math.PI * 2;
        const d = o.waypointArea * (0.35 + 0.65 * r());
        const x = px + Math.cos(a) * d;
        const z = pz + Math.sin(a) * d;
        const alt = 3 + r() * 12;
        if (alt < this.groundHeight(x, z) + 3) continue;
        const clear = this.index.near(x, z, 6).every((ob) => ob.dynamic || this._clearance(ob, x, z) > 4 || ob.h < alt - 3);
        if (clear) wp = new Vector3(x, alt, z);
      }
      wp ||= new Vector3(px, 10, pz);
      list.push(wp);
      px = wp.x;
      pz = wp.z;
    }
    return list;
  }

  _clearance(ob, x, z) {
    if (ob.type === 'box') return Math.hypot(Math.max(ob.minX - x, 0, x - ob.maxX), Math.max(ob.minZ - z, 0, z - ob.maxZ));
    if (ob.type === 'cyl') return Math.hypot(x - ob.x, z - ob.z) - ob.r;
    const dx = ob.bx - ob.ax;
    const dz = ob.bz - ob.az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? clamp(((x - ob.ax) * dx + (z - ob.az) * dz) / l2, 0, 1) : 0;
    return Math.hypot(x - (ob.ax + dx * t), z - (ob.az + dz * t)) - ob.r;
  }

  // ------------------------------------------------------------------ step

  _step(action) {
    const o = this.opts;
    const a = sanitize(action);
    const q = this.quad;
    const n = Math.max(1, Math.round(o.physicsHz / o.agentHz));
    const dt = 1 / o.physicsHz;
    const rc = o.control === 'sticks' ? { throttle: (a[0] + 1) / 2, yaw: a[1], pitch: a[2], roll: a[3] } : null;
    this.near = this.index.near(q.pos.x, q.pos.z, 45);
    this.physics.obstacles = this.near;
    const fence = { enabled: false };
    for (let i = 0; i < n; i++) {
      this.wind.update(dt);
      this.wind.sample(q.pos, this.physics.wind);
      this.battery.update(dt, q.current, o.batteryDrain);
      q.thrustScale = this.battery.thrustScale;
      this.physics.groundHeight = this.groundHeight(q.pos.x, q.pos.z);
      if (rc) this.fc.update(dt, rc, { gpsFix: true, battPct: this.battery.pct, rcValid: true, fence });
      else for (let k = 0; k < 4; k++) q.cmd[k] = q.crashed ? 0 : (a[k] + 1) / 2;
      q.step(dt, this.physics);
      if (this.sceneInst?.waterAt && !q.crashed) {
        const w = this.sceneInst.waterAt(q.pos.x, q.pos.z);
        if (w !== null && q.pos.y - this.spec.gearHeight * 0.5 < w) q.crash('Ditched in water');
      }
      for (const e of q.events.splice(0)) if (e.type === 'touchdown') this.touchdown = e.vz;
      if (q.crashed) break;
    }
    const stepDt = n * dt;
    this.t += stepDt;
    this.steps += 1;
    this.sceneInst?.update?.(stepDt, this.t, this.windAt);
    this._sense();

    let reward = 0;
    let terminated = false;
    const dist = this._targetDist();
    const progress = this.prevDist - dist;
    this.prevDist = dist;
    this.sumDist += dist;
    const speed = q.vel.length();
    const alt = q.pos.y - this.spec.gearHeight;

    switch (o.task) {
      case 'hover':
      case 'free': {
        if (o.task === 'hover') {
          const rate = q.omega.length();
          reward = 1 - clamp(dist / 5, 0, 1) - 0.1 * clamp(speed / 5, 0, 1) - 0.05 * clamp(rate / 5, 0, 1);
        }
        break;
      }
      case 'waypoints': {
        reward = progress - 0.01;
        if (dist < o.waypointRadius) {
          reward += 10;
          this.wpIndex += 1;
          if (this.wpIndex >= this.waypointList.length) {
            this.success = true;
            terminated = true;
            this.reason = 'all waypoints reached';
          } else {
            this.target.copy(this.waypointList[this.wpIndex]);
            this.prevDist = this._targetDist();
          }
        }
        break;
      }
      case 'pattern': {
        const pat = this.patternDef;
        const cross = distanceToPolyline(pat.points, q.pos.x, q.pos.z).dist;
        this.tracker.add({ x: q.pos.x, z: q.pos.z, alt, speed, t: this.t });
        reward = progress - 0.05 * Math.min(cross, 10) - 0.02 * Math.min(Math.abs(alt - o.patternAlt), 10);
        const capture = 3;
        if (Math.hypot(this.target.x - q.pos.x, this.target.z - q.pos.z) < capture) {
          reward += 2;
          this.cpIndex += 1;
          const cps = pat.checkpoints;
          if (this.cpIndex >= cps.length) {
            reward += 20;
            this.success = true;
            terminated = true;
            this.reason = 'pattern complete';
          } else {
            const [nx, nz] = cps[(this.cpIndex + 1) % cps.length];
            this.target.set(nx, o.patternAlt, nz);
            this.prevDist = this._targetDist();
          }
        }
        break;
      }
      case 'land': {
        reward = progress - 0.01;
        if (q.contact && !q.crashed && speed < 0.3) {
          this.landTimer += stepDt;
          if (this.landTimer >= 0.5) {
            const hd = Math.hypot(q.pos.x, q.pos.z);
            terminated = true;
            this.success = hd < 1.5;
            this.reason = this.success ? 'landed on the pad' : 'landed off the pad';
            reward += (this.success ? 20 : 5) - 5 * Math.min(hd, 4) - 5 * Math.max(this.touchdown - 0.5, 0);
          }
        } else {
          this.landTimer = 0;
        }
        break;
      }
      default:
        break;
    }

    if (q.crashed) {
      terminated = true;
      this.success = false;
      this.reason = `crash: ${q.crashReason}`;
      reward += o.crashPenalty;
    } else if (Math.hypot(q.pos.x, q.pos.z) > o.bounds || alt > 200) {
      terminated = true;
      this.success = false;
      this.reason = 'out of bounds';
      reward += o.crashPenalty;
    }
    const truncated = !terminated && this.t >= o.maxSeconds - 1e-9;
    if (truncated) this.reason ||= 'time limit';
    this.done = terminated || truncated;
    return { obs: this._obs(), reward, terminated, truncated, info: this._info() };
  }

  // ------------------------------------------------------------------ observations

  _yaw() {
    return _euler.setFromQuaternion(this.quad.quat, 'YXZ').y;
  }

  _sense() {
    const q = this.quad;
    this.sensors.update(q.pos, this._yaw(), this.near, this.groundHeight, this.spec.gearHeight);
  }

  _targetDist() {
    const q = this.quad;
    return Math.hypot(this.target.x - q.pos.x, this.target.y - (q.pos.y - this.spec.gearHeight), this.target.z - q.pos.z);
  }

  _obs() {
    const o = this.opts;
    const q = this.quad;
    const alt = q.pos.y - this.spec.gearHeight;
    const agl = alt - this.groundHeight(q.pos.x, q.pos.z);
    const range = o.sensorRange;
    const s = this.sensors.dist;
    const norm = (d) => (Number.isFinite(d) ? clamp(d / range, 0, 1) : 1);
    const obs = [
      this.target.x - q.pos.x, this.target.y - alt, this.target.z - q.pos.z,
      q.vel.x, q.vel.y, q.vel.z,
      q.quat.x, q.quat.y, q.quat.z, q.quat.w,
      q.omega.x, q.omega.y, q.omega.z,
      alt, agl,
      this.battery.soc,
      norm(s.front), norm(s.right), norm(s.back), norm(s.left), norm(s.down),
      q.out[0], q.out[1], q.out[2], q.out[3],
    ];
    if (o.obsNoise > 0) for (let i = 0; i < 13; i++) obs[i] += o.obsNoise * gauss();
    return obs;
  }

  _info() {
    const q = this.quad;
    const fc = this.fc;
    const info = {
      t: this.t,
      step: this.steps,
      task: this.opts.task,
      success: this.success,
      reason: this.reason,
      crashed: q.crashed,
      crash_reason: q.crashReason,
      distance: this._targetDist(),
      mean_distance: this.steps ? this.sumDist / this.steps : this._targetDist(),
      position: [q.pos.x, q.pos.y - this.spec.gearHeight, q.pos.z],
      target: [this.target.x, this.target.y, this.target.z],
      speed: q.vel.length(),
      battery: this.battery.soc,
      wind_speed: Math.hypot(this.physics.wind.x, this.physics.wind.z),
      nearest_obstacle: Number.isFinite(this.sensors.nearest.dist) ? { name: this.sensors.nearest.name, distance: this.sensors.nearest.dist, direction: this.sensors.nearest.dir } : null,
    };
    if (this.opts.control === 'sticks') {
      info.mode = fc.mode;
      info.armed = fc.armed;
    }
    if (this.opts.task === 'waypoints') {
      info.waypoint = this.wpIndex;
      info.waypoints = this.waypointList.length;
    }
    if (this.opts.task === 'pattern') {
      const st = this.tracker.stats();
      info.checkpoint = this.cpIndex;
      info.checkpoints = this.patternDef.checkpoints.length;
      info.pattern_rms = st.rms;
      info.pattern_score = st.score;
    }
    return info;
  }
}
