// Headless closed-loop flight tests: physics + flight controller, no rendering.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { Quadcopter } from '../src/physics/quadcopter.js';
import { FlightController } from '../src/fc/flightController.js';
import { WindModel } from '../src/physics/wind.js';
import { Battery } from '../src/physics/battery.js';
import { DRONE_X4, FC_PARAMS, DEFAULT_GAINS } from '../src/config.js';

const DT = 1 / 400;

function makeSim({ wind = 0, gust = 0, fence = { enabled: false } } = {}) {
  const quad = new Quadcopter(DRONE_X4);
  quad.reset(0, 0, 0);
  const log = [];
  const fc = new FlightController(quad, FC_PARAMS, DEFAULT_GAINS, (t, e) => t === 'msg' && log.push(e.text));
  const windModel = new WindModel();
  windModel.configure({ speed: wind, dirDeg: 270, gustiness: gust, turbulence: gust > 0 });
  const battery = new Battery(DRONE_X4.battery);
  const env = { wind: new Vector3(), groundHeight: 0, obstacles: [], torqueNoise: windModel.torque };
  const rc = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
  const sim = {
    quad, fc, rc, log, battery,
    t: 0,
    run(seconds, each) {
      const n = Math.round(seconds / DT);
      for (let i = 0; i < n; i++) {
        if (each) each(sim);
        windModel.update(DT);
        windModel.sample(quad.pos, env.wind);
        battery.update(DT, quad.current);
        quad.thrustScale = battery.thrustScale;
        fc.update(DT, rc, { gpsFix: true, battPct: battery.pct, rcValid: true, fence });
        quad.step(DT, env);
        sim.t += DT;
      }
    },
  };
  return sim;
}

test('arming is refused with throttle high, accepted with throttle low', () => {
  const s = makeSim();
  s.rc.throttle = 0.6;
  s.run(0.1);
  assert.equal(s.fc.arm('test'), false);
  s.rc.throttle = 0;
  s.run(0.1);
  assert.equal(s.fc.arm('test'), true);
});

test('stick arming gesture arms after 2 s', () => {
  const s = makeSim();
  s.rc.yaw = 1;
  s.run(2.2);
  assert.equal(s.fc.armed, true);
});

test('ALT_HOLD takeoff and hover holds altitude and attitude', () => {
  const s = makeSim();
  s.fc.setMode('ALT_HOLD');
  s.fc.arm('test');
  s.rc.throttle = 1;
  s.run(3);
  s.rc.throttle = 0.5;
  s.run(6);
  const alt0 = s.fc.alt;
  let maxDev = 0;
  let maxTilt = 0;
  s.run(5, () => {
    maxDev = Math.max(maxDev, Math.abs(s.fc.alt - alt0));
    maxTilt = Math.max(maxTilt, Math.abs(s.fc.roll), Math.abs(s.fc.pitch));
  });
  console.log(`  hover alt ${alt0.toFixed(2)} m, max dev ${maxDev.toFixed(3)} m, max tilt ${(maxTilt * 57.3).toFixed(2)} deg, hoverThr ${s.fc.hoverThr.toFixed(3)}`);
  assert.ok(alt0 > 4 && alt0 < 9, `alt ${alt0}`);
  assert.ok(maxDev < 0.2);
  assert.ok(maxTilt < 0.05);
});

test('STABILIZE responds to pitch stick and self-levels', () => {
  const s = makeSim();
  s.fc.arm('test');
  s.rc.throttle = 0.75;
  s.run(2);
  s.rc.throttle = 0.5;
  s.rc.pitch = 1;
  let maxPitch = 0;
  s.run(1.5, () => (maxPitch = Math.min(maxPitch, s.fc.pitch)));
  const speed = s.fc.groundSpeed;
  s.rc.pitch = 0;
  s.run(1.5);
  console.log(`  max pitch ${(maxPitch * 57.3).toFixed(1)} deg, speed ${speed.toFixed(1)} m/s, pitch after release ${(s.fc.pitch * 57.3).toFixed(2)} deg`);
  assert.ok(maxPitch < -0.5 && maxPitch > -0.7, 'pitch should approach -35 deg');
  assert.ok(speed > 3);
  assert.ok(Math.abs(s.fc.pitch) < 0.05);
  assert.equal(s.quad.crashed, false);
});

test('yaw stick changes heading', () => {
  const s = makeSim();
  s.fc.setMode('ALT_HOLD');
  s.fc.arm('test');
  s.rc.throttle = 1;
  s.run(2);
  s.rc.throttle = 0.5;
  s.rc.yaw = 1;
  s.run(2);
  s.rc.yaw = 0;
  s.run(1);
  console.log(`  heading after 2 s full right yaw: ${s.fc.heading.toFixed(1)} deg`);
  assert.ok(s.fc.heading > 120 && s.fc.heading < 220);
});

