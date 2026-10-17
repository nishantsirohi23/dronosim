"""Random agent on every registered DronoSim task: a lower bound for comparison."""

import gymnasium as gym
import numpy as np

import dronosim_gym  # noqa: F401  (registers the environments)

for env_id in ["DronoSim-Hover-v0", "DronoSim-Waypoints-v0", "DronoSim-Land-v0"]:
    env = gym.make(env_id, flight_mode="LOITER", max_seconds=20)
    returns, successes = [], 0
    for episode in range(5):
        obs, info = env.reset(seed=episode)
        total, done = 0.0, False
        while not done:
            obs, reward, terminated, truncated, info = env.step(env.action_space.sample())
            total += reward
            done = terminated or truncated
        returns.append(total)
        successes += int(info["success"])
    print(f"{env_id:28s} mean return {np.mean(returns):8.1f}  success {successes}/5")
    env.close()
