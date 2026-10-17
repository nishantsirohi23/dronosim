import { EDITION_LABEL, IS_PRO, SCENE_ACCESS, EDITION } from '../config.js';
import { SCENES } from '../world/scenes/index.js';
import { WEATHER, WEATHER_LABEL } from '../world/atmosphere.js';
import { GIMBAL_LABEL } from '../sensors/gimbal.js';
import { DEG } from '../util/math.js';
import { Minimap } from './minimap.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SCENE_ART = {
  training: 'linear-gradient(160deg,#5f9140 0%,#6ea24b 45%,#8fbf62 46%,#5f9140 100%)',
  city: 'linear-gradient(170deg,#7aa6d6 0%,#b8cde3 40%,#5a6370 41%,#8a919b 70%,#3b3e42 71%)',
  forest: 'linear-gradient(170deg,#9cc3e0 0%,#c9dcc0 35%,#2f5a2c 36%,#1f3f1d 75%,#4c7a3c 100%)',
  farm: 'linear-gradient(170deg,#9cc8ea 0%,#d7e6ef 35%,#d8b54a 36%,#c9a43a 55%,#6ea24b 56%,#7a5a3c 100%)',
  industrial: 'linear-gradient(170deg,#a9c7e3 0%,#d9e3ea 38%,#1e3260 39%,#2a3f6e 60%,#a8916b 61%,#8f7a58 100%)',
};

// Scene picker, weather and graphics controls, obstacle sensor display, gimbal camera
// overlay, minimap and sound.
export class WorldUI {
  constructor(sim, ui) {
    this.sim = sim;
    this.ui = ui;
    this.s = sim.settings;
    this.minimap = new Minimap($('minimap'));
    this.mapTimer = 0;
    this.sensTimer = 0;

    $('btn-scene').onclick = () => this.openScenes();
    $('btn-weather').onclick = () => this.cycleWeather();
    $('weather-name').textContent = WEATHER_LABEL[this.s.weather || 'clear'];
    $('minimap').hidden = this.s.minimap === false;

    sim.gimbalRect = () => {
      const el = $('gimbal-view');
      if (el.hidden) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: window.innerHeight - r.bottom, w: r.width, h: r.height };
    };

    sim.on('sceneloading', (def) => {
      $('loading-name').textContent = def.name;
      $('loading').hidden = false;
    });
    sim.on('sceneloaded', () => ($('loading').hidden = true));
    sim.on('scene', (inst) => this._sceneChanged(inst));

