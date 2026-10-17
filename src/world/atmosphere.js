import {
  AmbientLight, BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, Fog, HemisphereLight, LineSegments, Mesh,
  MeshBasicMaterial, PMREMGenerator, Points, PointsMaterial, Scene, ShaderMaterial, SphereGeometry, Vector3,
} from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { DEG, clamp, lerp, mulberry32 } from '../util/math.js';

export const TIME_OF_DAY = ['day', 'dusk', 'night'];
export const WEATHER = ['clear', 'overcast', 'fog', 'rain'];
export const WEATHER_LABEL = { clear: 'Clear', overcast: 'Overcast', fog: 'Fog', rain: 'Rain' };

// Lighting by time of day (sun/moon geometry, light levels).
const TOD = {
  day: { sunElev: 52, sunAz: 140, sun: 2.8, sunColor: 0xfff1dc, hemi: 1.0, hemiSky: 0xcfe2ff, hemiGround: 0x4a5a3a, ambient: 0.12, exposure: 0.95, skyGain: 0.35, night: 0, stars: 0, fog: 0xbcd0e2 },
  dusk: { sunElev: 4, sunAz: 255, sun: 1.3, sunColor: 0xffa865, hemi: 0.5, hemiSky: 0xa9a3c8, hemiGround: 0x3a3428, ambient: 0.08, exposure: 1.05, skyGain: 0.5, night: 0.5, stars: 0.2, fog: 0x9a8b8a },
  night: { sunElev: -18, sunAz: 255, sun: 0.28, sunColor: 0x9db4ff, hemi: 0.14, hemiSky: 0x4a5a8a, hemiGround: 0x0a0c10, ambient: 0.05, exposure: 1.15, skyGain: 1, night: 1, stars: 1, fog: 0x070b16 },
};

// Weather modifiers.
const WX = {
  clear: { turbidity: 2.4, rayleigh: 1.3, mie: 0.004, cover: 0.28, density: 0.45, light: 1, hemi: 1, fogNear: 260, fogFar: 1900, haze: 0.05, rain: 0, hazeColor: 0xc8d6e2 },
  overcast: { turbidity: 9, rayleigh: 2.2, mie: 0.012, cover: 0.92, density: 0.85, light: 0.3, hemi: 0.9, fogNear: 180, fogFar: 1000, haze: 0.45, rain: 0, hazeColor: 0xa9b1b8 },
  fog: { turbidity: 10, rayleigh: 2.5, mie: 0.02, cover: 0.7, density: 0.7, light: 0.25, hemi: 0.85, fogNear: 12, fogFar: 230, haze: 1, rain: 0, hazeColor: 0xb8bec2 },
  rain: { turbidity: 10, rayleigh: 2.4, mie: 0.016, cover: 0.97, density: 0.95, light: 0.2, hemi: 0.75, fogNear: 60, fogFar: 520, haze: 0.75, rain: 1, hazeColor: 0x8c959c },
};

const COLOR_KEYS = new Set(['sunColor', 'hemiSky', 'hemiGround', 'fog', 'hazeColor']);
const _c1 = new Color();
const _c2 = new Color();

function targetParams(tod, wx) {
  const t = TOD[tod];
  const w = WX[wx];
  const nightDim = 1 - t.night * 0.85;
  const fogColor = new Color(t.fog).lerp(new Color(w.hazeColor).multiplyScalar(nightDim), clamp(w.haze, 0, 1) * (1 - t.night * 0.6));
  return {
    sunElev: t.sunElev, sunAz: t.sunAz,
    sun: t.sun * w.light, sunColor: t.sunColor,
    hemi: t.hemi * w.hemi, hemiSky: t.hemiSky, hemiGround: t.hemiGround,
    ambient: t.ambient, exposure: t.exposure, skyGain: t.skyGain * (0.55 + 0.45 * w.light),
    night: t.night, stars: t.stars * (1 - w.cover),
    turbidity: w.turbidity, rayleigh: w.rayleigh, mie: w.mie, cover: w.cover, density: w.density,
    fog: fogColor.getHex(), fogNear: w.fogNear, fogFar: w.fogFar * (1 - t.night * 0.35),
    haze: w.haze, hazeColor: fogColor.getHex(), rain: w.rain,
  };
}

