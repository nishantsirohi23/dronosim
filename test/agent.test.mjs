// Agent API (DroneEnv): spaces, determinism, tasks, control modes and headless scenes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DroneEnv, OBS_KEYS } from '../src/agent/env.js';
import { gotoPolicy } from '../src/agent/policies.js';

function rollout(env, policy, seed) {
  let { obs } = env.reset(seed);
  let total = 0;
  let last;
  const trace = [];
  for (;;) {
    last = env.step(policy(obs));
    obs = last.obs;
    total += last.reward;
    trace.push(obs[0]);
    if (last.terminated || last.truncated) break;
  }
  return { total, last, trace };
}

test('spaces and observation layout', () => {
  const env = new DroneEnv();
  assert.equal(env.observationSpace.shape[0], OBS_KEYS.length);
  assert.deepEqual(env.actionSpace.keys, ['throttle', 'yaw', 'pitch', 'roll']);
  const { obs, info } = env.reset(0);
  assert.equal(obs.length, OBS_KEYS.length);
  assert.ok(obs.every(Number.isFinite));
  assert.equal(info.crashed, false);
  assert.equal(new DroneEnv({ control: 'motors' }).actionSpace.keys[0], 'motor_1');
});

test('invalid options are rejected', () => {
  assert.throws(() => new DroneEnv({ task: 'nope' }), /Unknown task/);
  assert.throws(() => new DroneEnv({ control: 'nope' }), /Unknown control/);
  assert.throws(() => new DroneEnv({ flightMode: 'RTL' }), /pilot mode/);
  assert.throws(() => new DroneEnv({ scene: 'moon' }), /Unknown scene/);
});

test('same seed gives an identical episode; different seeds differ', () => {
  const opts = { task: 'waypoints', flightMode: 'LOITER', maxSeconds: 10 };
  const a = rollout(new DroneEnv(opts), (o) => gotoPolicy(o), 7);
  const b = rollout(new DroneEnv(opts), (o) => gotoPolicy(o), 7);
  const c = rollout(new DroneEnv(opts), (o) => gotoPolicy(o), 8);
  assert.deepEqual(a.trace, b.trace);
  assert.equal(a.total, b.total);
  assert.notDeepEqual(a.trace, c.trace);
});

test('resetting the same env with the same seed repeats the episode exactly', async () => {
  const env = await DroneEnv.create({ task: 'waypoints', flightMode: 'LOITER', maxSeconds: 12, scene: 'city' });
  const a = rollout(env, (o) => gotoPolicy(o), 5);
  rollout(env, (o) => gotoPolicy(o), 9);
  const b = rollout(env, (o) => gotoPolicy(o), 5);
  assert.deepEqual(a.trace, b.trace);
  // Traffic (moving obstacles) restarts from the same place each episode.
  const cars = () => env.index.all.filter((o) => o.dynamic).map((o) => [o.minX, o.minZ]);
  env.reset(5);
  const c0 = cars();
  for (let i = 0; i < 100; i++) env.step([0, 0, 0, 0]);
  env.reset(5);
  assert.deepEqual(cars(), c0);
});

test('step after the episode ends requires reset', () => {
  const env = new DroneEnv({ maxSeconds: 0.1 });
  env.reset(1);
  let r;
  do r = env.step([0, 0, 0, 0]);
  while (!r.truncated && !r.terminated);
  assert.throws(() => env.step([0, 0, 0, 0]), /reset/);
});

test('ALT_HOLD with centred sticks earns near-maximal hover reward', () => {
  const env = new DroneEnv({ task: 'hover', flightMode: 'ALT_HOLD', maxSeconds: 10, randomize: false });
  const { total, last } = rollout(env, () => [0, 0, 0, 0], 3);
  assert.ok(last.truncated && !last.terminated);
  assert.ok(total / last.info.step > 0.85, `mean reward ${total / last.info.step}`);
});

test('scripted Loiter pilot completes waypoints, pattern and landing', async () => {
  const wp = rollout(new DroneEnv({ task: 'waypoints', flightMode: 'LOITER', maxSeconds: 90 }), (o) => gotoPolicy(o), 11);
  assert.equal(wp.last.info.success, true, wp.last.info.reason);
  const pat = await DroneEnv.create({ task: 'pattern', pattern: 'square', flightMode: 'LOITER', maxSeconds: 120, scene: 'training' });
  const p = rollout(pat, (o) => gotoPolicy(o, { maxSpeed: 4 }), 2);
  assert.equal(p.last.info.success, true, p.last.info.reason);
  assert.ok(p.last.info.pattern_score > 60, `score ${p.last.info.pattern_score}`);
  const land = rollout(new DroneEnv({ task: 'land', flightMode: 'LOITER', maxSeconds: 60 }), (o) => {
    const a = gotoPolicy(o);
    return Math.hypot(o[0], o[2]) < 1 ? [-0.6, 0, a[2], a[3]] : a;
  }, 5);
  assert.equal(land.last.info.success, true, land.last.info.reason);
});

test('raw motor control: zero thrust falls and crashes', () => {
  const env = new DroneEnv({ control: 'motors', task: 'hover', startAlt: 20, randomize: false, maxSeconds: 10 });
  const { last } = rollout(env, () => [-1, -1, -1, -1], 1);
  assert.equal(last.terminated, true);
  assert.equal(last.info.crashed, true);
  assert.ok(last.reward < -5);
});

test('raw motor control: equal hover thrust keeps it airborne briefly', () => {
  const env = new DroneEnv({ control: 'motors', task: 'hover', randomize: false, maxSeconds: 1 });
  const { obs } = env.reset(1);
  const hover = obs[21] * 2 - 1;
  const { last } = rollout(env, () => [hover, hover, hover, hover], 1);
  assert.equal(last.info.crashed, false);
  assert.ok(Math.abs(last.info.position[1] - 5) < 1.5, `alt ${last.info.position[1]}`);
});

test('headless city scene: obstacles are sensed and collisions end the episode', async () => {
  const env = await DroneEnv.create({ scene: 'city', task: 'free', flightMode: 'STABILIZE', start: 'air', startAlt: 6, randomize: false, maxSeconds: 40 });
  assert.ok(env.index.all.length > 200);
  // Full forward stick in Stabilize (no obstacle braking): it must hit something or leave the area.
  const { last } = rollout(env, () => [0.1, 0, 1, 0], 1);
  assert.equal(last.terminated, true);
  assert.match(last.info.reason, /crash|out of bounds/);
});

test('headless forest scene: terrain height is under the drone', async () => {
  const env = await DroneEnv.create({ scene: 'forest', task: 'hover', flightMode: 'LOITER', randomize: false, maxSeconds: 2 });
  const { obs } = env.reset(1);
  assert.ok(Math.abs(obs[13] - obs[14]) < 0.5, 'agl equals alt at the flat clearing');
  assert.ok(env.groundHeight(0, -100) !== 0 || env.groundHeight(120, -60) !== 0);
});
