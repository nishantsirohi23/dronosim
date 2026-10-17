// AUTO (waypoint mission) mode: mission model, templates and headless closed-loop missions.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { Quadcopter } from '../src/physics/quadcopter.js';
import { FlightController } from '../src/fc/flightController.js';
import { WindModel } from '../src/physics/wind.js';
import { Battery } from '../src/physics/battery.js';
import { DRONE_X4, FC_PARAMS, DEFAULT_GAINS } from '../src/config.js';
import { PATTERNS } from '../src/world/patterns.js';
import {
  createMission, missionFromJSON, missionToJSON, missionPath, missionHazards, normalizeItem, patternMission, surveyMission, validateMission,
} from '../src/fc/mission.js';

const DT = 1 / 400;

function makeSim({ wind = 0, gust = 0, fence = { enabled: false } } = {}) {
  const quad = new Quadcopter(DRONE_X4);
  quad.reset(0, 0, 0);
  const log = [];
  const events = [];
  const fc = new FlightController(quad, FC_PARAMS, DEFAULT_GAINS, (t, e) => {
    if (t === 'msg') log.push(e.text);
    else events.push({ type: t, ...e });
  });
  const windModel = new WindModel();
  windModel.configure({ speed: wind, dirDeg: 270, gustiness: gust, turbulence: gust > 0 });
  const battery = new Battery(DRONE_X4.battery);
  const env = { wind: new Vector3(), groundHeight: 0, obstacles: [], torqueNoise: windModel.torque };
  const rc = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
  const sens = { gpsFix: true, battPct: null, rcValid: true, fence };
  const sim = {
    quad, fc, rc, log, events, battery, sens,
    t: 0,
    run(seconds, each) {
      const n = Math.round(seconds / DT);
      for (let i = 0; i < n; i++) {
        windModel.update(DT);
        windModel.sample(quad.pos, env.wind);
        battery.update(DT, quad.current);
        quad.thrustScale = battery.thrustScale;
        fc.update(DT, rc, { gpsFix: sens.gpsFix, battPct: sens.battPct ?? battery.pct, rcValid: sens.rcValid, fence: sens.fence });
        quad.step(DT, env);
        sim.t += DT;
        if (each && each(sim) === true) return true;
      }
      return false;
    },
    until(seconds, cond) {
      return sim.run(seconds, cond);
    },
  };
  return sim;
}

const FOUR_WP = [
  { type: 'TAKEOFF', alt: 10 },
  { type: 'WAYPOINT', x: 0, z: -30, alt: 10, speed: 5 },
  { type: 'WAYPOINT', x: 30, z: -30, alt: 15, speed: 6 },
  { type: 'WAYPOINT', x: 30, z: -60, alt: 12, speed: 4, hold: 3 },
  { type: 'WAYPOINT', x: -20, z: -50, alt: 8, speed: 5 },
  { type: 'RTL' },
];

// Arm in LOITER on the pad, switch to AUTO and raise the throttle to start (ArduPilot flow).
function startOnGround(s, mission) {
  s.fc.setMission(mission);
  s.fc.setMode('LOITER');
  s.run(0.2);
  assert.equal(s.fc.arm('test'), true);
  assert.equal(s.fc.setMode('AUTO'), true);
  s.rc.throttle = 0.5;
}

function takeoffInLoiter(s, seconds = 3) {
  s.fc.setMode('LOITER');
  s.fc.arm('test');
  s.rc.throttle = 1;
  s.run(seconds);
  s.rc.throttle = 0.5;
  s.run(1);
}

// ------------------------------------------------------------------ mission model

test('mission JSON export/import round trip and validation errors', () => {
  const m = createMission('Round trip', FOUR_WP);
  const back = missionFromJSON(missionToJSON(m));
  assert.deepEqual(back, m);
  assert.equal(back.items[3].hold, 3);
  assert.equal(back.items[1].hold, 0);
  // Accepts a bare item list and MAVLink-style command names.
  const bare = missionFromJSON(JSON.stringify([{ command: 'MAV_CMD_NAV_TAKEOFF', alt: 5 }, { type: 'waypoint', x: 1, z: -2 }, { type: 'NAV_RETURN_TO_LAUNCH' }]));
  assert.deepEqual(bare.items.map((i) => i.type), ['TAKEOFF', 'WAYPOINT', 'RTL']);
  // Values are clamped to the allowed range.
  assert.equal(normalizeItem({ type: 'WAYPOINT', x: 0, z: 0, alt: 500, speed: 99 }).alt, 120);
  assert.equal(normalizeItem({ type: 'WAYPOINT', x: 0, z: 0, alt: 10, speed: 99 }).speed, 12);
  assert.throws(() => missionFromJSON('{not json'), /Not valid JSON/);
  assert.throws(() => missionFromJSON('{"items": [{"type": "WAYPOINT", "z": 3}]}'), /Item 1: "x" is required/);
  assert.throws(() => missionFromJSON('{"items": [{"type": "FLIP"}]}'), /unknown command "FLIP"/);
  assert.throws(() => missionFromJSON('{"format": "qgc-plan", "items": []}'), /Unknown file format/);
  assert.throws(() => missionFromJSON('{"name": "x"}'), /No "items" list/);
});

