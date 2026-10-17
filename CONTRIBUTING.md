# Contributing to DronoSim

Thanks for helping. DronoSim is used both for drone pilot training and as a testbed for AI agents, so changes should keep the flight behaviour realistic and the agent API stable and deterministic.

## Development setup

```bash
git clone https://github.com/nishantsirohi23/dronosim.git
cd dronosim
npm install
npm start          # builds and serves the full simulator at http://localhost:5173
npm test           # headless physics, flight controller, missions, sensors and agent API tests
npm run dev        # rebuild on change (run `node serve.mjs dist-pro` alongside)
```

Python wrapper:

```bash
pip install -e python/ pytest
pytest python/tests
```

## Where things live

| Area | Files |
| --- | --- |
| Physics | `src/physics/` (rigid body, wind, battery, PID) |
| Flight controller and missions | `src/fc/` |
| Scenes | `src/world/scenes/` (one module per scene; shared builders in `common.js`) |
| Sky, weather, lighting | `src/world/atmosphere.js` |
| Sensors and payload camera | `src/sensors/` |
| Agent API | `src/agent/` (`env.js`, `server.mjs`, `browserApi.js`), `python/dronosim_gym/` |
| UI | `src/ui/`, `index.html`, `style.css` |

## Adding a scene

1. Create `src/world/scenes/<id>.js` exporting `build(ctx)`. The scene interface is documented at the top of `src/world/scenes/common.js`. Two rules matter most:
   - `groundHeight(x, z)` must be 0 near the origin (the home pad).
   - Obstacles must use absolute top heights.
2. Register it in `src/world/scenes/index.js` and add its id to `SCENE_ACCESS` in `src/config.js` and `SCENE_IDS` in `src/agent/env.js`.
3. Check it on its own with the scene viewer: run `node tools/build-viewer.mjs && node serve.mjs dist-viewer 5175`, then open `http://localhost:5175/?scene=<id>`. Press B to see collision shapes.
4. Keep it light enough for an office PC: use instancing for repeated objects, and aim for under 300 draw calls at `high` quality.
5. Add it to a headless test in `test/agent.test.mjs` so agents can use it.

## Pull requests

- Run `npm test` and `npm run build` before opening a PR. CI runs both, plus the Python tests.
- Flight-model or controller changes: describe the change and include before/after numbers from the tests or `npm run benchmark`.
- Agent API changes must keep seeded episodes reproducible. The repeatability tests in `test/agent.test.mjs` cover this.
- Keep code style consistent with the surrounding files: ES modules, no build-time frameworks, comments that explain why.

## Reporting issues

Please include:
- browser and OS, GPU, and the graphics quality setting;
- the scene and the steps to reproduce;
- for flight-behaviour issues, an exported flight log (Trail & Assessment panel, **Export flight log**).