test('LOITER holds position in 6 m/s gusty wind', () => {
  const s = makeSim({ wind: 6, gust: 0.4 });
  s.fc.setMode('LOITER');
  s.fc.arm('test');
  s.rc.throttle = 1;
  s.run(3);
  s.rc.throttle = 0.5;
  s.run(10);
  const p0 = s.quad.pos.clone();
  let maxDrift = 0;
  s.run(15, () => (maxDrift = Math.max(maxDrift, Math.hypot(s.quad.pos.x - p0.x, s.quad.pos.z - p0.z))));
  console.log(`  loiter drift ${maxDrift.toFixed(2)} m, roll ${(s.fc.roll * 57.3).toFixed(1)} deg into wind`);
  assert.ok(maxDrift < 2.0);
});

test('LOITER forward stick flies forward and brakes', () => {
  const s = makeSim();
  s.fc.setMode('LOITER');
  s.fc.arm('test');
  s.rc.throttle = 1;
  s.run(3);
  s.rc.throttle = 0.5;
  s.rc.pitch = 1;
  s.run(5);
  const v = s.fc.groundSpeed;
  s.rc.pitch = 0;
  s.run(5);
  console.log(`  loiter speed ${v.toFixed(2)} m/s, after brake ${s.fc.groundSpeed.toFixed(2)} m/s, z ${s.quad.pos.z.toFixed(1)}`);
  assert.ok(v > 5 && v < 7);
  assert.ok(s.fc.groundSpeed < 0.3);
  assert.ok(s.quad.pos.z < -20, 'should travel north');
});

test('RTL climbs, returns, lands at home and disarms', () => {
  const s = makeSim({ wind: 4, gust: 0.3 });
  s.fc.setMode('LOITER');
  s.fc.arm('test');
  s.rc.throttle = 1;
  s.run(3);
  s.rc.throttle = 0.5;
  s.rc.pitch = 1;
  s.rc.roll = 0.5;
  s.run(8);
  s.rc.pitch = 0;
  s.rc.roll = 0;
  s.run(3);
  const far = s.fc.distHome;
  s.fc.setMode('RTL');
  let maxAlt = 0;
  s.run(90, () => (maxAlt = Math.max(maxAlt, s.fc.alt)));
  const d = Math.hypot(s.quad.pos.x, s.quad.pos.z);
  console.log(`  RTL from ${far.toFixed(1)} m, max alt ${maxAlt.toFixed(1)} m, landed ${d.toFixed(2)} m from home, armed=${s.fc.armed}`);
  assert.ok(maxAlt > 14);
  assert.ok(d < 1.5);
  assert.equal(s.fc.armed, false);
  assert.equal(s.quad.crashed, false);
});

test('LAND mode descends and disarms', () => {
  const s = makeSim();
  s.fc.setMode('ALT_HOLD');
  s.fc.arm('test');
  s.rc.throttle = 1;
  s.run(4);
  s.rc.throttle = 0.5;
  s.fc.setMode('LAND');
  s.run(25);
  assert.equal(s.fc.armed, false);
  assert.equal(s.quad.crashed, false);
});

test('ACRO holds attitude when sticks centred (no self-level)', () => {
  const s = makeSim();
  s.fc.arm('test');
  s.rc.throttle = 0.8;
  s.run(2);
  s.fc.setMode('ACRO');
  s.rc.throttle = 0.55;
  s.rc.roll = 0.3;
  s.run(0.25);
  s.rc.roll = 0;
  const r0 = s.fc.roll;
  s.run(0.5);
  console.log(`  acro roll after input ${(r0 * 57.3).toFixed(1)} deg, 0.5 s later ${(s.fc.roll * 57.3).toFixed(1)} deg`);
  assert.ok(Math.abs(r0) > 0.15);
  assert.ok(Math.abs(s.fc.roll - r0) < 0.1);
});

test('throttle cut in flight leads to a crash', () => {
  const s = makeSim();
  s.fc.arm('test');
  s.rc.throttle = 0.8;
  s.run(3);
  s.fc.emergencyStop();
  s.run(4);
  assert.equal(s.quad.crashed, true);
});

test('geofence breach triggers RTL', () => {
  const fence = { enabled: true, maxAlt: 20, radius: 25 };
  const s = makeSim({ fence });
  s.fc.setMode('LOITER');
  s.fc.arm('test');
  s.rc.throttle = 1;
  s.run(3);
  s.rc.throttle = 0.5;
  s.rc.pitch = 1;
  s.run(10);
  console.log(`  mode after breach: ${s.fc.mode}, dist ${s.fc.distHome.toFixed(1)} m`);
  assert.equal(s.fc.mode, 'RTL');
  assert.ok(s.fc.distHome < 32);
});

test('auto-disarm after landing with throttle low', () => {
  const s = makeSim();
  s.fc.arm('test');
  s.run(11);
  assert.equal(s.fc.armed, false);
});
