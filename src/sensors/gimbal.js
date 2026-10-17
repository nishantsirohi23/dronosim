import {
  Color, HalfFloatType, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, PlaneGeometry, Scene, ShaderMaterial,
  Vector3, WebGLRenderTarget,
} from 'three';
import { clamp, DEG } from '../util/math.js';
import { HEAT } from '../world/scenes/common.js';

export const GIMBAL_MODES = ['off', 'rgb', 'thermal', 'night'];
export const GIMBAL_LABEL = { off: 'Off', rgb: 'Visible', thermal: 'Thermal', night: 'Night vision' };

const _v = new Vector3();

// Payload camera on a 2-axis stabilised gimbal, rendered picture-in-picture.
// Thermal mode renders a heat image (per-object userData.heat) mapped to an iron palette.
export class GimbalCamera {
  constructor(renderer) {
    this.renderer = renderer;
    this.mode = 'off';
    this.tilt = -30 * DEG;
    this.zoom = 1;
    this.width = 384;
    this.height = 216;
    this.camera = new PerspectiveCamera(62, 16 / 9, 0.1, 3000);
    this.rt = new WebGLRenderTarget(this.width * 2, this.height * 2, { type: HalfFloatType });
    this.quadScene = new Scene();
    this.quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadMat = new ShaderMaterial({
      uniforms: { tSrc: { value: this.rt.texture }, uMode: { value: 0 }, uTime: { value: 0 }, uGain: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D tSrc; uniform int uMode; uniform float uTime; uniform float uGain; varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 43.0) * 43758.5453); }
        vec3 iron(float t){
          t = clamp(t, 0.0, 1.0);
          vec3 c = mix(vec3(0.0, 0.0, 0.05), vec3(0.3, 0.0, 0.55), smoothstep(0.0, 0.25, t));
          c = mix(c, vec3(0.85, 0.1, 0.25), smoothstep(0.2, 0.5, t));
          c = mix(c, vec3(1.0, 0.55, 0.0), smoothstep(0.45, 0.75, t));
          c = mix(c, vec3(1.0, 1.0, 0.75), smoothstep(0.75, 1.0, t));
          return c;
        }
        void main(){
          vec3 src = texture2D(tSrc, vUv).rgb;
          vec3 col = src;
          if (uMode == 2) {
            float h = dot(src, vec3(0.299, 0.587, 0.114));
            h += (hash(vUv * 512.0) - 0.5) * 0.025;
            col = iron(h);
          } else if (uMode == 3) {
            float l = dot(src, vec3(0.299, 0.587, 0.114)) * uGain;
            l = l / (1.0 + l);
            l += (hash(vUv * 400.0) - 0.5) * 0.12;
            float vig = smoothstep(0.85, 0.35, length(vUv - 0.5));
            col = vec3(0.15, 1.0, 0.25) * clamp(l, 0.0, 1.0) * vig;
          }
          gl_FragColor = vec4(col, 1.0);
          if (uMode == 1) {
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quadScene.add(new Mesh(new PlaneGeometry(2, 2), this.quadMat));
    this.thermalCache = new Map();
    this.coldSky = new Color(0x050510);
    this.swapped = [];
    this.frame = 0;
  }

  get active() {
    return this.mode !== 'off';
  }

  cycleMode() {
    const i = GIMBAL_MODES.indexOf(this.mode);
    this.mode = GIMBAL_MODES[(i + 1) % GIMBAL_MODES.length];
    return this.mode;
  }

  setTilt(deg) {
    this.tilt = clamp(deg, -90, 20) * DEG;
  }

  nudgeTilt(deltaDeg) {
    this.setTilt(this.tilt / DEG + deltaDeg);
  }

  nudgeZoom(f) {
    this.zoom = clamp(this.zoom * f, 1, 8);
  }

  // Stabilised: follows heading only, ignores the airframe's roll and pitch.
  updatePose(quad, yaw) {
    this.camera.position.copy(_v.set(0, -0.12, -0.04).applyAxisAngle(new Vector3(0, 1, 0), yaw).add(quad.pos));
    this.camera.rotation.set(this.tilt, yaw, 0, 'YXZ');
    this.camera.fov = 62 / this.zoom;
    this.camera.updateProjectionMatrix();
  }

  _thermalMaterial(src, heat) {
    const map = src && src.map ? src.map : null;
    const key = `${heat.toFixed(2)}|${map ? map.uuid : ''}|${src && src.side}|${src && src.transparent ? src.opacity : 1}`;
    let m = this.thermalCache.get(key);
    if (!m) {
      // Texture detail survives as small temperature variation. Transparent sources (smoke,
      // water, glass) stay see-through so they don't read as solid hot objects.
      const transparent = !!(src && src.transparent);
      m = new MeshBasicMaterial({
        color: new Color().setScalar(0.25 + heat * 0.75), map, fog: false, side: src ? src.side : 0,
        transparent, opacity: transparent ? Math.min(src.opacity ?? 1, 0.5) : 1, depthWrite: !transparent,
      });
      this.thermalCache.set(key, m);
    }
    return m;
  }

  _swapToThermal(scene) {
    const swapped = this.swapped;
    swapped.length = 0;
    scene.traverseVisible((o) => {
      if (o.isPoints || o.isLine || o.isSprite) {
        swapped.push([o, o.material, o.visible]);
        o.visible = false;
        return;
      }
      if (!o.isMesh) return;
      const heat = o.userData.heat ?? HEAT.ground;
      const orig = o.material;
      const first = Array.isArray(orig) ? orig[0] : orig;
      if (!first || first.isShaderMaterial) {
        swapped.push([o, orig, o.visible]);
        o.visible = false;
        return;
      }
      swapped.push([o, orig, o.visible]);
      o.material = Array.isArray(orig) ? orig.map((m) => this._thermalMaterial(m, heat)) : this._thermalMaterial(orig, heat);
    });
  }

  _restore() {
    for (const [o, mat, vis] of this.swapped) {
      o.material = mat;
      o.visible = vis;
    }
    this.swapped.length = 0;
  }

  // Render the payload view into the corner viewport (x, y from the bottom-left, CSS pixels).
  render(scene, rect, time) {
    if (!this.active) return;
    const r = this.renderer;
    this.frame++;
    // The payload view refreshes at half the frame rate to save GPU time.
    if (this.frame % 2 === 0) {
      const fog = scene.fog;
      const bg = scene.background;
      const env = scene.environment;
      const exposure = r.toneMappingExposure;
      if (this.mode === 'thermal') {
        scene.fog = null;
        scene.background = this.coldSky;
        scene.environment = null;
        this._swapToThermal(scene);
      }
      r.setRenderTarget(this.rt);
      r.clear();
      r.render(scene, this.camera);
      r.setRenderTarget(null);
      if (this.mode === 'thermal') {
        this._restore();
        scene.fog = fog;
        scene.background = bg;
        scene.environment = env;
      }
      r.toneMappingExposure = exposure;
    }
    this.quadMat.uniforms.uMode.value = GIMBAL_MODES.indexOf(this.mode);
    this.quadMat.uniforms.uTime.value = time;
    this.quadMat.uniforms.uGain.value = 6;
    const autoClear = r.autoClear;
    r.autoClear = false;
    r.setScissorTest(true);
    r.setScissor(rect.x, rect.y, rect.w, rect.h);
    r.setViewport(rect.x, rect.y, rect.w, rect.h);
    r.render(this.quadScene, this.quadCam);
    r.setScissorTest(false);
    const size = r.getSize(_v);
    r.setViewport(0, 0, size.x, size.y);
    r.autoClear = autoClear;
  }
}
