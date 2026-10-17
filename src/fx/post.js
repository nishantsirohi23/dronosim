import { HalfFloatType, Vector2, WebGLRenderTarget } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// HDR post-processing: multisampled render, bloom (glowing lights at night, sun glare) and
// tone-mapped output. Low quality bypasses the composer and renders directly.
export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;
    const size = renderer.getSize(new Vector2());
    this.rt = new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, this.rt);
    this.renderPass = new RenderPass(null, null);
    this.bloom = new UnrealBloomPass(new Vector2(size.x, size.y), 0.25, 0.45, 0.92);
    this.output = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.setSize(size.x, size.y);
  }

  setQuality(q) {
    this.enabled = q !== 'low';
    const samples = q === 'high' ? 4 : 2;
    if (this.composer.renderTarget1.samples !== samples) {
      this.composer.renderTarget1.samples = samples;
      this.composer.renderTarget2.samples = samples;
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
    }
  }

  setSize(w, h) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
  }

  // k: 0 day .. 1 night. In daylight only the sun disc is bright enough to bloom (the HDR sky
  // would otherwise wash the image out); at night lamps, LEDs and windows glow.
  setNight(k) {
    this.bloom.strength = 0.2 + 0.5 * k;
    this.bloom.threshold = 8 - 7.3 * Math.min(k * 1.25, 1);
    this.bloom.radius = 0.4 + 0.15 * k;
  }

  render(scene, camera, dt) {
    if (!this.enabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
    this.composer.render(dt);
  }
}
