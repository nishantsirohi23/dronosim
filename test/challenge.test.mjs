// Flies the Basic Proficiency Challenge with a scripted pilot (LOITER velocity commands
// along each reference pattern) and checks stage progression and scoring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { Quadcopter } from '../src/physics/quadcopter.js';
import { FlightController } from '../src/fc/flightController.js';
import { WindModel } from '../src/physics/wind.js';
import { DRONE_X4, FC_PARAMS, DEFAULT_GAINS } from '../src/config.js';
import { Challenge } from '../src/assess/challenge.js';
import { PATTERNS, distanceToPolyline } from '../src/world/patterns.js';
import { PatternTracker } from '../src/assess/analysis.js';

const DT = 1 / 400;

function setup() {
  const quad = new Quadcopter(DRONE_X4);
  quad.reset(0, 0, 0);
  const fc = new FlightController(quad, FC_PARAMS, DEFAULT_GAINS, () => {});
  const wind = new WindModel();
  wind.configure({ speed: 2, dirDeg: 270, gustiness: 0.2, turbulence: true });
  const env = { wind: new Vector3(), groundHeight: 0, obstacles: [], torqueNoise: wind.torque };
  const rc = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
  const ch = new Challenge();
  let t = 0;
  let sampleT = 0;
  const step = () => {
    wind.update(DT);
    wind.sample(quad.pos, env.wind);
    fc.update(DT, rc, { gpsFix: true, battPct: 90, rcValid: true, fence: { enabled: false } });
    quad.step(DT, env);
    t += DT;
    sampleT += DT;
    if (sampleT >= 0.05 && fc.armed && !fc.landed) {
      sampleT = 0;
      ch.sample({ x: quad.pos.x, y: quad.pos.y, z: quad.pos.z, alt: fc.alt, speed: quad.vel.length(), mode: fc.mode, t });
    }
    ch.update(DT, fc, quad);
  };
  // Velocity command (world) -> LOITER sticks (heading stays north).
  const fly = (vx, vz) => {
    rc.pitch = Math.max(-1, Math.min(1, -vz / 6));
    rc.roll = Math.max(-1, Math.min(1, vx / 6));
  };
  return { quad, fc, rc, ch, step, fly, get t() { return t; } };
}

function followPattern(s, pattern, laps = 1.08, speed = 3.5) {
  const pts = pattern.points;
  const n = pts.length;
  // Start at the closest point, then chase a look-ahead target along the polyline.
  let idx = 0;
  let best = Infinity;
  pts.forEach(([x, z], i) => {
    const d = Math.hypot(x - s.quad.pos.x, z - s.quad.pos.z);
    if (d < best) {
      best = d;
      idx = i;
    }
  });
  const total = Math.round(n * laps);
  let advanced = 0;
  let guard = 0;
  while (advanced < total && guard++ < 400 * 120) {
    const [tx, tz] = pts[(idx + 3) % n];
    const dx = tx - s.quad.pos.x;
    const dz = tz - s.quad.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    s.fly((dx / d) * speed, (dz / d) * speed);
    s.step();
    const [cx, cz] = pts[(idx + 1) % n];
    if (Math.hypot(cx - s.quad.pos.x, cz - s.quad.pos.z) < 1.5) {
      idx = (idx + 1) % n;
      advanced++;
    }
  }
}

function goTo(s, x, z, speed = 4, tol = 1) {
  for (let i = 0; i < 400 * 60; i++) {
    const dx = x - s.quad.pos.x;
    const dz = z - s.quad.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < tol) break;
    const v = Math.min(speed, d * 0.8);
    s.fly((dx / d) * v, (dz / d) * v);
    s.step();
  }
  s.fly(0, 0);
}

function run(s, seconds) {
  for (let i = 0; i < seconds / DT; i++) s.step();
}

test('pattern tracker scores a perfectly flown circle highly', () => {
  const tr = new PatternTracker(PATTERNS.circle);
  PATTERNS.circle.points.forEach(([x, z], i) => tr.add({ x, z, alt: 8, speed: 4, t: i * 0.2 }));
  const st = tr.stats();
  assert.ok(st.rms < 0.05);
  assert.ok(st.coverage > 0.95);
  assert.ok(st.score > 95, `score ${st.score}`);
});

test('distanceToPolyline is correct on the square', () => {
  const r = distanceToPolyline(PATTERNS.square.points, 0, -40);
  assert.ok(Math.abs(r.dist - 10) < 1e-6);
});

test('scripted pilot completes the Basic Proficiency Challenge', () => {
  const s = setup();
  s.ch.start(false);
  run(s, 0.5);
  s.fc.setMode('LOITER');
  s.fc.arm('test');
  run(s, 0.2);
  assert.equal(s.ch.index, 1, 'arm stage complete');

  // Hover at 5 m over the pad.
  s.rc.throttle = 0.9;
  for (let i = 0; i < 400 * 10 && s.fc.alt < 4.6; i++) s.step();
  s.rc.throttle = 0.5;
  run(s, 13);
  assert.equal(s.ch.index, 2, `hover stage complete (alt ${s.fc.alt.toFixed(2)})`);

  // Climb to 8 m for the patterns.
  s.rc.throttle = 0.8;
  for (let i = 0; i < 400 * 10 && s.fc.alt < 7.8; i++) s.step();
  s.rc.throttle = 0.5;

  for (const id of ['square', 'circle', 'figure8']) {
    const p = PATTERNS[id];
    const [sx, sz] = p.points[0];
    goTo(s, sx, sz);
    followPattern(s, p);
    run(s, 0.5);
    const r = s.ch.results.find((x) => x.id === id);
    console.log(`  ${id}: status ${r.status}, score ${r.score}, ${r.notes.join('; ')}`);
    assert.equal(r.status, 'done', `${id} complete`);
  }

  // Return and land on the pad.
  goTo(s, 0, 0, 4, 0.3);
  run(s, 3);
  s.rc.throttle = 0.15;
  for (let i = 0; i < 400 * 30 && s.fc.armed; i++) {
    if (s.fc.landed) s.rc.throttle = 0;
    s.step();
  }
  run(s, 12);
  console.log(`  results: ${s.ch.results.map((r) => `${r.id}=${r.score}`).join(', ')}; total ${s.ch.totalScore}, passed ${s.ch.passed} ${s.ch.failReason}`);
  assert.equal(s.ch.finished, true);
  assert.equal(s.ch.passed, true);
});
