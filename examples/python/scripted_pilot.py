"""Scripted pilot in Loiter mode: velocity commands toward the target from the observation.

A simple non-learned baseline: a trained agent should beat it on return or flight time.
"""

import math

import gymnasium as gym

import dronosim_gym  # noqa: F401


def yaw_from_quat(x, y, z, w):
    # three.js 'YXZ' Euler yaw from a quaternion
    return math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y))


def pilot(obs, max_speed=5.0):
    dx, dy, dz = obs[0], obs[1], obs[2]
    yaw = yaw_from_quat(*obs[6:10])
    d = math.hypot(dx, dz)
    v = min(max_speed, d * 0.8)
    vx, vz = (dx / d * v, dz / d * v) if d > 1e-6 else (0.0, 0.0)
    fwd = vx * -math.sin(yaw) + vz * -math.cos(yaw)
    right = vx * math.cos(yaw) + vz * -math.sin(yaw)
    climb = max(-1.5, min(2.5, dy * 0.8))
    thr = 0.5
    if climb > 0.05:
        thr = 0.6 + climb / 2.5 * 0.4
    elif climb < -0.05:
        thr = 0.4 - (-climb) / 1.5 * 0.4
    clip = lambda u: max(-1.0, min(1.0, u))  # noqa: E731
    return [thr * 2 - 1, 0.0, clip(fwd / 6), clip(right / 6)]


env = gym.make("DronoSim-Waypoints-v0", flight_mode="LOITER", max_seconds=90)
for episode in range(5):
    obs, info = env.reset(seed=episode)
    total, done = 0.0, False
    while not done:
        obs, reward, terminated, truncated, info = env.step(pilot(obs))
        total += reward
        done = terminated or truncated
    print(f"episode {episode}: return {total:7.1f}  success {info['success']}  {info['reason']}  t={info['t']:.1f}s")
env.close()