test('mission checks: structure, geofence and obstacle warnings', () => {
  assert.deepEqual(validateMission(createMission('e')).errors, ['Mission is empty']);
  const ok = validateMission(createMission('ok', FOUR_WP));
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.warnings.length, 0, ok.warnings.join('; '));
  const noEnd = validateMission(createMission('n', [{ type: 'WAYPOINT', x: 0, z: -10 }]));
  assert.ok(noEnd.warnings.some((w) => /not TAKEOFF/.test(w)));
  assert.ok(noEnd.warnings.some((w) => /No RTL or LAND/.test(w)));
  const fenced = validateMission(createMission('f', FOUR_WP), { fence: { enabled: true, maxAlt: 14, radius: 40 } });
  assert.ok(fenced.warnings.some((w) => /outside the geofence radius/.test(w)));
  assert.ok(fenced.warnings.some((w) => /fence ceiling/.test(w)));
  const tree = { type: 'cyl', name: 'tree', x: 15, z: -30, r: 2, h: 14 };
  const hz = missionHazards(missionPath(createMission('h', FOUR_WP)), [tree]);
  assert.equal(hz.length, 1);
  assert.equal(hz[0].item, 2);
});

test('planned path and estimates follow the mission', () => {
  const path = missionPath(createMission('p', FOUR_WP), { rtlAlt: 15 });
  assert.equal(path.markers.length, 4);
  assert.deepEqual(path.markers.map((m) => m.item), [1, 2, 3, 4]);
  const last = path.points[path.points.length - 1];
  assert.deepEqual([last.x, last.z, last.alt], [0, 0, 0]);
  assert.ok(path.ended);
  assert.ok(path.distance > 180 && path.distance < 260, `distance ${path.distance}`);
  assert.ok(path.time > 50 && path.time < 120, `time ${path.time}`);
});

test('templates: reference patterns and lawnmower survey grid', () => {
  for (const id of ['circle', 'square', 'figure8']) {
    const m = patternMission(id, { alt: 8, speed: 4 });
    const wps = m.items.filter((i) => i.type === 'WAYPOINT');
    assert.equal(m.items[0].type, 'TAKEOFF');
    assert.equal(m.items.at(-1).type, 'RTL');
    assert.equal(wps.length, PATTERNS[id].checkpoints.length + 1);
    assert.deepEqual([wps[0].x, wps[0].z], [wps.at(-1).x, wps.at(-1).z], 'pattern closes the loop');
    assert.ok(wps.every((w) => w.alt === 8 && w.speed === 4));
  }
  const s = surveyMission({ x0: -20, z0: -70, x1: 20, z1: -30 }, { spacing: 10, alt: 15, speed: 5, axis: 'ew' });
  const wps = s.items.filter((i) => i.type === 'WAYPOINT');
  assert.equal(wps.length, 10, '5 east-west lines');
  const rows = [...new Set(wps.map((w) => w.z))];
  assert.deepEqual(rows, [-30, -40, -50, -60, -70], 'starts on the edge nearest home, 10 m apart');
  for (let i = 0; i < wps.length; i += 2) assert.equal(wps[i].z, wps[i + 1].z, 'each line is flown east-west');
  assert.notEqual(wps[0].x, wps[2].x, 'alternating direction (lawnmower)');
  const ns = surveyMission({ x0: 0, z0: -10, x1: 25, z1: -40 }, { spacing: 10, axis: 'ns' });
  assert.ok(ns.items.filter((i) => i.type === 'WAYPOINT').every((w, i, a) => i % 2 === 1 || w.x === a[i + 1].x));
  assert.throws(() => surveyMission({ x0: 0, z0: 0, x1: 1, z1: 1 }), /too small/);
});

// ------------------------------------------------------------------ AUTO mode rules

test('AUTO refuses to arm, needs a mission and GPS, and on the ground a TAKEOFF first', () => {
  const s = makeSim();
  s.run(0.2);
  assert.equal(s.fc.setMode('AUTO'), false, 'no mission');
  s.fc.setMission(createMission('m', FOUR_WP));
  s.sens.gpsFix = false;
  s.run(0.1);
  assert.equal(s.fc.setMode('AUTO'), false, 'no GPS');
  s.sens.gpsFix = true;
  s.run(0.1);
  assert.equal(s.fc.setMode('AUTO'), true);
  assert.equal(s.fc.arm('test'), false);
  assert.ok(s.log.some((l) => /Auto mode not armable: arm in Loiter/.test(l)));
  s.fc.setMode('LOITER');
  s.fc.setMission(createMission('m', FOUR_WP.slice(1)));
  assert.equal(s.fc.setMode('AUTO'), false, 'mission without TAKEOFF on the ground');
});

