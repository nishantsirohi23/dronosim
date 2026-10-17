// window.DronoSim: a small API for agents driving the simulator in a browser (scripted pilots,
// vision-based policies, browser automation such as Playwright or Puppeteer). See docs/AGENT_API.md.
import { VERSION } from '../config.js';
import { MODES } from '../fc/flightController.js';
import { SCENES } from '../world/scenes/index.js';
import { VIEWS } from '../world/cameras.js';
import { RAD, clamp } from '../util/math.js';

export function installBrowserApi(sim) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const api = {
    version: VERSION,
    scenes: SCENES.map((s) => s.id),
    modes: [...MODES],
    views: VIEWS.map((v) => v.id),

    // Snapshot of the vehicle and environment. Heights are metres above home.
    state() {
      const q = sim.quad;
      const fc = sim.fc;
      const d = sim.sensors.dist;
      const fin = (v) => (Number.isFinite(v) ? v : null);
      return {
        t: sim.time,
        scene: sim.sceneId,
        mode: fc.mode,
        armed: fc.armed,
        landed: fc.landed,
        crashed: q.crashed,
        crashReason: q.crashReason,
        position: { x: q.pos.x, y: fc.alt, z: q.pos.z, north: -q.pos.z, east: q.pos.x },
        velocity: { x: q.vel.x, y: q.vel.y, z: q.vel.z },
        attitude: { roll: fc.roll * RAD, pitch: fc.pitch * RAD, heading: fc.heading },
        alt: fc.alt,
        agl: d.down,
        groundSpeed: fc.groundSpeed,
        verticalSpeed: fc.vz,
        battery: { pct: sim.battery.pct, voltage: sim.battery.filtered },
        wind: sim.windAtDrone(),
        sensors: { front: fin(d.front), right: fin(d.right), back: fin(d.back), left: fin(d.left), down: d.down },
        home: { x: fc.home.x, z: fc.home.z, distance: fc.distHome, bearing: fc.bearingHome },
        gpsFix: sim.gps.fix,
      };
    },

    // Override the pilot sticks until release(): throttle 0..1, yaw/pitch/roll -1..1 (Mode 2 meaning).
    setSticks({ throttle, yaw, pitch, roll } = {}) {
      sim.external = {
        throttle: clamp(num(throttle, 0.5), 0, 1),
        yaw: clamp(num(yaw, 0), -1, 1),
        pitch: clamp(num(pitch, 0), -1, 1),
        roll: clamp(num(roll, 0), -1, 1),
      };
    },
    release() {
      sim.external = null;
    },
    arm: () => sim.fc.arm('api'),
    disarm: () => sim.fc.requestDisarm('api'),
    setMode: (mode) => sim.setMode(String(mode).toUpperCase()),
    reset: () => sim.resetDrone(),
    loadScene: (id) => sim.loadScene(id),
    setView: (id) => sim.setView(id),
    setWeather: (w) => sim.setWeather(w),
    setTimeOfDay: (t) => {
      sim.settings.timeOfDay = t;
      sim.env.setTimeOfDay(t);
    },
    // Run the simulation forward without rendering (fast; e.g. to skip GPS start-up).
    advance: (seconds) => sim.advance(seconds),
    pause: (p = true) => {
      if (sim.paused !== p) sim.togglePause();
    },

    // Resolves with the next rendered frame of the main view as a data URL.
    frame({ type = 'image/jpeg', quality = 0.85 } = {}) {
      return new Promise((resolve) => sim.frameCallbacks.push((canvas) => resolve(canvas.toDataURL(type, quality))));
    },

    on: (event, fn) => sim.on(event, fn),
  };
  window.DronoSim = api;
  return api;
}

// Optional URL parameters, e.g. ?scene=forest&time=night&weather=rain&quality=low&view=chase
//   autofly=<metres>  take off in Loiter once GPS is ready and hover at that height
//   ui=0              hide the side panels and message log (clean view for recording)
//   ff=<seconds>      fast-forward the simulation after the scene loads
export function applyUrlParams(settings) {
  const p = new URLSearchParams(window.location.search);
  const out = { view: p.get('view'), autofly: Number(p.get('autofly')) || 0, ui: p.get('ui'), ff: Number(p.get('ff')) || 0 };
  if (p.get('scene')) settings.scene = p.get('scene');
  if (p.get('time')) settings.timeOfDay = p.get('time');
  if (p.get('weather')) settings.weather = p.get('weather');
  if (p.get('quality')) settings.quality = p.get('quality');
  return out;
}

// Hands-off take-off used by ?autofly=: climbs in Loiter and holds the height.
export function autoFly(sim, api, height) {
  let phase = 'wait';
  sim.on('frame', () => {
    if (phase === 'wait' && sim.gps.fix && sim.scenery && !sim.loading) {
      api.setSticks({ throttle: 0 });
      if (sim.fc.mode === 'LOITER' || api.setMode('LOITER')) phase = 'arm';
    } else if (phase === 'arm') {
      phase = api.arm() ? 'climb' : 'wait';
      api.setSticks({ throttle: 0.85 });
    } else if (phase === 'climb' && sim.fc.alt >= height) {
      api.setSticks({ throttle: 0.5 });
      phase = 'hold';
    }
  });
}
