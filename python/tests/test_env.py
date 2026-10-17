"""Checks for the Gymnasium wrapper. Run with `pytest python/tests` or `python python/tests/test_env.py`."""

import gymnasium as gym
import numpy as np
from gymnasium.utils.env_checker import check_env

import dronosim_gym
from dronosim_gym import DronoSimEnv


def test_gymnasium_env_checker():
    env = DronoSimEnv(task="waypoints", flight_mode="LOITER", max_seconds=5)
    try:
        check_env(env, skip_render_check=True)
    finally:
        env.close()


def test_registered_envs_and_seeding():
    env = gym.make("DronoSim-Hover-v0", flight_mode="LOITER", max_seconds=2)
    try:
        a, _ = env.reset(seed=11)
        b, _ = env.reset(seed=11)
        assert np.array_equal(a, b)
        assert a.shape == env.observation_space.shape
        obs, reward, terminated, truncated, info = env.step(np.zeros(4, dtype=np.float32))
        assert np.isfinite(reward) and "success" in info
    finally:
        env.close()


def test_scene_env_loads():
    env = gym.make("DronoSim-CityWaypoints-v0", flight_mode="LOITER", max_seconds=1)
    try:
        obs, info = env.reset(seed=0)
        assert info["task"] == "waypoints"
    finally:
        env.close()


if __name__ == "__main__":
    test_gymnasium_env_checker()
    test_registered_envs_and_seeding()
    test_scene_env_loads()
    print("python tests passed", dronosim_gym.__version__)