test('AUTO waits on the ground until the throttle is raised', () => {
  const s = makeSim();
  startOnGround(s, createMission('m', FOUR_WP));
  s.rc.throttle = 0;
  s.run(3);
  assert.equal(s.fc.landed, true);
  assert.ok(s.quad.pos.y < 0.3);
  assert.equal(s.fc.autoDetail(), 'Raise the throttle to start the mission');
  s.rc.throttle = 0.5;
  s.run(6);
  assert.equal(s.fc.landed, false);
  assert.ok(s.fc.alt > 5);
});

// ------------------------------------------------------------------ closed-loop missions

test('AUTO flies a 4-waypoint mission in 4 m/s gusty wind and lands home with RTL', () => {
  const s = makeSim({ wind: 4, gust: 0.4 });
  const mission = createMission('Four waypoints', FOUR_WP);
  const wps = mission.items.map((it, i) => ({ ...it, i })).filter((it) => it.type === 'WAYPOINT');
  const best = new Map(wps.map((w) => [w.i, Infinity]));
  let yawErrSum = 0;
  let yawErrN = 0;
  let maxAlt = 0;
  startOnGround(s, mission);
  s.run(240, () => {
    const q = s.quad;
    const a = s.fc.auto;
    const alt = q.pos.y - DRONE_X4.gearHeight;
    // Closest approach to every waypoint over the whole flight, measured from the airframe.
    for (const w of wps) best.set(w.i, Math.min(best.get(w.i), Math.hypot(q.pos.x - w.x, alt - w.alt, q.pos.z - w.z)));
    if (best.has(a.index) && s.fc.mode === 'AUTO') {
      const it = mission.items[a.index];
      // Mid-leg the nose should point at the waypoint.
      if (a.phase === 'GO' && a.distH > 8 && a.distH < Math.hypot(it.x - a.origin.x, it.z - a.origin.z) - 8) {
        const want = Math.atan2(-(it.x - q.pos.x), -(it.z - q.pos.z));
        yawErrSum += Math.abs(Math.atan2(Math.sin(want - s.fc.yaw), Math.cos(want - s.fc.yaw)));
        yawErrN++;
      }
    }
    maxAlt = Math.max(maxAlt, s.fc.alt);
    return !s.fc.armed;
  });
  const reached = s.events.filter((e) => e.type === 'wp');
  const home = Math.hypot(s.quad.pos.x, s.quad.pos.z);
  const yawErr = (yawErrSum / Math.max(yawErrN, 1)) * 57.3;
  console.log(`  closest approach per WP: ${[...best.values()].map((d) => d.toFixed(2)).join(', ')} m; acceptance at ${reached.map((e) => e.dist.toFixed(2)).join(', ')} m`);
  console.log(`  mean mid-leg yaw error ${yawErr.toFixed(1)} deg, max alt ${maxAlt.toFixed(1)} m, landed ${home.toFixed(2)} m from home after ${s.t.toFixed(0)} s`);
  assert.deepEqual(reached.map((e) => e.index), wps.map((w) => w.i), 'every waypoint reached in order');
  for (const [i, d] of best) assert.ok(d <= FC_PARAMS.wpRadius, `waypoint item ${i + 1} closest ${d.toFixed(2)} m`);
  for (const e of reached) assert.ok(e.dist <= FC_PARAMS.wpRadius);
  assert.ok(yawErr < 15, `yaw toward waypoint, mean error ${yawErr.toFixed(1)} deg`);
  assert.ok(s.log.some((l) => /Mission 6\/6: return to launch/.test(l)));
  assert.ok(home < 1.5, `landed ${home.toFixed(2)} m from home`);
  assert.equal(s.fc.armed, false);
  assert.equal(s.fc.auto.complete, true);
  assert.equal(s.quad.crashed, false);
  assert.ok(s.log.includes('Mission complete: landed, disarming'));
});

