#!/usr/bin/env node
// JSON-lines bridge to DroneEnv over stdin/stdout, used by the Python package
// (python/dronosim_gym). One environment per process.
//   -> {"cmd":"make","options":{...}}        <- {"ok":true,"obs_keys":[...],"action_keys":[...]}
//   -> {"cmd":"reset","seed":1}              <- {"ok":true,"obs":[...],"info":{...}}
//   -> {"cmd":"step","action":[a0,a1,a2,a3]} <- {"ok":true,"obs":[...],"reward":r,"terminated":b,"truncated":b,"info":{...}}
//   -> {"cmd":"close"}
import { createInterface } from 'node:readline';
import { DroneEnv } from './env.js';

let env = null;
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    send({ ok: false, error: 'invalid JSON' });
    return;
  }
  try {
    switch (req.cmd) {
      case 'make':
        env?.close();
        env = await DroneEnv.create(req.options || {});
        send({ ok: true, obs_keys: env.observationSpace.keys, action_keys: env.actionSpace.keys });
        break;
      case 'reset': {
        const r = env.reset(req.seed);
        send({ ok: true, obs: r.obs, info: r.info });
        break;
      }
      case 'step': {
        const r = env.step(req.action);
        send({ ok: true, obs: r.obs, reward: r.reward, terminated: r.terminated, truncated: r.truncated, info: r.info });
        break;
      }
      case 'close':
        env?.close();
        send({ ok: true });
        process.exit(0);
        break;
      default:
        send({ ok: false, error: `unknown cmd ${req.cmd}` });
    }
  } catch (e) {
    send({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});
