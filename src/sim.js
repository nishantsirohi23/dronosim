import {
  ACESFilmicToneMapping, BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial,
  PCFSoftShadowMap, Scene, Shape, ShapeGeometry, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { DEFAULT_GAINS, DEMO_FENCE, DRONE_X4, EDITION, FC_PARAMS, IS_DEMO, SCENE_ACCESS } from './config.js';
import { Quadcopter } from './physics/quadcopter.js';
import { WindModel } from './physics/wind.js';
import { Battery } from './physics/battery.js';
import { FlightController, MODES, MODE_INFO } from './fc/flightController.js';
import { InputManager } from './input/input.js';
import { Atmosphere } from './world/atmosphere.js';
import { sceneInfo } from './world/scenes/index.js';
import { ObstacleIndex } from './world/obstacleIndex.js';
import { PostFX } from './fx/post.js';
import { applySway, swayUniforms } from './fx/sway.js';
import { ProximitySensors } from './sensors/proximity.js';
import { GimbalCamera } from './sensors/gimbal.js';
import { DroneAudio } from './audio/sound.js';
import { DroneModel } from './world/droneModel.js';
import { FlightTrail } from './world/trail.js';
import { CameraRig, VIEWS } from './world/cameras.js';
import { FenceVisual, PatternOverlay } from './world/overlay.js';
import { MissionPath } from './world/missionPath.js';
import { missionFromJSON } from './fc/mission.js';
import { HOME, PATTERNS } from './world/patterns.js';
import { PatternTracker, summariseFlight } from './assess/analysis.js';
import { Challenge } from './assess/challenge.js';
import { composeCapture, downloadCanvas, downloadText } from './assess/capture.js';
import { RAD, bearingDeg, compassPoint, timestampForFile } from './util/math.js';

const PHYS_DT = 1 / 400;
const _wind = new Vector3();
const _wpos = new Vector3();
const _sway = new Vector3();

export class Simulator {
  constructor(container, settings) {
    this.settings = settings;
    this.listeners = {};
    this.paused = false;
    this.time = 0;
    this.acc = 0;
    this.lastFrame = performance.now();
    this.logRows = [];
    this.logTimer = 0;
    this.gps = { sats: 0, hdop: 99, fix: false, timer: 0, announced: false };
    this.captures = [];

    // Renderer
    const r = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = ACESFilmicToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFSoftShadowMap;
    r.xr.enabled = true;
    container.appendChild(r.domElement);
    r.domElement.id = 'view';
    this.renderer = r;
    this.scene = new Scene();

    // World. The scene itself (training ground, city, forest...) is loaded asynchronously.
    this.env = new Atmosphere(this.scene, r);
    this.post = new PostFX(r);
    this.scenery = null;
    this.sceneId = null;
    this.loading = false;
    this.obsIndex = new ObstacleIndex([]);
    this.nearObstacles = [];
    this.grid = makeGrid();
    this.scene.add(this.grid);
    this.quad = new Quadcopter(DRONE_X4);
    this.quad.reset(HOME.x, HOME.z, 0);
    this.drone = new DroneModel(this.quad);
    this.scene.add(this.drone.root);
    this.trail = new FlightTrail(this.scene);
    this.overlay = new PatternOverlay(this.scene);
    this.fenceVis = new FenceVisual(this.scene);
    this.missionPath = new MissionPath(this.scene, DRONE_X4.gearHeight);
    this.cameras = new CameraRig(this.scene, r.domElement);
    this.marker = makeMarker();
    this.scene.add(this.marker);

    // Simulation
    this.wind = new WindModel();
    this.battery = new Battery(DRONE_X4.battery);
    this.fc = new FlightController(this.quad, FC_PARAMS, DEFAULT_GAINS, (type, e) => this._fcEvent(type, e));
    this.input = new InputManager();
    this.challenge = new Challenge();
    this.tracker = null;
    this.envState = { wind: new Vector3(), groundHeight: 0, obstacles: [], torqueNoise: this.wind.torque };
    this.sensors = new ProximitySensors();
    this.braking = false;
    this.gimbal = new GimbalCamera(r);
    this.gimbalRect = null; // provided by the UI: () => { x, y, w, h } in CSS px from bottom-left
    this.audio = new DroneAudio();
    this.windAt = (x, y, z, out = new Vector3()) => this.wind.sample(_wpos.set(x, y, z), out);
    this.external = null;
    this.frameCallbacks = [];

    this.applySettings(settings);
    this.ready = this.loadScene(settings.scene || 'training', { force: true });
    window.addEventListener('resize', () => this.resize());
    this.resize();

    r.xr.addEventListener('sessionstart', () => this.emit('xr', true));
    r.xr.addEventListener('sessionend', () => this.emit('xr', false));
  }

  on(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  emit(type, data) {
    for (const fn of this.listeners[type] || []) fn(data);
  }

  msg(text, severity = 'info') {
    this.emit('msg', { text, severity, t: this.time });
  }

  _fcEvent(type, e) {
    if (type === 'msg') this.emit('msg', { ...e, t: this.time });
    else this.emit(type, e);
    if (type === 'armfail') this.challenge.event('armfail', e);
    if (type === 'disarmed') this.challenge.event('disarmed', e);
    if (type === 'armed') {
      this.fenceVis.set(this.fenceConfig, this.fc.home);
      this.refreshMissionPath();
    }
  }

  get fenceConfig() {
    return IS_DEMO ? DEMO_FENCE : this.settings.fence;
  }

  applySettings(s) {
    this.settings = s;
    this.wind.configure(s.wind);
    this.env.setTimeOfDay(s.timeOfDay, !this._started);
    this.env.setWeather(s.weather || 'clear', !this._started);
    this.setQuality(s.quality || 'medium');
    this.sensors.enabled = s.sensors?.avoidance !== false;
    this.audio.setMuted(s.sound === false);
    this.trail.setVisible(s.trail.visible);
    this.trail.setColorMode(s.trail.colorMode);
    this.trail.setWidth(s.trail.width);
    this.trail.setGroundTrack(s.trail.groundTrack);
    this.drone.setRegistration(s.registration);
    this.fc.params.rtlAlt = s.rtlAlt;
    this.input.keyboardRate = s.keyboardRate;
    this.setOverlay(s.overlay);
    this.fenceVis.set(this.fenceConfig, this.fc.homeSet ? this.fc.home : HOME);
    if (s.gains) this.fc.setGains(s.gains);
    if (!this._started && s.mission) {
      try {
        this.fc.setMission(missionFromJSON(s.mission));
      } catch {
        s.mission = null;
      }
    }
    this.missionPath.setEnabled(s.missionPath3d !== false);
    this.refreshMissionPath();
    this._started = true;
  }

  // ---------------------------------------------------------------- AUTO mission

  // Upload a mission to the flight controller (null clears it). Kept in settings so it
  // survives a reload; the caller saves the settings.
  setMission(mission) {
    this.fc.setMission(mission);
    this.settings.mission = mission ? JSON.parse(JSON.stringify(mission)) : null;
    this.refreshMissionPath();
  }

  get missionHome() {
    return this.fc.homeSet ? this.fc.home : HOME;
  }

  refreshMissionPath() {
    this.missionPath.set(this.fc.mission, { home: this.missionHome, rtlAlt: this.fc.params.rtlAlt, fence: this.fenceConfig });
  }

  // ---------------------------------------------------------------- scenes

  sceneAvailable(id) {
    return (SCENE_ACCESS[EDITION] || SCENE_ACCESS.base).includes(id);
  }

  async loadScene(id, { force = false } = {}) {
    const def = sceneInfo(id);
    if (!this.sceneAvailable(def.id)) {
      this.msg(`${def.name} is not included in this edition`, 'warn');
      if (!this.scenery && def.id !== 'training') return this.loadScene('training', { force: true });
      return false;
    }
    if (this.fc.armed && !force) {
      this.msg('Land and disarm before changing scene', 'warn');
      return false;
    }
    if (this.loading) return false;
    this.loading = true;
    this.emit('sceneloading', def);
    try {
      const mod = await def.load();
      // Give the loading overlay a frame to paint before the (synchronous) build.
      await new Promise((res) => setTimeout(res, 40));
      const inst = mod.build({ quality: this.settings.quality || 'medium', seed: 1 });
      if (this.scenery) {
        this.scene.remove(this.scenery.root);
        this.scenery.dispose?.();
      }
      this.scenery = inst;
      this.sceneId = def.id;
      this.sceneDef = def;
      this.scene.add(inst.root);
      for (const m of inst.swayMaterials || []) applySway(m);
      this.obsIndex = new ObstacleIndex(inst.obstacles);
      this.nearObstacles = [];
      const gy = inst.groundHeight(inst.pilot.x, inst.pilot.z);
      // The pilot stands 2 m in front of the station canopy so the view up is not blocked by its roof.
      this.cameras.setPilotStation(inst.pilot.x, gy, inst.pilot.z - 2);
      this.cameras.groundHeight = inst.groundHeight;
      if (inst.patterns) this.cameras.setOverheadDefault(0, -24, 42);
      else this.cameras.setOverheadDefault(0, -(inst.mapExtent || 150) * 0.15, Math.min((inst.mapExtent || 150) * 0.5, 110));
      this.settings.scene = def.id;
      if (!inst.patterns && this.settings.overlay !== 'none') this.setOverlay('none');
      this.resetDrone(true, { quiet: true });
      this.trail.clear();
      if (this.tracker) this.tracker.reset();
      this.emit('scene', inst);
      this.msg(`Scene: ${def.name}`, 'good');
      return true;
    } catch (e) {
      console.error(e);
      this.msg(`Could not load scene ${def.name}: ${e.message}`, 'crit');
      if (!this.scenery && def.id !== 'training') {
        this.loading = false;
        return this.loadScene('training', { force: true });
      }
      return false;
    } finally {
      this.loading = false;
      this.emit('sceneloaded', def);
    }
  }

  setQuality(q) {
    this.settings.quality = q;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(q === 'low' ? 1 : q === 'medium' ? Math.min(dpr, 1.5) : Math.min(dpr, 2));
    this.post.setQuality(q);
    this.env.setQuality(q);
    if (this._started) this.resize();
  }

  setWeather(w) {
    this.settings.weather = w;
    this.env.setWeather(w);
  }

  get groundHeightAtDrone() {
    return this.scenery ? this.scenery.groundHeight(this.quad.pos.x, this.quad.pos.z) : 0;
  }

  setOverlay(id) {
    this.settings.overlay = id;
    this.overlay.show(id);
    this.tracker = PATTERNS[id] ? new PatternTracker(PATTERNS[id], 8) : null;
    if (this.tracker) for (const p of this.trail.points) this.tracker.add(p);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.cameras.resize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.trail.setResolution(w * pr, h * pr);
    this.overlay.setResolution(w * pr, h * pr);
    this.missionPath.setResolution(w * pr, h * pr);
    this.post.setSize(w, h);
  }

  start() {
    this.lastFrame = performance.now();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  // ---------------------------------------------------------------- control actions

  setMode(mode, reason = 'pilot') {
    return this.fc.setMode(mode, reason);
  }

  cycleMode(dir) {
    const list = MODES.filter((m) => m !== 'AUTO' || this.fc.mission);
    const i = list.indexOf(this.fc.mode);
    this.setMode(list[(i + dir + list.length) % list.length]);
  }

  toggleArm(source = 'key') {
    if (this.fc.armed) this.fc.requestDisarm(source);
    else this.fc.arm(source);
  }

  emergencyStop() {
    if (!this.fc.armed) return;
    this.fc.emergencyStop();
  }

  resetDrone(force = false, { quiet = false } = {}) {
    if (this.fc.armed && !force) {
      this.msg('Reset refused: disarm first', 'warn');
      return false;
    }
    if (this.fc.armed) this.fc.disarm('Reset');
    this.quad.reset(HOME.x, HOME.z, 0);
    this.battery.reset();
    this.fc.mode = 'STABILIZE';
    this.fc.auto.index = 0;
    this.fc.hoverThr = (DRONE_X4.mass * 9.80665) / (4 * DRONE_X4.maxThrustPerMotor);
    this.fc.fs.batt = 0;
    this.input.setThrottleKeyboard(0);
    this.emit('mode', { mode: 'STABILIZE' });
    if (!quiet) this.msg('Drone reset on the pad with a fresh battery', 'good');
    return true;
  }

  setView(id) {
    this.cameras.setView(id, this.quad);
    this.grid.visible = id === 'overhead';
    this.emit('view', id);
  }

  cycleView() {
    const i = VIEWS.findIndex((v) => v.id === this.cameras.view);
    this.setView(VIEWS[(i + 1) % VIEWS.length].id);
  }

  togglePause() {
    this.paused = !this.paused;
    this.emit('pause', this.paused);
  }

  clearTrail() {
    this.trail.clear();
    if (this.tracker) this.tracker.reset();
    this.flightStart = null;
    this.msg('Flight path trail cleared');
  }

  // ---------------------------------------------------------------- frame loop

  frame(now) {
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (!(dt > 0)) dt = 1 / 60;
    dt = Math.min(dt, 0.1);
    this.tick(dt);
    this.render(dt);
    this.emit('frame', dt);
  }

  // Simulation and visual state for one frame, without rendering.
  tick(dt) {
    const rc = this.input.update(dt);
    // External control (window.DronoSim.setSticks) overrides keyboard and controller.
    if (this.external) Object.assign(rc, this.external);
    const live = this.scenery && !this.loading;
    if (live) this.nearObstacles = this.envState.obstacles = this.obsIndex.near(this.quad.pos.x, this.quad.pos.z, 45);
    // Obstacle avoidance brakes pilot stick inputs in GPS position mode (like consumer drones).
    this.braking = live && this.fc.armed && this.fc.mode === 'LOITER' && this.settings.sensors?.avoidance !== false ? this.sensors.brake(rc) : false;
    if (live && !this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= PHYS_DT && steps < 60) {
        this._physicsStep(PHYS_DT, rc);
        this.acc -= PHYS_DT;
        steps++;
      }
      this._postStep(dt);
    }
    this._visuals(dt);
  }

  render(dt) {
    if (this.renderer.xr.isPresenting) {
      this.renderer.render(this.scene, this.cameras.vrCam);
      return;
    }
    this.post.setNight(this.env.nightFactor);
    this.post.render(this.scene, this.cameras.camera, dt);
    for (const cb of this.frameCallbacks.splice(0)) cb(this.renderer.domElement);
    const rect = this.gimbal.active && this.gimbalRect ? this.gimbalRect() : null;
    if (rect && rect.w > 0) this.gimbal.render(this.scene, rect, this.time);
  }

  // Fast-forward the simulation by `seconds` without rendering (60 Hz frames).
  advance(seconds) {
    const n = Math.max(0, Math.round(seconds * 60));
    for (let i = 0; i < n; i++) {
      this.tick(1 / 60);
      this.emit('frame', 1 / 60);
    }
    this.lastFrame = performance.now();
  }

  _gps(dt) {
    const g = this.gps;
    g.timer += dt;
    if (g.timer < 1.5) {
      g.sats = 0;
      g.fix = false;
    } else if (g.timer < 4) {
      g.sats = 4 + Math.floor((g.timer - 1.5) * 1.6);
      g.hdop = 2.4;
      g.fix = false;
    } else {
      g.sats = 14 + (Math.floor(g.timer / 7) % 3);
      g.hdop = 0.7 + 0.1 * Math.sin(g.timer / 9);
      g.fix = true;
      if (!g.announced) {
        g.announced = true;
        this.msg(`GPS: 3D fix (${g.sats} sats), EKF using GPS`, 'good');
      }
    }
  }

  _physicsStep(dt, rc) {
    this.time += dt;
    this.wind.update(dt);
    this.wind.sample(this.quad.pos, this.envState.wind);
    this.battery.update(dt, this.quad.current, this.settings.batteryDrain);
    this.quad.thrustScale = this.battery.thrustScale;
    const fence = this.fenceConfig;
    this.envState.groundHeight = this.scenery.groundHeight(this.quad.pos.x, this.quad.pos.z);
    this.fc.update(dt, rc, {
      gpsFix: this.gps.fix,
      battPct: this.battery.pct,
      rcValid: this.input.rcValid,
      fence,
    });
    this.quad.step(dt, this.envState);
    // Ditching: touching down on (or flying into) water is a crash.
    if (this.scenery.waterAt && !this.quad.crashed) {
      const w = this.scenery.waterAt(this.quad.pos.x, this.quad.pos.z);
      if (w !== null && this.quad.pos.y - DRONE_X4.gearHeight * 0.5 < w) this.quad.crash('Ditched in water');
    }
    for (const e of this.quad.events.splice(0)) {
      if (e.type === 'crash') {
        this.emit('crash', e);
        this.challenge.event('crash', e);
      }
    }
  }

  _postStep(dt) {
    this._gps(dt);
    const fc = this.fc;
    this.sensors.update(this.quad.pos, fc.yaw, this.nearObstacles, this.scenery.groundHeight, DRONE_X4.gearHeight);
    if (fc.fs.fence && !this._fenceFlag) this.challenge.event('fence');
    this._fenceFlag = fc.fs.fence;

    // Trail sampling (only while airborne).
    if (fc.armed && !fc.landed) {
      if (!this.flightStart) this.flightStart = this.time;
      const q = this.quad;
      const p = { x: q.pos.x, y: q.pos.y, z: q.pos.z, gy: this.scenery.groundHeight(q.pos.x, q.pos.z), alt: fc.alt, speed: Math.hypot(q.vel.x, q.vel.y, q.vel.z), mode: fc.mode, t: this.time };
      if (this.trail.add(p)) {
        if (this.tracker) this.tracker.add(p);
        this.challenge.sample(p);
      }
    }
    this.challenge.update(dt, fc, this.quad);

    // 10 Hz flight log.
    this.logTimer += dt;
    if (this.logTimer >= 0.1) {
      this.logTimer = 0;
      if (fc.armed || this.quad.crashed) this._logRow();
    }
  }

  _logRow() {
    const q = this.quad;
    const fc = this.fc;
    if (this.logRows.length > 72000) this.logRows.splice(0, 6000);
    const ws = Math.hypot(this.envState.wind.x, this.envState.wind.z);
    this.logRows.push([
      this.time.toFixed(2), fc.armed ? 1 : 0, fc.mode, (-q.pos.z).toFixed(2), q.pos.x.toFixed(2), fc.alt.toFixed(2),
      fc.groundSpeed.toFixed(2), fc.vz.toFixed(2), fc.heading.toFixed(1), (fc.roll * RAD).toFixed(1), (fc.pitch * RAD).toFixed(1),
      this.battery.filtered.toFixed(2), this.battery.pct.toFixed(1), this.battery.current.toFixed(1),
      ws.toFixed(1), q.out[0].toFixed(3), q.out[1].toFixed(3), q.out[2].toFixed(3), q.out[3].toFixed(3), q.crashed ? 1 : 0,
    ]);
  }

  windAtDrone() {
    const w = this.envState.wind;
    const speed = Math.hypot(w.x, w.z);
    // Report direction the wind comes FROM.
    const from = bearingDeg(-w.x, -w.z);
    return { speed, from, cardinal: compassPoint(from) };
  }

  _visuals(dt) {
    const fc = this.fc;
    const night = this.env.nightFactor;
    this.drone.update(this.paused ? 0 : dt, fc, night);
    if (this.scenery) {
      this.scenery.setNight(night);
      if (!this.paused) this.scenery.update(dt, this.time, this.windAt);
    }
    if (!this.paused) {
      swayUniforms.uTime.value += dt;
      this.wind.sample(_wpos.set(this.quad.pos.x, 12, this.quad.pos.z), _sway);
      swayUniforms.uWind.value.set(_sway.x, _sway.z);
    }
    this.cameras.update(dt, this.quad);
    if (this.gimbal.active) this.gimbal.updatePose(this.quad, fc.yaw);
    const cam = this.renderer.xr.isPresenting ? this.cameras.vrCam : this.cameras.camera;
    this.missionPath.update(cam, this.renderer.domElement.clientHeight || window.innerHeight, fc);
    const camPos = cam.getWorldPosition(_wind);
    this.env.update(dt, this.quad.pos, camPos, this.envState.wind);
    const listen = this.cameras.view === 'fpv' ? 0.3 : camPos.distanceTo(this.quad.pos);
    this.audio.update(dt, {
      outputs: this.quad.out,
      armed: fc.armed,
      distance: listen,
      proximity: this.settings.sensors?.beeper !== false && !fc.landed ? this.sensors.nearest.dist : Infinity,
      crashed: this.quad.crashed,
    });
    this.trail.updateDropLine(this.quad.pos, this.settings.trail.visible && this.cameras.view !== 'overhead' && this.cameras.view !== 'fpv', this.groundHeightAtDrone);
    const f = this.fenceConfig;
    this.fenceVis.update(fc.distHome, fc.alt, f);
    // Heading marker keeps the drone visible at any overhead zoom level.
    const m = this.marker;
    m.visible = this.cameras.view === 'overhead';
    if (m.visible) {
      m.position.set(this.quad.pos.x, this.quad.pos.y + 1, this.quad.pos.z);
      m.rotation.y = fc.yaw;
      m.scale.setScalar(this.cameras.overhead.size / 34);
    }
  }

  // ---------------------------------------------------------------- capture & export

  flightSummary() {
    return summariseFlight(this.trail.points);
  }

  async capture(kind = 'view') {
    const prevView = this.cameras.view;
    const r = this.renderer;
    if (r.xr.isPresenting) {
      this.msg('Capture is not available while in VR', 'warn');
      return null;
    }
    const overhead = kind === 'overhead';
    if (overhead && prevView !== 'overhead') this.setView('overhead');
    this.cameras.update(0, this.quad);
    const gridWas = this.grid.visible;
    this.grid.visible = this.cameras.view === 'overhead';
    this.post.render(this.scene, this.cameras.camera, 0);
    const sum = this.flightSummary();
    const stats = [
      ['Flight time', fmtDur(sum.duration)],
      ['Distance flown', `${sum.dist.toFixed(0)} m`],
      ['Max height', `${sum.maxAlt.toFixed(1)} m`],
      ['Max speed', `${sum.maxSpeed.toFixed(1)} m/s`],
      ['Wind', `${this.settings.wind.speed.toFixed(1)} m/s from ${this.settings.wind.dirDeg.toFixed(0)}`],
      ['Scene', this.sceneDef ? this.sceneDef.name : '-'],
      ['Conditions', `${this.settings.timeOfDay}, ${this.settings.weather || 'clear'}`],
      ['Trail samples', String(sum.samples)],
      ['Mode now', MODE_INFO[this.fc.mode].label],
    ];
    if (this.tracker && this.tracker.n > 0) {
      const st = this.tracker.stats();
      stats.push(
        ['Reference', PATTERNS[this.settings.overlay].name],
        ['Track RMS', `${st.rms.toFixed(2)} m`],
        ['Max deviation', `${st.max.toFixed(2)} m`],
        ['Height', `${st.altMean.toFixed(1)} +/- ${st.altStd.toFixed(2)} m`],
        ['Coverage', `${(st.coverage * 100).toFixed(0)}%`],
        ['Pattern score', `${st.score}/100`],
      );
    }
    const viewLabel = VIEWS.find((v) => v.id === this.cameras.view).label;
    const mppDevice = this.cameras.view === 'overhead' ? this.cameras.metresPerPixel(r.domElement.height) : null;
    const { canvas, filename } = composeCapture(r.domElement, {
      title: overhead ? 'Flight Path Trail - Overhead Analysis' : 'Flight Path Trail Capture',
      kind: overhead ? 'overhead' : this.cameras.view,
      view: viewLabel,
      registration: this.settings.registration,
      pilot: this.settings.pilotName,
      instructor: this.settings.instructorName,
      organisation: this.settings.organisation,
      stats,
      mppDevice,
    });
    this.grid.visible = gridWas;
    if (overhead && prevView !== 'overhead') this.setView(prevView);
    const { url } = await downloadCanvas(canvas, filename);
    const entry = { url, filename, thumb: thumbnail(canvas), time: new Date() };
    this.captures.unshift(entry);
    this.emit('capture', entry);
    this.msg(`Saved ${filename}`, 'good');
    return entry;
  }

  exportLog() {
    const head = 'time_s,armed,mode,north_m,east_m,alt_m,ground_speed_ms,vz_ms,heading_deg,roll_deg,pitch_deg,batt_v,batt_pct,current_a,wind_ms,m1,m2,m3,m4,crashed';
    const meta = [
      `# DronoSim flight log`,
      `# registration,${this.settings.registration}`,
      `# pilot,${this.settings.pilotName}`,
      `# instructor,${this.settings.instructorName}`,
      `# organisation,${this.settings.organisation}`,
      `# exported,${new Date().toISOString()}`,
    ];
    const body = this.logRows.map((r) => r.join(',')).join('\n');
    downloadText(`${meta.join('\n')}\n${head}\n${body}\n`, `DronoSim_${(this.settings.registration || 'UIN').replace(/[^A-Za-z0-9_-]+/g, '-')}_log_${timestampForFile()}.csv`);
    this.msg(`Flight log exported (${this.logRows.length} rows)`, 'good');
  }
}

// 5 m analysis grid for the overhead view (major lines every 25 m), drawn over the scene.
function makeGrid() {
  const minor = [];
  const major = [];
  const ext = 300;
  for (let v = -ext; v <= ext; v += 5) {
    const arr = v % 25 === 0 ? major : minor;
    arr.push(-ext, 0.05, v, ext, 0.05, v, v, 0.05, -ext, v, 0.05, ext);
  }
  const mk = (arr, opacity) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(arr, 3));
    const l = new LineSegments(g, new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthTest: false, depthWrite: false }));
    l.renderOrder = 15;
    return l;
  };
  const grid = new Group();
  grid.add(mk(minor, 0.14), mk(major, 0.38));
  grid.visible = false;
  return grid;
}

function makeMarker() {
  const sh = new Shape();
  sh.moveTo(0, 1.2);
  sh.lineTo(0.8, -0.8);
  sh.lineTo(0, -0.35);
  sh.lineTo(-0.8, -0.8);
  sh.closePath();
  const g = new ShapeGeometry(sh);
  g.rotateX(-Math.PI / 2);
  const m = new Mesh(g, new MeshBasicMaterial({ color: 0xffe14d, depthTest: false, transparent: true, opacity: 0.95 }));
  const outline = new Mesh(g.clone().scale(1.35, 1, 1.35), new MeshBasicMaterial({ color: 0x0b1220, depthTest: false, transparent: true, opacity: 0.85 }));
  outline.renderOrder = 19;
  m.renderOrder = 20;
  m.add(outline);
  outline.position.y = -0.01;
  m.visible = false;
  return m;
}

function fmtDur(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function thumbnail(canvas) {
  const t = document.createElement('canvas');
  const w = 240;
  t.width = w;
  t.height = Math.round((canvas.height / canvas.width) * w);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.8);
}
