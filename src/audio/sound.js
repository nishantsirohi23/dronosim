import { clamp } from '../util/math.js';

// Procedural drone audio: per-motor blade-pass tones plus broadband prop wash, attenuated
// with distance from the listener, and an obstacle-proximity beeper.
export class DroneAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.beepTimer = 0;
  }

  // Must be called from a user gesture (browser autoplay policy).
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    const master = (this.master = ctx.createGain());
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
    this.air = ctx.createBiquadFilter();
    this.air.type = 'lowpass';
    this.air.frequency.value = 6000;
    this.air.connect(master);
    this.motors = [0, 1, 2, 3].map((i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 100 + i * 3;
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g).connect(this.air);
      osc.start();
      return { osc, g, detune: (i - 1.5) * 2.2 };
    });
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    this.wash = ctx.createBiquadFilter();
    this.wash.type = 'bandpass';
    this.wash.Q.value = 0.7;
    this.washGain = ctx.createGain();
    this.washGain.gain.value = 0;
    noise.connect(this.wash).connect(this.washGain).connect(this.air);
    noise.start();
    // Beeper bypasses distance attenuation (it is in the pilot's ground station).
    this.beepGain = ctx.createGain();
    this.beepGain.gain.value = 0;
    const beep = ctx.createOscillator();
    beep.type = 'square';
    beep.frequency.value = 1750;
    const beepLp = ctx.createBiquadFilter();
    beepLp.type = 'lowpass';
    beepLp.frequency.value = 3000;
    beep.connect(beepLp).connect(this.beepGain).connect(comp);
    beep.start();
  }

  setMuted(m) {
    this.muted = m;
  }

  update(dt, { outputs, armed, distance, proximity, crashed }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const tc = 0.05;
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const o = crashed ? 0 : outputs[i];
      sum += o;
      const m = this.motors[i];
      m.osc.frequency.setTargetAtTime(85 + o * 250 + m.detune, t, tc);
      m.g.gain.setTargetAtTime(o > 0.01 ? 0.035 + o * 0.09 : 0, t, tc);
    }
    const avg = sum / 4;
    this.wash.frequency.setTargetAtTime(350 + avg * 2600, t, tc);
    this.washGain.gain.setTargetAtTime(avg * 0.5, t, tc);
    const d = Math.max(distance, 0.5);
    const att = 1 / (1 + Math.pow(d / 6, 1.25));
    this.air.frequency.setTargetAtTime(clamp(9000 / (1 + d / 25), 600, 9000), t, 0.1);
    this.master.gain.setTargetAtTime(this.muted ? 0 : att * 0.9, t, 0.08);

    // Proximity beeper: faster as the obstacle gets closer, continuous below 1.5 m.
    let on = false;
    if (armed && !this.muted && proximity < 8) {
      if (proximity < 1.5) on = true;
      else {
        const period = 0.08 + ((proximity - 1.5) / 6.5) * 0.55;
        this.beepTimer += dt;
        if (this.beepTimer > period) this.beepTimer = 0;
        on = this.beepTimer < 0.06;
      }
    }
    this.beepGain.gain.setTargetAtTime(on ? 0.06 : 0, t, 0.005);
  }
}
