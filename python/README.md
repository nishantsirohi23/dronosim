# dronosim-gym

Gymnasium environments for [DronoSim](../README.md). The simulation runs in Node.js, so you
need Node 18+ and `npm install` in the repository root.

```bash
pip install -e python/
```

```python
import gymnasium as gym
import dronosim_gym

env = gym.make("DronoSim-Waypoints-v0", flight_mode="LOITER")
obs, info = env.reset(seed=0)
obs, reward, terminated, truncated, info = env.step(env.action_space.sample())
```

See [docs/AGENT_API.md](../docs/AGENT_API.md) for tasks, observations, actions and rewards.