    // Browsers only allow audio after a user gesture.
    const unlock = () => sim.audio.ensure();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    this._settings();
  }

  // ------------------------------------------------------------ scenes

  openScenes() {
    const cards = $('scene-cards');
    cards.innerHTML = SCENES.map((sc) => {
      const ok = this.sim.sceneAvailable(sc.id);
      const cur = sc.id === this.sim.sceneId;
      return `<button type="button" class="scene-card ${cur ? 'current' : ''} ${ok ? '' : 'locked'}" data-scene="${sc.id}" ${ok ? '' : 'aria-disabled="true"'}>
        <span class="art" style="background:${SCENE_ART[sc.id] || '#334'}"></span>
        <b>${esc(sc.name)}</b>
        <small>${esc(sc.summary)}</small>
        <em>${cur ? 'Current scene' : ok ? 'Load scene' : 'Pro Edition'}</em>
      </button>`;
    }).join('');
    for (const b of cards.querySelectorAll('[data-scene]')) {
      b.onclick = async () => {
        const id = b.dataset.scene;
        if (!this.sim.sceneAvailable(id)) {
          this.ui.message('This scene is part of the Pro Edition', 'warn');
          return;
        }
        if (this.sim.fc.armed) {
          this.ui.message('Land and disarm before changing scene', 'warn');
          return;
        }
        $('dlg-scene').close();
        if (id !== this.sim.sceneId) {
          if (this.sim.challenge.active) this.sim.challenge.abort('Scene changed');
          await this.sim.loadScene(id);
          this.ui.save();
        }
      };
    }
    const locked = SCENES.filter((sc) => !this.sim.sceneAvailable(sc.id)).length;
    $('scene-note').textContent = locked
      ? `${EDITION_LABEL}: ${SCENE_ACCESS[EDITION]?.length || 1} scene(s) included. The other environments are available with the Pro Edition.`
      : IS_PRO ? 'Pro Edition: all scenes included.' : '';
    $('dlg-scene').showModal();
  }

  _sceneChanged(inst) {
    const def = this.sim.sceneDef;
    $('scene-name').textContent = def ? def.name.replace('RPTO ', '') : 'Scene';
    this.minimap.setScene(inst);
    this.ui.planner?.resetView?.();
    // Reference patterns and the challenge live on the training ground.
    for (const b of document.querySelectorAll('[data-overlay]')) b.disabled = !inst.patterns && b.dataset.overlay !== 'none';
    this.ui._markOverlay?.();
  }

  // ------------------------------------------------------------ weather, quality, sound

  cycleWeather() {
    const i = WEATHER.indexOf(this.s.weather || 'clear');
    const w = WEATHER[(i + 1) % WEATHER.length];
    this.sim.setWeather(w);
    $('weather-name').textContent = WEATHER_LABEL[w];
    this.ui.save();
    this.ui.message(`Weather: ${WEATHER_LABEL[w]}`);
  }

  toggleSound() {
    this.s.sound = this.s.sound === false;
    this.sim.audio.setMuted(this.s.sound === false);
    this.ui.save();
    this.ui.message(`Sound ${this.s.sound ? 'on' : 'off'}`);
  }

  toggleAvoidance() {
    this.s.sensors ||= { avoidance: true, beeper: true };
    this.s.sensors.avoidance = !this.s.sensors.avoidance;
    this.sim.sensors.enabled = this.s.sensors.avoidance;
    this.ui.save();
    this.ui.message(`Obstacle braking ${this.s.sensors.avoidance ? 'on (Loiter)' : 'off'}`);
  }

  _settings() {
    const s = this.s;
    s.sensors ||= { avoidance: true, beeper: true };
    const pairs = [
      ['s-weather', () => s.weather || 'clear', (v) => {
        this.sim.setWeather(v);
        $('weather-name').textContent = WEATHER_LABEL[v];
      }],
      ['s-quality', () => s.quality || 'medium', (v) => this.sim.setQuality(v)],
      ['s-sound', () => s.sound !== false, (v) => {
        s.sound = v;
        this.sim.audio.setMuted(!v);
      }],
      ['s-minimap', () => s.minimap !== false, (v) => {
        s.minimap = v;
        $('minimap').hidden = !v;
      }],
      ['s-avoid', () => s.sensors.avoidance !== false, (v) => {
        s.sensors.avoidance = v;
        this.sim.sensors.enabled = v;
      }],
      ['s-beeper', () => s.sensors.beeper !== false, (v) => (s.sensors.beeper = v)],
    ];
    this.fillers = [];
    for (const [id, get, set] of pairs) {
      const el = $(id);
      el.addEventListener('change', () => {
        set(el.type === 'checkbox' ? el.checked : el.value);
        this.ui.save();
      });
      this.fillers.push(() => {
        if (el.type === 'checkbox') el.checked = get();
        else el.value = get();
      });
    }
  }

  fillSettings() {
    for (const f of this.fillers) f();
  }

  // ------------------------------------------------------------ gimbal

  cycleGimbal() {
    const g = this.sim.gimbal;
    const mode = g.cycleMode();
    $('gimbal-view').hidden = mode === 'off';
    $('gv-scale').hidden = mode !== 'thermal';
    $('gv-mode').textContent = GIMBAL_LABEL[mode];
    document.body.classList.toggle('gimbal-on', mode !== 'off');
    this.ui.message(mode === 'off' ? 'Payload camera off' : `Payload camera: ${GIMBAL_LABEL[mode]}`);
  }

  handleKey(e) {
    const k = e.code;
    const g = this.sim.gimbal;
    if (k === 'KeyL') this.openScenes();
    else if (k === 'KeyJ') this.cycleWeather();
    else if (k === 'KeyK') this.toggleSound();
    else if (k === 'KeyB') this.toggleAvoidance();
    else if (k === 'KeyG') this.cycleGimbal();
    else if (k === 'BracketLeft') g.nudgeTilt(-10);
    else if (k === 'BracketRight') g.nudgeTilt(10);
    else if (k === 'Minus') g.nudgeZoom(1 / 1.5);
    else if (k === 'Equal') g.nudgeZoom(1.5);
    else return false;
    return true;
  }

  // ------------------------------------------------------------ per frame

  frame(dt) {
    const sim = this.sim;
    if (!sim.scenery) return;
    this.mapTimer += dt;
    if (this.mapTimer > 0.1 && this.s.minimap !== false) {
      this.mapTimer = 0;
      this.minimap.draw({
        pos: sim.quad.pos,
        yaw: sim.fc.yaw,
        home: sim.fc.homeSet ? sim.fc.home : { x: 0, z: 0 },
        pilot: sim.scenery.pilot,
        trail: sim.trail.points,
        fence: sim.fenceConfig,
      });
    }
    this.sensTimer += dt;
    if (this.sensTimer > 0.1) {
      this.sensTimer = 0;
      this._sensors();
      if (sim.gimbal.active) {
        $('gv-info').textContent = `tilt ${Math.round(sim.gimbal.tilt / DEG)}°  zoom ${sim.gimbal.zoom.toFixed(1)}x`;
      }
    }
  }

  _sensors() {
    const sim = this.sim;
    const d = sim.sensors.dist;
    const on = this.s.sensors?.avoidance !== false;
    const state = $('sens-state');
    const txt = !on ? 'BRAKE OFF' : sim.braking ? 'BRAKING' : sim.fc.mode === 'LOITER' ? 'BRAKE ON' : 'WARN ONLY';
    if (state.textContent !== txt) state.textContent = txt;
    state.dataset.state = sim.braking ? 'crit' : on ? 'good' : '';
    for (const dir of ['front', 'right', 'back', 'left']) {
      const el = $(`sens-${dir}`);
      const v = d[dir];
      el.textContent = Number.isFinite(v) ? v.toFixed(1) : '--';
      el.dataset.level = v < 3 ? 'crit' : v < 8 ? 'warn' : Number.isFinite(v) ? 'ok' : '';
    }
    $('sens-down').textContent = d.down.toFixed(1);
    const n = sim.sensors.nearest;
    $('sens-near').textContent = Number.isFinite(n.dist) ? `${n.name} ${n.dist.toFixed(1)} m ${n.dir}` : 'clear';
    const vis = sim.env.visibility;
    $('vis').textContent = vis > 1500 ? '>1500' : Math.round(vis);
  }
}