test('waypoint hold time and LOITER_TIME are respected', () => {
  const s = makeSim();
  startOnGround(s, createMission('hold', [
    { type: 'TAKEOFF', alt: 6 },
    { type: 'WAYPOINT', x: 0, z: -15, alt: 6, speed: 5, hold: 4 },
    { type: 'LOITER_TIME', time: 3 },
    { type: 'WAYPOINT', x: 10, z: -15, alt: 6, speed: 5 },
  ]));
  const starts = {};
  s.run(60, () => {
    const i = s.fc.auto.index;
    if (starts[i] === undefined) starts[i] = s.t;
    return s.fc.auto.complete;
  });
  const reach1 = s.events.find((e) => e.type === 'wp' && e.index === 1).t;
  console.log(`  WP hold ${(starts[2] - reach1).toFixed(2)} s, loiter ${(starts[3] - starts[2]).toFixed(2)} s`);
  assert.ok(Math.abs(starts[2] - reach1 - 4) < 0.05);
  assert.ok(Math.abs(starts[3] - starts[2] - 3) < 0.05);
  // Without RTL/LAND the drone holds at the last waypoint.
  s.run(5);
  assert.equal(s.fc.mode, 'AUTO');
  assert.equal(s.fc.armed, true);
  assert.ok(Math.hypot(s.quad.pos.x - 10, s.quad.pos.z + 15) < 1.5);
  assert.ok(s.fc.groundSpeed < 0.5);
});

test('pilot can take over mid-mission and AUTO resumes the same item', () => {
  const s = makeSim({ wind: 3, gust: 0.3 });
  startOnGround(s, createMission('m', FOUR_WP));
  s.until(120, () => s.fc.auto.index === 2 && s.fc.auto.distH < 20);
  assert.equal(s.fc.setMode('LOITER'), true);
  s.run(6);
  const p = s.quad.pos.clone();
  s.run(4);
  console.log(`  after takeover: drift ${Math.hypot(s.quad.pos.x - p.x, s.quad.pos.z - p.z).toFixed(2)} m, speed ${s.fc.groundSpeed.toFixed(2)} m/s`);
  assert.ok(s.fc.groundSpeed < 0.6, 'LOITER stops the drone');
  assert.ok(Math.hypot(s.quad.pos.x - p.x, s.quad.pos.z - p.z) < 1.5);
  assert.equal(s.fc.setMode('AUTO'), true);
  assert.equal(s.fc.auto.index, 2);
  assert.ok(s.log.some((l) => /resuming at item 3/.test(l)));
  const ok = s.until(60, () => s.fc.auto.index > 2);
  assert.ok(ok, 'waypoint 3 reached after resuming');
});

test('battery failsafe in AUTO switches to RTL', () => {
  const s = makeSim();
  startOnGround(s, createMission('m', FOUR_WP));
  s.until(60, () => s.fc.auto.index === 2);
  s.sens.battPct = 20;
  s.run(0.1);
  assert.equal(s.fc.mode, 'RTL');
  assert.ok(s.log.some((l) => /Battery failsafe LOW/.test(l)));
});

test('geofence breach in AUTO switches to RTL and blocks re-entering AUTO', () => {
  const fence = { enabled: true, maxAlt: 30, radius: 35 };
  const s = makeSim({ fence });
  startOnGround(s, createMission('m', FOUR_WP));
  const hit = s.until(90, () => s.fc.mode !== 'AUTO');
  assert.ok(hit);
  console.log(`  fence breach: mode ${s.fc.mode}, dist ${s.fc.distHome.toFixed(1)} m`);
  assert.equal(s.fc.mode, 'RTL');
  assert.equal(s.fc.fs.fence, true);
  assert.equal(s.fc.setMode('AUTO'), false);
  s.until(90, () => !s.fc.armed);
  assert.ok(Math.hypot(s.quad.pos.x, s.quad.pos.z) < 1.5);
});

test('radio failsafe in AUTO switches to RTL', () => {
  const s = makeSim();
  startOnGround(s, createMission('m', FOUR_WP));
  s.until(60, () => s.fc.auto.index === 2);
  s.sens.rcValid = false;
  s.run(0.1);
  assert.equal(s.fc.mode, 'RTL');
  assert.ok(s.log.some((l) => /Radio failsafe/.test(l)));
});

test('AUTO engaged in the air skips a lower takeoff and flies a reference pattern', () => {
  const s = makeSim({ wind: 2, gust: 0.2 });
  const m = patternMission('square', { alt: 8, speed: 4 });
  s.fc.setMission(m);
  takeoffInLoiter(s, 5);
  const alt0 = s.fc.alt;
  assert.ok(alt0 > 8, `alt ${alt0}`);
  assert.equal(s.fc.setMode('AUTO'), true);
  s.run(0.1);
  assert.equal(s.fc.auto.index, 1, 'TAKEOFF below current height completes at once');
  const done = s.until(150, () => !s.fc.armed);
  const reached = s.events.filter((e) => e.type === 'wp');
  console.log(`  square pattern: ${reached.length} waypoints, landed ${Math.hypot(s.quad.pos.x, s.quad.pos.z).toFixed(2)} m from home in ${s.t.toFixed(0)} s`);
  assert.ok(done);
  assert.equal(reached.length, m.items.filter((i) => i.type === 'WAYPOINT').length);
  assert.ok(reached.every((e) => e.dist <= 2));
  assert.equal(s.quad.crashed, false);
});
