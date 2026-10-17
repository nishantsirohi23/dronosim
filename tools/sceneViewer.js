// Standalone scene viewer for checking scene modules: node tools/build-viewer.mjs, then open
// http://localhost:5175/?scene=city (served by: node serve.mjs dist-viewer 5175).
// Keys: N day/night, B obstacle wireframes, 1-5 scenes.
import { ACESFilmicToneMapping, Box3Helper, Box3, CylinderGeometry, Group, Line, BufferGeometry, LineBasicMaterial, Mesh, MeshBasicMaterial, PCFSoftShadowMap, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PerspectiveCamera } from 'three';
import { Atmosphere, WEATHER } from '../src/world/atmosphere.js';
import { PostFX } from '../src/fx/post.js';
import { applySway, swayUniforms } from '../src/fx/sway.js';
import { SCENES } from '../src/world/scenes/index.js';

const params = new URLSearchParams(location.search);
const id = params.get('scene') || 'training';
const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new Scene();
const env = new Atmosphere(scene, renderer);
const post = new PostFX(renderer);
let wxIdx = Math.max(0, WEATHER.indexOf(params.get('wx') || 'clear'));
env.setWeather(WEATHER[wxIdx], true);
const camera = new PerspectiveCamera(55, 1, 0.1, 4000);
const controls = new OrbitControls(camera, renderer.domElement);
const info = document.getElementById('info');
let night = params.get('night') === '1';
env.setTimeOfDay(night ? 'night' : 'day', true);
let inst = null;
let obsGroup = null;
const t0 = performance.now();

function obstacleWire(obstacles) {
  const g = new Group();
  const mat = new LineBasicMaterial({ color: 0xff00ff });
  for (const o of obstacles) {
    if (o.type === 'box') g.add(new Box3Helper(new Box3(new Vector3(o.minX, 0, o.minZ), new Vector3(o.maxX, o.h, o.maxZ)), 0xff00ff));
    else if (o.type === 'cyl') {
      const m = new Mesh(new CylinderGeometry(o.r, o.r, o.h, 10, 1, true), new MeshBasicMaterial({ color: 0xff00ff, wireframe: true }));
      m.position.set(o.x, o.h / 2, o.z);
      g.add(m);
    } else if (o.type === 'seg') {
      g.add(new Line(new BufferGeometry().setFromPoints([new Vector3(o.ax, o.ay, o.az), new Vector3(o.bx, o.by, o.bz)]), new LineBasicMaterial({ color: 0xffff00 })));
    }
  }
  g.visible = false;
  return g;
}

async function load() {
  const def = SCENES.find((s) => s.id === id) || SCENES[0];
  const mod = await def.load();
  const t = performance.now();
  inst = mod.build({ quality: params.get('q') || 'high', seed: 1 });
  const ms = performance.now() - t;
  scene.add(inst.root);
  obsGroup = obstacleWire(inst.obstacles);
  scene.add(obsGroup);
  inst.setNight(night ? 1 : 0);
  for (const m of inst.swayMaterials || []) applySway(m);
  camera.position.set(inst.pilot.x, inst.groundHeight(inst.pilot.x, inst.pilot.z) + 25, inst.pilot.z + 40);
  controls.target.set(0, 2, 0);
  window.viewer = { inst, scene, renderer, camera, controls, env, post, buildMs: ms };
  console.log(`scene ${def.id} built in ${ms.toFixed(0)} ms, ${inst.obstacles.length} obstacles`);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
addEventListener('keydown', (e) => {
  if (e.code === 'KeyN') {
    night = !night;
    env.setTimeOfDay(night ? 'night' : 'day');
  }
  if (e.code === 'KeyB' && obsGroup) obsGroup.visible = !obsGroup.visible;
  if (e.code === 'KeyW') env.setWeather(WEATHER[(wxIdx = (wxIdx + 1) % WEATHER.length)]);
  if (/^Digit[1-5]$/.test(e.code)) location.search = `?scene=${SCENES[Number(e.code.slice(5)) - 1].id}`;
});
const wind = new Vector3(3, 0, 0);
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  controls.update();
  env.update(dt, controls.target, camera.position, wind);
  post.setNight(env.nightFactor);
  swayUniforms.uTime.value += dt;
  swayUniforms.uWind.value.set(wind.x, wind.z);
  if (inst) {
    inst.setNight(env.nightFactor);
    inst.update(dt, (now - t0) / 1000, (x, y, z, out = new Vector3()) => out.copy(wind));
  }
  renderer.info.autoReset = false;
  renderer.info.reset();
  post.render(scene, camera, dt);
  const r = renderer.info.render;
  info.textContent = `${id}  |  ${r.calls} draw calls  |  ${(r.triangles / 1000).toFixed(0)}k tris  |  N: day/night  W: weather  B: obstacles  1-5: scenes`;
});
load();

