// Baselines: random policy vs the scripted Loiter pilot on each task, plus simulation speed.
// Run from the repository root: node examples/node/benchmark.mjs [episodes]
import { DroneEnv } from '../../src/agent/env.js';
import { gotoPolicy, randomPolicy } from '../../src/agent/policies.js';
import { mulberry32 } from '../../src/util/math.js';

const EPISODES = Number(process.argv[2] || 20);
const landPilot = (o) => {
  const a = gotoPolicy(o);
  return Math.hypot(o[0], o[2]) < 1 ? [-0.6, 0, a[2], a[3]] : a;
};
const tasks = [
  { name: 'hover', opts: { task: 'hover', maxSeconds: 30 }, pilot: gotoPolicy },
  { name: 'waypoints', opts: { task: 'waypoints', maxSeconds: 90 }, pilot: gotoPolicy },
  { name: 'waypoints (city)', opts: { task: 'waypoints', maxSeconds: 90, scene: 'city' }, pilot: gotoPolicy },
  { name: 'pattern (circle)', opts: { task: 'pattern', pattern: 'circle', maxSeconds: 120, scene: 'training' }, pilot: (o) => gotoPolicy(o, { maxSpeed: 4 }) },
  { name: 'land', opts: { task: 'land', maxSeconds: 60 }, pilot: landPilot },
];

async function evaluate(opts, policy) {
  const env = await DroneEnv.create({ control: 'sticks', flightMode: 'LOITER', ...opts });
  let ret = 0;
  let wins = 0;
  let crashes = 0;
  let steps = 0;
  const t0 = performance.now();
  for (let ep = 0; ep < EPISODES; ep++) {
    let { obs } = env.reset(1000 + ep);
    for (;;) {
      const r = env.step(policy(obs));
      obs = r.obs;
      ret += r.reward;
      steps++;
      if (r.terminated || r.truncated) {
        wins += r.info.success ? 1 : 0;
        crashes += r.info.crashed ? 1 : 0;
        break;
      }
    }
  }
  const sec = (performance.now() - t0) / 1000;
  env.close();
  return { ret: ret / EPISODES, success: wins / EPISODES, crash: crashes / EPISODES, sps: steps / sec };
}

console.log(`| Task | Random: return | Random: success | Scripted pilot: return | Scripted pilot: success | Steps/s |`);
console.log(`| --- | --- | --- | --- | --- | --- |`);
for (const t of tasks) {
  const rng = mulberry32(7);
  const rnd = await evaluate(t.opts, () => randomPolicy(rng));
  const pil = await evaluate(t.opts, t.pilot);
  const pct = (v) => `${Math.round(v * 100)}%`;
  console.log(`| ${t.name} | ${rnd.ret.toFixed(1)} | ${pct(rnd.success)} | ${pil.ret.toFixed(1)} | ${pct(pil.success)} | ${Math.round(pil.sps).toLocaleString('en-US')} |`);
}
console.log(`\n${EPISODES} episodes per cell, seeds 1000-${1000 + EPISODES - 1}, LOITER stick control, 50 Hz agent steps, 400 Hz physics, randomised wind and mass. Hover has no success condition (it runs to the time limit).`);
