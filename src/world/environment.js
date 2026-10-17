import {
  AmbientLight, BackSide, BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, Fog, HemisphereLight, Mesh,
  MeshBasicMaterial, Points, PointsMaterial, ShaderMaterial, SphereGeometry, Vector3,
} from 'three';
import { clamp, lerp, mulberry32 } from '../util/math.js';

const PRESETS = {
  day: {
    top: 0x3f7fd0, horizon: 0xc8dcef, ground: 0x8fa58a, fog: 0xbfd2e2, fogNear: 250, fogFar: 1700,
    sun: 2.6, sunColor: 0xfff4e0, hemi: 1.1, ambient: 0.15, exposure: 1.0, sunElev: 52, sunAz: 140, stars: 0, night: 0,
  },
  dusk: {
    top: 0x2a3a6a, horizon: 0xf09a5a, ground: 0x4a4a40, fog: 0x8a7a80, fogNear: 200, fogFar: 1400,
    sun: 1.2, sunColor: 0xffa060, hemi: 0.45, ambient: 0.08, exposure: 1.05, sunElev: 6, sunAz: 255, stars: 0.25, night: 0.55,
  },
  night: {
    top: 0x02040c, horizon: 0x0d1630, ground: 0x050608, fog: 0x070b16, fogNear: 120, fogFar: 1100,
    sun: 0.22, sunColor: 0x9db4ff, hemi: 0.12, ambient: 0.05, exposure: 1.15, sunElev: 38, sunAz: 200, stars: 1, night: 1,
  },
};

export const TIME_OF_DAY = Object.keys(PRESETS);

export class Environment {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.mode = 'day';
    this.state = { ...PRESETS.day };
    this.from = { ...PRESETS.day };
    this.to = PRESETS.day;
    this.t = 1;

    this.skyUniforms = {
      top: { value: new Color(PRESETS.day.top) },
      horizon: { value: new Color(PRESETS.day.horizon) },
      ground: { value: new Color(PRESETS.day.ground) },
      sunDir: { value: new Vector3(0, 1, 0) },
      sunColor: { value: new Color(PRESETS.day.sunColor) },
      sunSize: { value: 0.9995 },
    };
    const sky = new Mesh(
      new SphereGeometry(1800, 32, 16),
      new ShaderMaterial({
        uniforms: this.skyUniforms,
        side: BackSide,
        depthWrite: false,
        fog: false,
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `
          uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunSize;
          varying vec3 vDir;
          void main(){
            vec3 d = normalize(vDir);
            float h = d.y;
            vec3 col = h > 0.0 ? mix(horizon, top, pow(clamp(h,0.0,1.0), 0.55)) : mix(horizon, ground, clamp(-h*6.0,0.0,1.0));
            float s = dot(d, normalize(sunDir));
            col += sunColor * smoothstep(sunSize, 1.0, s) * 2.0;
            col += sunColor * pow(max(s,0.0), 64.0) * 0.25;
            gl_FragColor = vec4(col, 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    );
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    this.sky = sky;
    scene.add(sky);

    // Stars
    const rnd = mulberry32(42);
    const pos = [];
    for (let i = 0; i < 1800; i++) {
      const u = rnd();
      const v = rnd() * 0.95 + 0.05;
      const th = u * Math.PI * 2;
      const y = v;
      const r = Math.sqrt(1 - y * y);
      pos.push(Math.cos(th) * r * 1700, y * 1700, Math.sin(th) * r * 1700);
    }
    const sg = new BufferGeometry();
    sg.setAttribute('position', new Float32BufferAttribute(pos, 3));
    this.starMat = new PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
    this.stars = new Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    scene.add(this.stars);

    this.moon = new Mesh(new SphereGeometry(28, 16, 12), new MeshBasicMaterial({ color: 0xe8ecff, fog: false, transparent: true, opacity: 0 }));
    scene.add(this.moon);

    this.hemi = new HemisphereLight(0xcfe6ff, 0x4a5a3a, 1);
    this.ambient = new AmbientLight(0xffffff, 0.1);
    this.sun = new DirectionalLight(0xffffff, 2.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -30;
    sc.right = 30;
    sc.top = 30;
    sc.bottom = -30;
    sc.near = 1;
    sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    scene.add(this.hemi, this.ambient, this.sun, this.sun.target);
    scene.fog = new Fog(PRESETS.day.fog, 250, 1700);
    this._apply(this.state);
  }

  setTimeOfDay(mode, instant = false) {
    if (!PRESETS[mode]) return;
    this.mode = mode;
    this.from = { ...this.state };
    this.to = PRESETS[mode];
    this.t = instant ? 1 : 0;
    if (instant) this._apply((this.state = { ...this.to }));
  }

  get nightFactor() {
    return this.state.night;
  }

  update(dt, focus, camPos) {
    if (this.t < 1) {
      this.t = clamp(this.t + dt / 1.5, 0, 1);
      const k = this.t * this.t * (3 - 2 * this.t);
      const s = {};
      for (const key of Object.keys(this.to)) {
        const a = this.from[key];
        const b = this.to[key];
        s[key] = typeof a === 'number' && key.match(/top|horizon|ground|fog$|sunColor/) ? lerpColor(a, b, k) : lerp(a, b, k);
      }
      this.state = s;
      this._apply(s);
    }
    // Shadow camera follows the area of interest so the drone always casts a crisp shadow.
    const dir = this._sunDir;
    this.sun.position.set(focus.x + dir.x * 150, focus.y + dir.y * 150, focus.z + dir.z * 150);
    this.sun.target.position.set(focus.x, focus.y, focus.z);
    // Sky, stars and moon are centred on the viewer so they never clip.
    this.sky.position.copy(camPos);
    this.stars.position.copy(camPos);
    this.moon.position.copy(this._sunDir).multiplyScalar(1500).add(camPos);
  }

  _apply(s) {
    const elev = (s.sunElev * Math.PI) / 180;
    const az = (s.sunAz * Math.PI) / 180;
    this._sunDir = new Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev));
    const u = this.skyUniforms;
    u.top.value.set(s.top);
    u.horizon.value.set(s.horizon);
    u.ground.value.set(s.ground);
    u.sunDir.value.copy(this._sunDir);
    u.sunColor.value.set(s.sunColor).multiplyScalar(s.night > 0.8 ? 0.0 : 1 - s.night);
    this.sun.color.set(s.sunColor);
    this.sun.intensity = s.sun;
    this.hemi.intensity = s.hemi;
    this.hemi.color.set(s.night > 0.5 ? 0x4a5a8a : 0xcfe6ff);
    this.ambient.intensity = s.ambient;
    this.scene.fog.color.set(s.fog);
    this.scene.fog.near = s.fogNear;
    this.scene.fog.far = s.fogFar;
    this.renderer.toneMappingExposure = s.exposure;
    this.starMat.opacity = s.stars;
    this.moon.material.opacity = s.night;
    this.moon.position.copy(this._sunDir).multiplyScalar(1500);
    this.moon.visible = s.night > 0.6;
  }
}

function lerpColor(a, b, t) {
  const ca = new Color(a);
  const cb = new Color(b);
  return ca.lerp(cb, t).getHex();
}
