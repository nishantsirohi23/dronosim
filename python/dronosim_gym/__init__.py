"""DronoSim Gymnasium environments.

    import gymnasium as gym
    import dronosim_gym  # registers the environments

    env = gym.make("DronoSim-Waypoints-v0", flight_mode="LOITER")
"""

from gymnasium.envs.registration import register

from .env import DronoSimEnv

__all__ = ["DronoSimEnv"]
__version__ = "0.1.0"

_ENVS = {
    "DronoSim-Hover-v0": {"task": "hover"},
    "DronoSim-Waypoints-v0": {"task": "waypoints"},
    "DronoSim-Pattern-v0": {"task": "pattern", "scene": "training"},
    "DronoSim-Land-v0": {"task": "land"},
    "DronoSim-HoverMotors-v0": {"task": "hover", "control": "motors"},
    "DronoSim-CityWaypoints-v0": {"task": "waypoints", "scene": "city"},
    "DronoSim-ForestWaypoints-v0": {"task": "waypoints", "scene": "forest"},
}

for _id, _kwargs in _ENVS.items():
    register(id=_id, entry_point="dronosim_gym.env:DronoSimEnv", kwargs=_kwargs)
