# Agent API

DronoSim can be driven by programs as well as people. There are three entry points; all of them use the same physics, flight controller, wind, battery and scenes as the interactive simulator.

| Entry point | Runs in | Use it for |
| --- | --- | --- |
| [`DroneEnv`](#droneenv-nodejs) | Node.js, headless | Reinforcement learning, controller design, batch evaluation (tens of thousands of steps per second) |
| [`dronosim_gym`](#python-gymnasium) | Python (Gymnasium), via a Node subprocess | Standard RL libraries (Stable-Baselines3, CleanRL, RLlib) |
| [`window.DronoSim`](#browser-api-windowdronosim) | The browser | Vision-based agents (rendered frames), browser automation, LLM / computer-use agents, demos |

## DroneEnv (Node.js)

```js
import { DroneEnv } from './src/agent/env.js';

const env = await DroneEnv.create({ task: 'waypoints', control: 'sticks', flightMode: 'LOITER', scene: 'city' });
let { obs, info } = env.reset(42);
for (;;) {
  const { obs: next, reward, terminated, truncated, info } = env.step([0, 0, 0.5, 0]); // throttle, yaw, pitch, roll
  obs = next;
  if (terminated || truncated) break;
}
env.close();
```

`new DroneEnv(options)` works too when `scene` is `null`. Scenes load asynchronously, so use `await DroneEnv.create(...)` for them.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `task` | `'hover'` | `hover`, `waypoints`, `pattern`, `land` or `free` (see [Tasks](#tasks)) |
| `control` | `'sticks'` | `sticks`: the agent is the pilot and the PID flight controller flies the drone. `motors`: raw motor commands, no flight controller |
| `flightMode` | `'ALT_HOLD'` | With stick control: `STABILIZE`, `ALT_HOLD`, `LOITER` or `ACRO` |
| `scene` | `null` | `null` (open flat ground, fastest), `training`, `city`, `forest`, `farm` or `industrial` |
| `sceneQuality` | `'medium'` | Scene density (`low`, `medium`, `high`): more trees and traffic means more obstacles |
| `agentHz` | `50` | Agent decisions per simulated second |
| `physicsHz` | `400` | Physics and flight controller rate (`physicsHz / agentHz` substeps per `step`) |
| `maxSeconds` | `30` | Episode time limit (simulated seconds), then `truncated = true` |
| `start` | `'air'` | `air`: start hovering at `startAlt`. `ground`: start armed on the pad (stick control) |
| `startAlt` | `5` | Start / hover target height in metres |
| `wind` | `null` | `{ speed, dirDeg, gustiness, turbulence }`. `null`: random each episode when `randomize` is on, otherwise calm |
| `randomize` | `true` | Domain randomisation: `true`, `false` or `{ mass, thrust, wind, start }` (mass and thrust are fractional ranges, e.g. `0.1` = ±10%) |
| `obsNoise` | `0` | Standard deviation of Gaussian noise added to position, velocity, attitude and rate observations |
| `seed` | `0` | Initial seed (also pass a seed to `reset`) |
| `pattern` | `'circle'` | For `task: 'pattern'`: `circle`, `square` or `figure8` |
| `patternAlt` | `8` | Pattern flying height |
| `waypoints` | `3` | Waypoints per episode |
| `waypointRadius` | `1.5` | Distance that counts as reaching a waypoint (m) |
| `waypointArea` | `30` | Typical distance between waypoints (m) |
| `sensorRange` | `20` | Obstacle sensor range (m) |
| `crashPenalty` | `-10` | Reward added on a crash or leaving the area |
| `bounds` | `600` | Horizontal distance from home that ends the episode (m) |
| `batteryDrain` | `1` | Battery drain multiplier (`0` = unlimited) |

### Observation

A flat array of 25 numbers (`env.observationSpace.keys`). World frame: +x east, +y up, +z south. Heights are relative to home, which is at ground level 0.

| Index | Key | Meaning |
| --- | --- | --- |
| 0-2 | `target_dx`, `target_dy`, `target_dz` | Current target minus drone position (m) |
| 3-5 | `vel_x`, `vel_y`, `vel_z` | Velocity (m/s) |
| 6-9 | `quat_x`, `quat_y`, `quat_z`, `quat_w` | Attitude quaternion. Body frame: +x right, +y up, -z forward (nose) |
| 10-12 | `rate_pitch`, `rate_yaw`, `rate_roll` | Body angular rates (rad/s): pitch about +x (positive = nose rising), yaw about +y (positive = turning left), roll about +z (positive = rolling left) |
| 13 | `alt` | Height above home (m) |
| 14 | `agl` | Height above the ground directly below (m), differs from `alt` on terrain |
| 15 | `battery` | State of charge, 0-1 |
| 16-20 | `sensor_front`, `sensor_right`, `sensor_back`, `sensor_left`, `sensor_down` | Obstacle distance divided by `sensorRange` (1 = nothing within range). Heading-relative beams plus a downward rangefinder |
| 21-24 | `motor_1` ... `motor_4` | Motor outputs 0-1 (front-right, rear-left, front-left, rear-right) |

### Action

Four numbers in [-1, 1] (values outside are clipped, `NaN` becomes 0).

- **`sticks`** (Mode 2 pilot): `[throttle, yaw, pitch, roll]`.
  - Throttle -1 is the stick fully down and +1 fully up; 0 is mid-stick.
  - Yaw, pitch and roll are positive for right, forward and right.

  Their meaning follows the flight mode, exactly as for a human pilot:

  | Mode | Sticks command |
  | --- | --- |
  | `STABILIZE` | Lean angle (up to 35°), yaw rate, collective thrust (mid-stick ≈ hover) |
  | `ALT_HOLD` | Lean angle, yaw rate, climb rate (mid-stick holds height) |
  | `LOITER` | Ground velocity (up to 6 m/s), yaw rate, climb rate. Centred sticks hold position, even in wind |
  | `ACRO` | Body rates (up to 360°/s), collective thrust, no self-levelling |

- **`motors`**: `[m1, m2, m3, m4]`, each mapped to a motor command `(a + 1) / 2`. The motor order is front-right (CCW), rear-left (CCW), front-left (CW) and rear-right (CW). This is the classic low-level quadrotor RL setup: there is no flight controller, so the agent has to stabilise the airframe itself.

### Tasks

| Task | Start | Reward per step | Ends with success when |
| --- | --- | --- | --- |
| `hover` | Hovering near home at `startAlt` | `1 - min(dist/5, 1) - 0.1·min(speed/5, 1) - 0.05·min(rate/5, 1)` | Never (runs to the time limit) |
| `waypoints` | At home | Progress toward the waypoint (m) − 0.01, +10 per waypoint | All waypoints reached |
| `pattern` | At the pattern's first checkpoint | Progress − 0.05·cross-track error − 0.02·height error, +2 per checkpoint, +20 on completion | The full pattern loop is flown. `info.pattern_score` (0-100) and `info.pattern_rms` grade it |
| `land` | 6-12 m up, 4-14 m from the pad | Progress toward the pad − 0.01; on touchdown +20 (+5 if off the pad), −5 per metre off-centre, −5 per m/s of excess touchdown speed | Landed and still within 1.5 m of the pad centre |
| `free` | Hovering at home | 0 (write your own reward from `info`) | Never |

In every task a crash (hard impact, tip-over, collision with a building, tree, pole or wire, ditching in water) or leaving `bounds` ends the episode with `crashPenalty`.

### Info

`t`, `step`, `task`, `success`, `reason`, `crashed`, `crash_reason`, `distance`, `mean_distance`, `position` [x, alt, z], `target`, `speed`, `battery`, `wind_speed`, `nearest_obstacle` ({ name, distance, direction } or null). With stick control it also has `mode` and `armed`. Waypoints add `waypoint` and `waypoints`; pattern adds `checkpoint`, `checkpoints`, `pattern_rms` and `pattern_score`.

### Determinism

Every source of randomness (randomisation, wind turbulence and gusts, sensor noise, scene traffic) uses the environment's seeded generator. `reset(seed)` with the same seed and the same actions reproduces an episode exactly, including after other episodes in the same process. This is tested in `test/agent.test.mjs`, and Gymnasium's `check_env` passes.

### Performance

Measured on an Apple M4 Max, single core, Node 24, 50 Hz agent steps (8 physics substeps each):

| Setting | Agent steps per second |
| --- | --- |
| Open ground (`scene: null`) | 120,000-150,000 |
| Training ground (pattern) | ~70,000 |
| City (1,100 obstacles, moving traffic) | ~15,000 |

Run `npm run benchmark` to measure your machine. Use one environment per process (worker threads or the Python vector wrappers) to scale across cores.

### Baselines

`npm run benchmark` compares a uniform random policy with the scripted Loiter pilot in `src/agent/policies.js` (`gotoPolicy`). The pilot reads only the observation and commands a velocity toward the target. A learned agent should at least beat the scripted pilot on return or time.

| Task | Random: return | Random: success | Scripted pilot: return | Scripted pilot: success |
| --- | --- | --- | --- | --- |
| hover | 408.0 | 0% | 1450.4 | 0% (no success condition) |
| waypoints | -48.8 | 0% | 77.9 | 100% |
| waypoints (city) | -48.6 | 0% | 75.4 | 100% |
| pattern (circle) | -1777.2 | 0% | 57.0 | 100% |
| land | -40.8 | 0% | 26.4 | 100% |

These are 20 episodes per cell (seeds 1000-1019) with LOITER stick control and randomised wind and mass. There are no learned-agent baselines yet; contributions are welcome.

## Python (Gymnasium)

The Python package starts `node src/agent/server.mjs` and talks to it with JSON lines. You need Node.js 18+ and `npm install` in the repository root.

```bash
pip install -e python/
```

```python
import gymnasium as gym
import dronosim_gym  # registers the environments

env = gym.make("DronoSim-Waypoints-v0", flight_mode="LOITER", max_seconds=60)
obs, info = env.reset(seed=0)
obs, reward, terminated, truncated, info = env.step(env.action_space.sample())
env.close()
```

Keyword arguments are the [options](#options) above, written in snake_case (`flight_mode`, `max_seconds`, `obs_noise`, ...).

| Registered id | Settings |
| --- | --- |
| `DronoSim-Hover-v0` | `task="hover"` |
| `DronoSim-Waypoints-v0` | `task="waypoints"` |
| `DronoSim-Pattern-v0` | `task="pattern"`, `scene="training"` |
| `DronoSim-Land-v0` | `task="land"` |
| `DronoSim-HoverMotors-v0` | `task="hover"`, `control="motors"` |
| `DronoSim-CityWaypoints-v0` | `task="waypoints"`, `scene="city"` |
| `DronoSim-ForestWaypoints-v0` | `task="waypoints"`, `scene="forest"` |

The observation space is `Box(-inf, inf, (25,), float32)` and the action space is `Box(-1, 1, (4,), float32)`. Examples are in `examples/python/`.

Set `DRONOSIM_NODE` to choose the Node executable and `DRONOSIM_SERVER` to point at a different `server.mjs`.

### Server protocol

One JSON object per line on stdin, one reply per line on stdout:

```
{"cmd":"make","options":{"task":"hover"}}  -> {"ok":true,"obs_keys":[...],"action_keys":[...]}
{"cmd":"reset","seed":1}                   -> {"ok":true,"obs":[...],"info":{...}}
{"cmd":"step","action":[0,0,0,0]}          -> {"ok":true,"obs":[...],"reward":0.9,"terminated":false,"truncated":false,"info":{...}}
{"cmd":"close"}                            -> {"ok":true}
```

Errors reply `{"ok":false,"error":"..."}`. Any language that can spawn a process can use this.

## Browser API (`window.DronoSim`)

When the simulator page is open, `window.DronoSim` gives programmatic control. This includes rendered frames for vision models.

```js
const api = window.DronoSim;
api.advance(5);                 // fast-forward 5 s (GPS fix) without rendering
api.setMode('LOITER');
api.setSticks({ throttle: 0 }); // throttle must be low to arm
api.arm();
api.setSticks({ throttle: 0.8 });   // climb; throttle is 0..1 here
const s = api.state();          // position, attitude, speeds, battery, wind, sensors, home...
const jpeg = await api.frame({ quality: 0.8 }); // data URL of the next rendered frame
api.release();                  // hand control back to the keyboard / controller
```

| Method | Description |
| --- | --- |
| `state()` | Snapshot: `t`, `scene`, `mode`, `armed`, `landed`, `crashed`, `position` {x, y, z, north, east}, `velocity`, `attitude` {roll, pitch, heading} in degrees, `alt`, `agl`, `groundSpeed`, `verticalSpeed`, `battery`, `wind`, `sensors`, `home`, `gpsFix` |
| `setSticks({ throttle, yaw, pitch, roll })` | Override pilot sticks until `release()`. Throttle 0..1, others -1..1 |
| `release()` | Return control to the keyboard or controller |
| `arm()`, `disarm()` | Same safety checks as the pilot (disarm only on the ground) |
| `setMode(mode)` | `STABILIZE`, `ALT_HOLD`, `LOITER`, `ACRO`, `RTL`, `LAND`, `AUTO` |
| `reset()` | Drone back on the pad with a fresh battery (when disarmed) |
| `loadScene(id)` | Returns a promise. Ids are listed in `scenes` |
| `setView(id)` | `pilot`, `chase`, `fpv`, `overhead`, `orbit` |
| `setWeather(w)`, `setTimeOfDay(t)` | `clear`, `overcast`, `fog`, `rain` / `day`, `dusk`, `night` |
| `advance(seconds)` | Run the simulation forward without rendering |
| `pause(true/false)` | Pause or resume |
| `frame({ type, quality })` | Promise of the next rendered frame as a data URL |
| `on(event, fn)` | Simulator events: `frame`, `msg`, `armed`, `disarmed`, `mode`, `crash`, `scene` |

### URL parameters

| Parameter | Example | Effect |
| --- | --- | --- |
| `scene` | `?scene=forest` | Start in a scene |
| `time` | `&time=night` | `day`, `dusk`, `night` |
| `weather` | `&weather=fog` | `clear`, `overcast`, `fog`, `rain` |
| `quality` | `&quality=low` | `low`, `medium`, `high` |
| `view` | `&view=chase` | Initial camera |
| `autofly` | `&autofly=8` | Take off in Loiter and hover at 8 m once GPS is ready |
| `ff` | `&ff=10` | Fast-forward 10 s after loading |
| `ui` | `&ui=0` | Hide side panels and messages (clean frames) |

Example, a clean dusk city view for recording: `?scene=city&time=dusk&autofly=12&ff=14&view=chase&ui=0`.

## Limits of the simulation (read before sim-to-real)

The model is meant for training and for comparing agents, not as a certified digital twin of a specific aircraft.

- **Simplified aerodynamics:** rigid body, thrust per motor with first-order spool-up, linear and quadratic drag against air-relative velocity, a ground-effect approximation, and reaction-torque yaw. There is no blade-element model and no prop-wash interaction with walls.
- **Ideal state estimation:** the flight controller reads the true state. Add noise with `obsNoise`.
- **Sensors:** obstacle sensing is geometric ray casting against collision shapes, not a camera or lidar sensor model.
- **Scenes:** procedural, not photogrammetry, and collision shapes are boxes, cylinders and capsules.
- **No validation:** parameters describe a generic 450-class quadcopter and have not been fitted to flight logs.
