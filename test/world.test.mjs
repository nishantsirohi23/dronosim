// Scene-engine logic that runs without a browser: obstacle sensors, braking, the obstacle
// grid, wire collisions and terrain-aware mission hazard checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { ProximitySensors } from '../src/sensors/proximity.js';
import { ObstacleIndex } from '../src/world/obstacleIndex.js';
import { Quadcopter } from '../src/physics/quadcopter.js';
import { DRONE_X4 } from '../src/config.js';
import { missionHazards } from '../src/fc/mission.js';

const flat = () => 0;

test('front sensor measures distance to a building ahead (heading north)', () => {
  const s = new ProximitySensors();
  const wall = { type: 'box', name: 'building', minX: -5, maxX: 5, minZ: -20, maxZ: -12, h: 20 };
  s.update(new Vector3(0, 5, 0), 0, [wall], flat, 0.15);
  assert.ok(Math.abs(s.dist.front - 12) < 0.01, `front ${s.dist.front}`);
  assert.equal(s.dist.back, Infinity);
  assert.ok(Math.abs(s.dist.down - 4.85) < 1e-6);
  assert.equal(s.nearest.name, 'building');
});

test('sensors ignore obstacles the drone is flying over', () => {
  const s = new ProximitySensors();
  const low = { type: 'box', name: 'shed', minX: -5, maxX: 5, minZ: -20, maxZ: -12, h: 3 };
  s.update(new Vector3(0, 5, 0), 0, [low], flat, 0.15);
  assert.equal(s.dist.front, Infinity);
});

test('right sensor sees a pole when heading east', () => {
  const s = new ProximitySensors();
  // Heading east (yaw = -90 deg): right is south (+Z).
  const pole = { type: 'cyl', name: 'pole', x: 0, z: 8, r: 0.3, h: 10 };
  s.update(new Vector3(0, 4, 0), -Math.PI / 2, [pole], flat, 0.15);
  assert.ok(Math.abs(s.dist.right - 7.7) < 0.05, `right ${s.dist.right}`);
});

test('a power line wire is detected by the forward beam', () => {
  const s = new ProximitySensors();
  const wire = { type: 'seg', name: 'power line', ax: -30, ay: 8, az: -10, bx: 30, by: 8, bz: -10, r: 0.06 };
  s.update(new Vector3(0, 8, 0), 0, [wire], flat, 0.15);
  assert.ok(s.dist.front > 9 && s.dist.front < 10.5, `front ${s.dist.front}`);
});

test('rising terrain ahead is reported', () => {
  const s = new ProximitySensors();
  const hill = (x, z) => (z < -10 ? 20 : 0);
  s.update(new Vector3(0, 5, 0), 0, [], hill, 0.15);
  assert.ok(s.dist.front >= 10 && s.dist.front <= 12, `front ${s.dist.front}`);
  assert.equal(s.nearest.name, 'terrain');
});

test('braking scales forward stick near an obstacle and leaves other axes alone', () => {
  const s = new ProximitySensors();
  s.dist = { front: 4, back: Infinity, left: Infinity, right: Infinity, down: 5 };
  const rc = { pitch: 1, roll: 0.5, yaw: 0, throttle: 0.5 };
  assert.equal(s.brake(rc), true);
  assert.ok(rc.pitch < 0.2);
  assert.equal(rc.roll, 0.5);
  const back = { pitch: -1, roll: 0, yaw: 0, throttle: 0.5 };
  assert.equal(s.brake(back), false);
  assert.equal(back.pitch, -1);
});

test('obstacle grid returns nearby static obstacles and every dynamic one', () => {
  const obs = [
    { type: 'cyl', name: 'near', x: 5, z: 5, r: 1, h: 5 },
    { type: 'cyl', name: 'far', x: 400, z: 400, r: 1, h: 5 },
    { type: 'box', name: 'car', dynamic: true, minX: 300, maxX: 302, minZ: 300, maxZ: 304, h: 1.5 },
    { type: 'seg', name: 'wire', ax: -100, ay: 9, az: 0, bx: 100, by: 9, bz: 0, r: 0.06 },
  ];
  const idx = new ObstacleIndex(obs);
  const names = idx.near(0, 0, 30).map((o) => o.name).sort();
  assert.deepEqual(names, ['car', 'near', 'wire']);
});

test('flying into a power line is a crash', () => {
  const q = new Quadcopter(DRONE_X4);
  q.reset(0, 0, 0);
  q.pos.set(0, 8, -9.8);
  q.contact = false;
  const env = { wind: new Vector3(), groundHeight: 0, obstacles: [{ type: 'seg', name: 'power line', ax: -30, ay: 8, az: -10, bx: 30, by: 8, bz: -10, r: 0.06 }] };
  q._obstacles(env);
  assert.equal(q.crashed, true);
  assert.match(q.crashReason, /power line/);
});

test('mission hazards include wires and terrain', () => {
  const path = { points: [{ x: 0, z: 0, alt: 10, item: 1 }, { x: 0, z: -100, alt: 10, item: 2 }] };
  const wire = { type: 'seg', name: 'power line', ax: -30, ay: 11, az: -50, bx: 30, by: 11, bz: -50, r: 0.06 };
  const hz = missionHazards(path, [wire]);
  assert.ok(hz.some((h) => h.name === 'power line'));
  const hill = (x, z) => (z < -70 ? 15 : 0);
  const hz2 = missionHazards(path, [], 3, hill);
  assert.ok(hz2.some((h) => h.name === 'terrain'));
  assert.equal(missionHazards(path, [], 3, () => 0).length, 0);
});
