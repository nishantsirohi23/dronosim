"""Gymnasium environment backed by the DronoSim JavaScript simulator.

The simulation runs in a Node.js subprocess (src/agent/server.mjs) and talks JSON over
stdin/stdout, so the physics, flight controller and scenes are exactly the ones used by the
browser simulator. Requires Node.js 18+ and `npm install` in the repository root.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium import spaces

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_SERVER = _REPO_ROOT / "src" / "agent" / "server.mjs"


class DronoSimEnv(gym.Env):
    """Quadcopter environment with DronoSim's PID flight controller, wind, battery and scenes.

    Args:
        task: "hover", "waypoints", "pattern", "land" or "free".
        control: "sticks" (act as a pilot through the flight controller) or "motors"
            (raw normalised motor commands).
        scene: None (open ground, fastest), "training", "city", "forest", "farm" or "industrial".
        node_path: Node.js executable (default: "node" or $DRONOSIM_NODE).
        server_path: path to server.mjs (default: this repository or $DRONOSIM_SERVER).
        **options: any other DroneEnv option, e.g. flight_mode="LOITER", max_seconds=60,
            agent_hz=50, wind={"speed": 5}, randomize=False, obs_noise=0.02.
            snake_case names are converted to the camelCase names used in docs/AGENT_API.md.

    Observation: float32 vector, layout in `self.obs_keys` (see docs/AGENT_API.md).
    Action: 4 floats in [-1, 1]. Sticks: throttle, yaw, pitch, roll (throttle -1 = idle,
    +1 = full). Motors: front-right, rear-left, front-left, rear-right.
    """

    metadata = {"render_modes": []}

    def __init__(
        self,
        task: str = "hover",
        control: str = "sticks",
        scene: str | None = None,
        node_path: str | None = None,
        server_path: str | os.PathLike | None = None,
        **options: Any,
    ) -> None:
        super().__init__()
        node = node_path or os.environ.get("DRONOSIM_NODE", "node")
        server = Path(server_path or os.environ.get("DRONOSIM_SERVER", _DEFAULT_SERVER))
        if not server.exists():
            raise FileNotFoundError(f"DronoSim server not found at {server}; clone the repository and run npm install")
        self._proc = subprocess.Popen(
            [node, str(server)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        opts = {"task": task, "control": control, "scene": scene}
        opts.update({_camel(k): v for k, v in options.items()})
        reply = self._call({"cmd": "make", "options": opts})
        self.obs_keys: list[str] = reply["obs_keys"]
        self.action_keys: list[str] = reply["action_keys"]
        self.observation_space = spaces.Box(-np.inf, np.inf, shape=(len(self.obs_keys),), dtype=np.float32)
        self.action_space = spaces.Box(-1.0, 1.0, shape=(4,), dtype=np.float32)

    def _call(self, msg: dict) -> dict:
        if self._proc.poll() is not None:
            raise RuntimeError(f"DronoSim server is not running: {self._proc.stderr.read()}")
        self._proc.stdin.write(json.dumps(msg) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            raise RuntimeError(f"DronoSim server exited: {self._proc.stderr.read()}")
        reply = json.loads(line)
        if not reply.get("ok"):
            raise RuntimeError(f"DronoSim error: {reply.get('error')}")
        return reply

    def reset(self, *, seed: int | None = None, options: dict | None = None):
        super().reset(seed=seed)
        # Each episode gets a seed drawn from the Gymnasium RNG, so a seeded first reset makes
        # the whole run reproducible.
        episode_seed = int(self.np_random.integers(0, 2**31 - 1))
        reply = self._call({"cmd": "reset", "seed": episode_seed})
        return np.asarray(reply["obs"], dtype=np.float32), reply["info"]

    def step(self, action):
        a = np.clip(np.asarray(action, dtype=np.float64).reshape(4), -1.0, 1.0).tolist()
        reply = self._call({"cmd": "step", "action": a})
        obs = np.asarray(reply["obs"], dtype=np.float32)
        return obs, float(reply["reward"]), bool(reply["terminated"]), bool(reply["truncated"]), reply["info"]

    def close(self) -> None:
        proc = getattr(self, "_proc", None)
        if proc and proc.poll() is None:
            try:
                self._call({"cmd": "close"})
            except Exception:
                pass
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
        super().close()


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)