function makeSky() {
  const sky = new Sky();
  const m = sky.material;
  m.uniforms.skyGain = { value: 1 };
  m.uniforms.hazeAmount = { value: 0 };
  m.uniforms.hazeColor = { value: new Color() };
  m.fragmentShader = m.fragmentShader
    .replace('uniform float time;', 'uniform float time;\nuniform float skyGain;\nuniform float hazeAmount;\nuniform vec3 hazeColor;')
    .replace('gl_FragColor = vec4( texColor, 1.0 );', 'texColor = mix( texColor * skyGain, hazeColor, hazeAmount * ( 1.0 - smoothstep( -0.05, 0.3 + hazeAmount * 0.9, direction.y ) ) );\n\t\t\tgl_FragColor = vec4( texColor, 1.0 );');
  m.fog = false;
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  return sky;
}

// Rain streaks around the viewer, animated entirely in the vertex shader.
function makeRain(count) {
  const rnd = mulberry32(77);
  const base = new Float32Array(count * 2 * 3);
  const end = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = rnd() * 60;
    const y = rnd() * 40;
    const z = rnd() * 60;
    base.set([x, y, z, x, y, z], i * 6);
    end[i * 2] = 0;
    end[i * 2 + 1] = 1;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(base, 3));
  g.setAttribute('tail', new Float32BufferAttribute(end, 1));
  const mat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uCam: { value: new Vector3() }, uWind: { value: new Vector3() }, uOpacity: { value: 0 } },
    vertexShader: `
      attribute float tail; uniform float uTime; uniform vec3 uCam; uniform vec3 uWind;
      varying float vA;
      void main(){
        vec3 v = vec3(uWind.x, -9.0, uWind.z);
        vec3 p = position + v * uTime;
        p = mod(p, vec3(60.0, 40.0, 60.0)) - vec3(30.0, 20.0, 30.0);
        p += uCam;
        p -= v * 0.045 * tail;
        vA = 1.0 - tail * 0.7;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `uniform float uOpacity; varying float vA; void main(){ gl_FragColor = vec4(0.78, 0.82, 0.88, uOpacity * vA); }`,
  });
  const lines = new LineSegments(g, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 9;
  return lines;
}

// Physically based sky (Preetham scattering with animated clouds), sun/moon lighting,
// image-based lighting for PBR materials, fog and weather (overcast, fog, rain).
export class Atmosphere {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.tod = 'day';
    this.weather = 'clear';
    this.quality = 'high';
    this.time = 0;

    this.sky = makeSky();
    this.sky.scale.setScalar(3200);
    scene.add(this.sky);
    this.envScene = new Scene();
    this.envSky = makeSky();
    this.envSky.scale.setScalar(50);
    this.envScene.add(this.envSky);
    this.pmrem = new PMREMGenerator(renderer);
    this.envTarget = null;
    this.envDirty = true;
    this.envTimer = 0;

    const rnd = mulberry32(42);
    const pos = [];
    for (let i = 0; i < 2200; i++) {
      const th = rnd() * Math.PI * 2;
      const y = rnd() * 0.95 + 0.05;
      const r = Math.sqrt(1 - y * y);
      pos.push(Math.cos(th) * r * 1500, y * 1500, Math.sin(th) * r * 1500);
    }
    const sg = new BufferGeometry();
    sg.setAttribute('position', new Float32BufferAttribute(pos, 3));
    this.starMat = new PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
    this.stars = new Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    scene.add(this.stars);
    this.moon = new Mesh(new SphereGeometry(26, 16, 12), new MeshBasicMaterial({ color: 0xe8ecff, fog: false, transparent: true, opacity: 0 }));
    scene.add(this.moon);

    this.hemi = new HemisphereLight(0xcfe6ff, 0x4a5a3a, 1);
    this.ambient = new AmbientLight(0xffffff, 0.1);
    this.sun = new DirectionalLight(0xffffff, 2.5);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -32;
    sc.right = 32;
    sc.top = 32;
    sc.bottom = -32;
    sc.near = 1;
    sc.far = 450;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    scene.add(this.hemi, this.ambient, this.sun, this.sun.target);
    scene.fog = new Fog(0xbcd0e2, 260, 1900);

    this.rain = makeRain(5000);
    scene.add(this.rain);

    this.sunDir = new Vector3(0, 1, 0);
    this.lightDir = new Vector3(0, 1, 0);
    this.state = targetParams('day', 'clear');
    this.from = { ...this.state };
    this.to = this.state;
    this.t = 1;
    this.setQuality('high');
    this._apply(this.state);
  }

  get mode() {
    return this.tod;
  }

  get nightFactor() {
    return this.state.night;
  }

  // Approximate horizontal visibility (m), used by the HUD.
  get visibility() {
    return this.state.fogFar;
  }

  setTimeOfDay(mode, instant = false) {
    if (!TOD[mode]) return;
    this.tod = mode;
    this._retarget(instant);
  }

  setWeather(w, instant = false) {
    if (!WX[w]) return;
    this.weather = w;
    this._retarget(instant);
  }

  setQuality(q) {
    this.quality = q;
    const size = q === 'low' ? 1024 : q === 'medium' ? 2048 : 4096;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
    this.rain.geometry.setDrawRange(0, (q === 'low' ? 1500 : q === 'medium' ? 3000 : 5000) * 2);
  }

  _retarget(instant) {
    this.from = { ...this.state };
    this.to = targetParams(this.tod, this.weather);
    this.t = instant ? 1 : 0;
    if (instant) {
      this.state = { ...this.to };
      this._apply(this.state);
    }
    this.envDirty = true;
  }

  update(dt, focus, camPos, wind) {
    this.time += dt;
    if (this.t < 1) {
      this.t = clamp(this.t + dt / 1.6, 0, 1);
      const k = this.t * this.t * (3 - 2 * this.t);
      const s = {};
      for (const key of Object.keys(this.to)) {
        const a = this.from[key];
        const b = this.to[key];
        s[key] = COLOR_KEYS.has(key) ? _c1.set(a).lerp(_c2.set(b), k).getHex() : lerp(a, b, k);
      }
      this.state = s;
      this._apply(s);
      this.envDirty = true;
    }
    this.sky.position.copy(camPos);
    this.stars.position.copy(camPos);
    this.moon.position.copy(this.lightDir).multiplyScalar(1400).add(camPos);
    this.sky.material.uniforms.time.value = this.time;
    // Shadow camera follows the area of interest.
    const d = this.lightDir;
    this.sun.position.set(focus.x + d.x * 200, focus.y + d.y * 200, focus.z + d.z * 200);
    this.sun.target.position.copy(focus);
    const ru = this.rain.material.uniforms;
    ru.uTime.value = this.time;
    ru.uCam.value.copy(camPos);
    if (wind) ru.uWind.value.set(wind.x, 0, wind.z);
    ru.uOpacity.value = this.state.rain * 0.4;
    this.rain.visible = this.state.rain > 0.02;
    // Regenerate image-based lighting after changes (throttled).
    this.envTimer -= dt;
    if (this.envDirty && this.envTimer <= 0) {
      this._updateEnvMap();
      this.envDirty = this.t < 1;
      this.envTimer = 0.5;
    }
  }

  _updateEnvMap() {
    const src = this.sky.material.uniforms;
    const dst = this.envSky.material.uniforms;
    for (const k of Object.keys(src)) {
      if (src[k].value && src[k].value.copy) dst[k].value.copy(src[k].value);
      else dst[k].value = src[k].value;
    }
    dst.showSunDisc.value = 0;
    const old = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0.04);
    this.scene.environment = this.envTarget.texture;
    // Kept low: the Preetham sky is HDR and Lambert materials also receive image-based light.
    this.scene.environmentIntensity = 0.25 * (1 - 0.6 * this.state.night);
    if (old) old.dispose();
  }

  _apply(s) {
    const elev = s.sunElev * DEG;
    const az = s.sunAz * DEG;
    this.sunDir.set(Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev));
    // At night the key light is the moon (high in the south-west).
    if (s.night > 0.6) {
      const me = 40 * DEG;
      const ma = 200 * DEG;
      this.lightDir.set(Math.sin(ma) * Math.cos(me), Math.sin(me), -Math.cos(ma) * Math.cos(me));
    } else {
      this.lightDir.copy(this.sunDir);
      if (this.lightDir.y < 0.06) this.lightDir.y = 0.06;
      this.lightDir.normalize();
    }
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.sunDir);
    u.turbidity.value = s.turbidity;
    u.rayleigh.value = s.rayleigh;
    u.mieCoefficient.value = s.mie;
    u.mieDirectionalG.value = 0.8;
    u.cloudCoverage.value = s.cover;
    u.cloudDensity.value = s.density;
    u.skyGain.value = s.skyGain;
    u.hazeAmount.value = s.haze;
    u.hazeColor.value.set(s.hazeColor);
    this.sun.color.set(s.sunColor);
    this.sun.intensity = s.sun;
    this.hemi.intensity = s.hemi;
    this.hemi.color.set(s.hemiSky);
    this.hemi.groundColor.set(s.hemiGround);
    this.ambient.intensity = s.ambient;
    this.scene.fog.color.set(s.fog);
    this.scene.fog.near = s.fogNear;
    this.scene.fog.far = s.fogFar;
    this.renderer.toneMappingExposure = s.exposure;
    this.starMat.opacity = s.stars;
    this.moon.material.opacity = s.night * (1 - s.cover * 0.8);
    this.moon.visible = s.night > 0.6;
  }
}
