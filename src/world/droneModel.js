import {
  AdditiveBlending, BoxGeometry, CanvasTexture, CircleGeometry, Color, CylinderGeometry, DoubleSide, Group, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, PointLight, SphereGeometry, Sprite, SpriteMaterial, SRGBColorSpace,
  Vector3,
} from 'three';
import { clamp } from '../util/math.js';

function regTexture(text) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 512, 128);
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 506, 122);
  ctx.fillStyle = '#111111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 76;
  ctx.font = `bold ${size}px sans-serif`;
  while (ctx.measureText(text).width > 470 && size > 20) {
    size -= 2;
    ctx.font = `bold ${size}px sans-serif`;
  }
  ctx.fillText(text, 256, 68);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

// Procedural 450-class quadcopter. Orange front arms and props give clear orientation
// cues for line-of-sight training; registration (UIN) plates on the top and sides.
export class DroneModel {
  constructor(quad) {
    this.quad = quad;
    this.root = new Group();
    this.root.name = 'drone';
    const carbon = new MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.5, metalness: 0.3 });
    const shellMat = new MeshStandardMaterial({ color: 0xe9edf2, roughness: 0.35, metalness: 0.1 });
    const front = new MeshStandardMaterial({ color: 0xff4d1a, roughness: 0.45 });
    const motorMat = new MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.3, metalness: 0.8 });
    const dark = new MeshStandardMaterial({ color: 0x24272c, roughness: 0.6 });

    const plate = new Mesh(new BoxGeometry(0.17, 0.016, 0.19), carbon);
    plate.position.y = -0.012;
    this.root.add(plate);
    const shell = new Mesh(new SphereGeometry(0.1, 24, 16), shellMat);
    shell.scale.set(0.78, 0.42, 1.2);
    shell.position.y = 0.012;
    this.root.add(shell);
    const nose = new Mesh(new SphereGeometry(0.04, 16, 12), front);
    nose.scale.set(1, 0.6, 0.8);
    nose.position.set(0, 0.012, -0.112);
    this.root.add(nose);
    const battery = new Mesh(new BoxGeometry(0.05, 0.035, 0.15), new MeshStandardMaterial({ color: 0x2b4a8a, roughness: 0.6 }));
    battery.position.y = -0.04;
    this.root.add(battery);

    // Registration plates.
    this.regMat = new MeshBasicMaterial({ map: regTexture('UIN'), side: DoubleSide, toneMapped: false });
    const top = new Mesh(new PlaneGeometry(0.14, 0.035), this.regMat);
    top.rotation.x = -Math.PI / 2;
    top.position.set(0, 0.055, 0.03);
    this.root.add(top);
    for (const s of [-1, 1]) {
      const side = new Mesh(new PlaneGeometry(0.12, 0.03), this.regMat);
      side.rotation.y = (s * Math.PI) / 2;
      side.position.set(s * 0.079, 0.006, 0.02);
      this.root.add(side);
    }

    // GPS mast
    const mast = new Mesh(new CylinderGeometry(0.004, 0.004, 0.08), dark);
    mast.position.set(0, 0.08, 0.07);
    this.root.add(mast);
    const puck = new Mesh(new CylinderGeometry(0.03, 0.03, 0.012, 20), dark);
    puck.position.set(0, 0.12, 0.07);
    this.root.add(puck);

    // Arms, motors, props, LEDs
    this.glowTex = glowTexture();
    this.props = [];
    this.leds = [];
    const armGeo = new CylinderGeometry(0.011, 0.013, 1, 10);
    armGeo.rotateX(Math.PI / 2);
    const motorGeo = new CylinderGeometry(0.022, 0.024, 0.032, 16);
    const bladeGeo = new BoxGeometry(0.254, 0.003, 0.02);
    const discGeo = new CircleGeometry(0.127, 32);
    discGeo.rotateX(-Math.PI / 2);
    const ledGeo = new SphereGeometry(0.012, 10, 8);
    const ledColors = [0x22ff44, 0xffffff, 0xff2222, 0xffffff]; // FR green, RL white, FL red, RR white
    quad.motors.forEach((m, i) => {
      const isFront = m.pos.z < 0;
      const len = m.pos.length();
      const arm = new Mesh(armGeo, isFront ? front : carbon);
      arm.scale.z = len;
      arm.position.copy(m.pos).multiplyScalar(0.5);
      arm.lookAt(m.pos.clone().multiplyScalar(2));
      this.root.add(arm);
      const motor = new Mesh(motorGeo, motorMat);
      motor.position.set(m.pos.x, 0.012, m.pos.z);
      this.root.add(motor);
      const prop = new Group();
      prop.position.set(m.pos.x, 0.034, m.pos.z);
      const bladeMat = new MeshStandardMaterial({ color: isFront ? 0xff6a2a : 0x15171a, roughness: 0.5, transparent: true });
      const blade = new Mesh(bladeGeo, bladeMat);
      prop.add(blade);
      const disc = new Mesh(discGeo, new MeshBasicMaterial({ color: isFront ? 0xff8a50 : 0x30343a, transparent: true, opacity: 0, depthWrite: false, side: DoubleSide }));
      prop.add(disc);
      this.root.add(prop);
      this.props.push({ group: prop, blade, bladeMat, disc, angle: Math.random() * Math.PI, dir: m.dir });
      const ledMat = new MeshBasicMaterial({ color: ledColors[i], toneMapped: false });
      const led = new Mesh(ledGeo, ledMat);
      led.position.set(m.pos.x, -0.006, m.pos.z);
      this.root.add(led);
      // Screen-space glow so nav lights stay visible at line-of-sight distances at night.
      const glowMat = new SpriteMaterial({ map: this.glowTex, color: ledColors[i], blending: AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: false, opacity: 0 });
      const glow = new Sprite(glowMat);
      glow.scale.setScalar(0.012);
      glow.position.copy(led.position);
      glow.renderOrder = 8;
      this.root.add(glow);
      this.leds.push({ mesh: led, mat: ledMat, color: new Color(ledColors[i]), glowMat });
    });

    // Landing gear
    for (const s of [-1, 1]) {
      const skid = new Mesh(new CylinderGeometry(0.007, 0.007, 0.28, 8), dark);
      skid.rotation.x = Math.PI / 2;
      skid.position.set(s * 0.095, -0.143, 0);
      this.root.add(skid);
      for (const z of [-0.08, 0.08]) {
        const leg = new Mesh(new CylinderGeometry(0.005, 0.005, 0.13, 6), dark);
        leg.position.set(s * 0.075, -0.083, z);
        leg.rotation.z = s * 0.3;
        this.root.add(leg);
      }
    }

    this.statusMat = new MeshBasicMaterial({ color: 0x2266ff, toneMapped: false });
    const status = new Mesh(new SphereGeometry(0.01, 10, 8), this.statusMat);
    status.position.set(0, 0.052, -0.05);
    this.root.add(status);
    this.strobeMat = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.2 });
    const strobe = new Mesh(new SphereGeometry(0.014, 10, 8), this.strobeMat);
    strobe.position.set(0, -0.06, 0.06);
    this.root.add(strobe);
    this.glow = new PointLight(0xffffff, 0, 5, 2);
    this.glow.position.set(0, -0.2, 0);
    this.root.add(this.glow);

    this.root.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    this.strobeGlow = new Sprite(new SpriteMaterial({ map: this.glowTex, color: 0xffffff, blending: AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: false, opacity: 0 }));
    this.strobeGlow.scale.setScalar(0.024);
    this.strobeGlow.position.set(0, -0.06, 0.06);
    this.root.add(this.strobeGlow);
    this._v = new Vector3();
    this.t = 0;
  }

  setRegistration(text) {
    const old = this.regMat.map;
    this.regMat.map = regTexture(text || 'UIN');
    this.regMat.needsUpdate = true;
    if (old) old.dispose();
  }

  update(dt, fc, night) {
    const q = this.quad;
    this.t += dt;
    this.root.position.copy(q.pos);
    this.root.quaternion.copy(q.quat);

    for (let i = 0; i < 4; i++) {
      const p = this.props[i];
      const out = q.out[i];
      p.angle += p.dir * out * dt * 95;
      p.group.rotation.y = p.angle;
      const blur = clamp((out - 0.04) * 3, 0, 1);
      p.disc.material.opacity = blur * 0.28;
      p.bladeMat.opacity = 1 - blur * 0.75;
    }

    // LED patterns (ArduPilot-like): disarmed = flashing, armed = solid, failsafe = fast flash.
    const armed = fc.armed;
    const fsActive = fc.fs.rc || fc.fs.batt > 0 || fc.fs.fence;
    const flash = armed ? (fsActive ? Math.sin(this.t * 18) > 0 : true) : Math.sin(this.t * 6) > 0.2;
    const nightBoost = 1 + night * 2.5;
    for (const led of this.leds) {
      led.mat.color.copy(led.color).multiplyScalar(flash ? nightBoost : 0.08);
      led.glowMat.opacity = flash ? 0.15 + night * 0.85 : 0;
    }
    let status = 0x2266ff;
    if (q.crashed) status = 0xff0000;
    else if (fsActive) status = 0xffcc00;
    else if (armed) status = 0x22ff44;
    const sOn = armed && !fsActive ? true : Math.sin(this.t * 8) > 0;
    this.statusMat.color.set(status).multiplyScalar(sOn ? nightBoost : 0.1);
    const ph = this.t % 1.2;
    const strobeOn = armed && (ph < 0.05 || (ph > 0.15 && ph < 0.2));
    this.strobeMat.opacity = strobeOn ? 1 : 0.15;
    this.strobeMat.color.setScalar(strobeOn ? 2 + night * 4 : 0.6);
    this.glow.intensity = night * (armed ? 0.5 : 0.15) + (strobeOn ? night * 2.5 : 0);
    this.strobeGlow.material.opacity = strobeOn ? 0.35 + night * 0.65 : 0;
  }
}
