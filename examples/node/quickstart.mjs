// Minimal DroneEnv loop: fly to three waypoints with a scripted pilot.
// Run from the repository root: node examples/node/quickstart.mjs
import { DroneEnv } from '../../src/agent/env.js';
import { gotoPolicy } from '../../src/agent/policies.js';

const env = await DroneEnv.create({ task: 'waypoints', control: 'sticks', flightMode: 'LOITER', scene: 'city' });
let { obs, info } = env.reset(42);
let total = 0;
for (;;) {
  const step = env.step(gotoPolicy(obs));
  obs = step.obs;
  total += step.reward;
  if (step.terminated || step.truncated) {
    info = step.info;
    break;
  }
}
console.log(`return ${total.toFixed(1)}, success ${info.success} (${info.reason}) after ${info.t.toFixed(1)} s`);
