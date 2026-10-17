import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { APP_NAME, DEFAULT_GAINS, DEMO_FENCE, DRONE_X4, EDITION, EDITION_LABEL, IS_DEMO, IS_PRO, SCENE_ACCESS, VERSION } from '../config.js';
import { SCENES } from '../world/scenes/index.js';
import { MODES, MODE_INFO } from '../fc/flightController.js';
import { VIEWS } from '../world/cameras.js';
import { PATTERNS } from '../world/patterns.js';
import { CHALLENGE } from '../assess/challenge.js';
import { saveSettings } from '../settings.js';
import { formatDuration } from '../util/math.js';
import { Hud } from './hud.js';
import { ControllerPanel } from './controllerPanel.js';
import { MissionPlanner } from './missionPlanner.js';
import { helpHtml } from './help.js';
import { WorldUI } from './worldPanel.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TOD = ['day', 'dusk', 'night'];

export class UI {
  constructor(sim) {
    this.sim = sim;
    this.s = sim.settings;
    this.hud = new Hud(sim);
    this.controllerPanel = new ControllerPanel(sim);
    this.planner = new MissionPlanner(sim, this);
    this.world = new WorldUI(sim, this);
    this.statsTimer = 0;
    this.estopArmed = 0;
    this.prevView = 'pilot';

    this._topbar();
    this._bottombar();
    this._assessPanel();
    this._settings();
    this._challenge();
    this._help();
    this._keys();
    this._controllerEvents();
    this._vr();

    sim.on('msg', (m) => this.message(m.text, m.severity));
    sim.on('frame', (dt) => this.frame(dt));
    sim.on('view', (id) => this._viewChanged(id));
    sim.on('pause', (p) => ($('pause-overlay').hidden = !p));
    sim.on('capture', () => this._renderCaptures());
    sim.on('crash', (e) => this.message(`CRASH: ${e.reason}`, 'crit'));
    sim.challenge.onChange(() => this._challengeChanged());
    this._viewChanged(sim.cameras.view);
    this._edition();
    this.message(`${APP_NAME} ${VERSION} ready. Throttle down, press Enter to arm. H for help.`, 'good');
  }

  save() {
    saveSettings(this.s);
  }

  // ------------------------------------------------------------ messages

  message(text, severity = 'info') {
    const box = $('messages');
    const el = document.createElement('div');
    el.className = `msg ${severity}`;
    const time = formatDuration(this.sim.time);
    el.innerHTML = `<span class="t">${time}</span>${esc(text)}`;
    box.appendChild(el);
    while (box.children.length > 7) box.firstChild.remove();
    setTimeout(() => el.classList.add('fade'), severity === 'crit' ? 12000 : 7000);
    setTimeout(() => el.remove(), severity === 'crit' ? 13000 : 8000);
  }

  // ------------------------------------------------------------ top bar

  _edition() {
    $('edition').textContent = EDITION_LABEL.toUpperCase();
    $('edition').dataset.demo = IS_DEMO ? '1' : '';
    $('edition').dataset.pro = IS_PRO ? '1' : '';
    if (IS_DEMO) {
      $('demo-banner').hidden = false;
      $('demo-alt').textContent = DEMO_FENCE.maxAlt;
      $('demo-rad').textContent = DEMO_FENCE.radius;
    }
  }

  _topbar() {
    const sim = this.sim;
    $('st-reg').textContent = this.s.registration || '-';
    $('btn-view').onclick = () => sim.cycleView();
    $('btn-tod').onclick = () => this.cycleTimeOfDay();
    $('tod-name').textContent = cap(this.s.timeOfDay);
    $('btn-capture-top').onclick = () => sim.capture('overhead');
    $('btn-mission').onclick = () => this.planner.open();
    $('btn-challenge').onclick = () => this.openChallenge();
    $('btn-controller').onclick = () => this.controllerPanel.open();
    $('btn-settings').onclick = () => this.openSettings();
    $('btn-help').onclick = () => $('dlg-help').showModal();
    for (const btn of document.querySelectorAll('[data-collapse]')) {
      btn.onclick = () => {
        const p = $(btn.dataset.collapse);
        p.classList.toggle('collapsed');
        btn.innerHTML = p.classList.contains('collapsed') ? '&#43;' : '&#8722;';
      };
    }
  }

  cycleTimeOfDay() {
    const i = TOD.indexOf(this.s.timeOfDay);
    this.s.timeOfDay = TOD[(i + 1) % TOD.length];
    this.sim.env.setTimeOfDay(this.s.timeOfDay);
    $('tod-name').textContent = cap(this.s.timeOfDay);
    this.save();
    this.message(`Lighting: ${this.s.timeOfDay}`);
  }

  _viewChanged(id) {
    const v = VIEWS.find((x) => x.id === id);
    $('view-name').textContent = v.short;
    $('overhead-scale').hidden = id !== 'overhead';
    document.body.dataset.view = id;
  }

  _vr() {
    if (!('xr' in navigator)) return;
    navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
      if (!ok) return;
      const btn = VRButton.createButton(this.sim.renderer);
      btn.removeAttribute('style');
      btn.className = 'vr-btn';
      $('vr-slot').appendChild(btn);
      this.sim.on('xr', (on) => this.message(on ? 'VR session started: pilot-station view' : 'VR session ended'));
    }).catch(() => {});
  }

  // ------------------------------------------------------------ bottom bar

  _bottombar() {
    const sim = this.sim;
    for (const btn of document.querySelectorAll('[data-mode]')) btn.onclick = () => sim.setMode(btn.dataset.mode);
    $('btn-arm').onclick = () => sim.toggleArm('button');
    $('btn-estop').ondblclick = () => sim.emergencyStop();
    $('btn-estop').onclick = () => {
      if (sim.fc.armed) this.message('Double-click E-STOP (or press X twice) to stop motors', 'warn');
    };
    $('btn-reset').onclick = () => sim.resetDrone();
    $('btn-pause').onclick = () => sim.togglePause();
    sim.on('pause', (p) => ($('btn-pause').textContent = p ? 'Resume' : 'Pause'));
  }

  // ------------------------------------------------------------ assessment panel

  _assessPanel() {
    const sim = this.sim;
    const t = this.s.trail;
    $('trail-visible').checked = t.visible;
    $('trail-ground').checked = t.groundTrack;
    $('trail-color').value = t.colorMode;
    $('trail-width').value = t.width;
    $('trail-visible').onchange = (e) => {
      t.visible = e.target.checked;
      sim.trail.setVisible(t.visible);
      this.save();
    };
    $('trail-ground').onchange = (e) => {
      t.groundTrack = e.target.checked;
      sim.trail.setGroundTrack(t.groundTrack);
      this.save();
    };
    $('trail-color').onchange = (e) => {
      t.colorMode = e.target.value;
      sim.trail.setColorMode(t.colorMode);
      this._legend();
      this.save();
    };
    $('trail-width').oninput = (e) => {
      t.width = Number(e.target.value);
      sim.trail.setWidth(t.width);
      this.save();
    };
    $('btn-clear-trail').onclick = () => sim.clearTrail();
    for (const b of document.querySelectorAll('[data-overlay]')) {
      b.onclick = () => this.setOverlay(b.dataset.overlay);
    }
    this._markOverlay();
    $('btn-cap2').onclick = () => sim.capture('view');
    $('btn-cap-top2').onclick = () => sim.capture('overhead');
    $('btn-log').onclick = () => sim.exportLog();
    this._legend();
  }

  setOverlay(id) {
    this.sim.setOverlay(id);
    this._markOverlay();
    this.save();
  }

  cycleOverlay() {
    const order = ['none', 'circle', 'square', 'figure8', 'all'];
    this.setOverlay(order[(order.indexOf(this.s.overlay) + 1) % order.length]);
    this.message(`Reference overlay: ${this.s.overlay}`);
  }

  _markOverlay() {
    for (const b of document.querySelectorAll('[data-overlay]')) b.classList.toggle('active', b.dataset.overlay === this.s.overlay);
  }

  _legend() {
    const m = this.s.trail.colorMode;
    const el = $('trail-legend');
    if (m === 'altitude') el.innerHTML = '<span class="grad alt"></span><span class="ticks"><i>0</i><i>5</i><i>10</i><i>15</i><i>25+ m</i></span>';
    else if (m === 'speed') el.innerHTML = '<span class="grad spd"></span><span class="ticks"><i>0</i><i>6</i><i>12+ m/s</i></span>';
    else if (m === 'mode') el.innerHTML = MODES.map((k) => `<span class="chip" data-m="${k}">${MODE_INFO[k].short}</span>`).join('');
    else el.innerHTML = '';
  }

  _renderStats() {
    const sim = this.sim;
    const sum = sim.flightSummary();
    $('flight-stats').innerHTML = statRows([
      ['Trail duration', formatDuration(sum.duration)],
      ['Distance flown', `${sum.dist.toFixed(0)} m`],
      ['Max height', `${sum.maxAlt.toFixed(1)} m`],
      ['Max speed', `${sum.maxSpeed.toFixed(1)} m/s`],
      ['Samples', sum.samples],
    ]);
    const ps = $('pattern-stats');
    if (sim.scenery && !sim.scenery.patterns) {
      ps.innerHTML = '<p class="note">Reference patterns and pattern scoring are on the RPTO Training Ground. The trail, captures and flight log work in every scene.</p>';
      return;
    }
    if (!sim.tracker) {
      ps.innerHTML = this.s.overlay === 'all' ? '<p class="note">Select a single pattern to see live deviation analysis.</p>' : '<p class="note">Select a reference pattern to overlay it and analyse the flown track against it.</p>';
      return;
    }
    const p = PATTERNS[this.s.overlay];
    const st = sim.tracker.stats();
    if (!st.samples) {
      ps.innerHTML = `<p class="note"><b>${p.name}</b>: ${p.detail}. Fly the pattern; samples within 8 m of the reference line are analysed.</p>`;
      return;
    }
    ps.innerHTML = statRows([
      ['Track RMS error', `${st.rms.toFixed(2)} m`],
      ['Max deviation', `${st.max.toFixed(2)} m`],
      ['Height', `${st.altMean.toFixed(1)} m &plusmn; ${st.altStd.toFixed(2)}`],
      ['Outside 4-15 m', `${st.altOutPct.toFixed(0)}%`],
      ['Coverage', `${(st.coverage * 100).toFixed(0)}%`],
      ['Avg speed', `${st.avgSpeed.toFixed(1)} m/s`],
    ]) + `<div class="score"><span>Pattern score</span><b>${st.score}</b><small>/100</small></div>`;
  }

  _renderCaptures() {
    const el = $('captures');
    el.innerHTML = this.sim.captures
      .slice(0, 6)
      .map((c) => `<a href="${c.url}" download="${esc(c.filename)}" title="${esc(c.filename)}"><img src="${c.thumb}" alt=""><span>${c.time.toLocaleTimeString()}</span></a>`)
      .join('');
  }

  // ------------------------------------------------------------ settings

  openSettings() {
    this._fillSettings();
    this.world.fillSettings();
    $('dlg-settings').showModal();
  }

  _settings() {
    const s = this.s;
    const sim = this.sim;
    const bind = (id, out, get, set, fmt) => {
      const el = $(id);
      const o = out ? $(out) : null;
      const sync = () => o && (o.textContent = fmt ? fmt(get()) : get());
      el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
        set(el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value);
        sync();
        this.save();
      });
      this._fillers ||= [];
      this._fillers.push(() => {
        if (el.type === 'checkbox') el.checked = get();
        else el.value = get();
        sync();
      });
    };
    bind('s-reg', null, () => s.registration, (v) => {
      s.registration = v.trim();
      $('st-reg').textContent = s.registration || '-';
      sim.drone.setRegistration(s.registration);
    });
    bind('s-pilot', null, () => s.pilotName, (v) => (s.pilotName = v));
    bind('s-instructor', null, () => s.instructorName, (v) => (s.instructorName = v));
    bind('s-org', null, () => s.organisation, (v) => (s.organisation = v));
    bind('s-tod', null, () => s.timeOfDay, (v) => {
      s.timeOfDay = v;
      sim.env.setTimeOfDay(v);
      $('tod-name').textContent = cap(v);
    });
    const wind = () => sim.wind.configure(s.wind);
    bind('s-wspd', 'o-wspd', () => s.wind.speed, (v) => { s.wind.speed = v; wind(); }, (v) => `${v.toFixed(1)} m/s (${(v * 1.944).toFixed(0)} kt)`);
    bind('s-wdir', 'o-wdir', () => s.wind.dirDeg, (v) => { s.wind.dirDeg = v; wind(); }, (v) => `${String(v).padStart(3, '0')}°`);
    bind('s-gust', 'o-gust', () => s.wind.gustiness, (v) => { s.wind.gustiness = v; wind(); }, (v) => `${Math.round(v * 100)}%`);
    bind('s-turb', null, () => s.wind.turbulence, (v) => { s.wind.turbulence = v; wind(); });
    bind('s-rtl', 'o-rtl', () => s.rtlAlt, (v) => { s.rtlAlt = v; sim.fc.params.rtlAlt = v; sim.refreshMissionPath(); }, (v) => `${v} m`);
    bind('s-drain', null, () => String(s.batteryDrain), (v) => (s.batteryDrain = Number(v)));
    bind('s-kb', 'o-kb', () => s.keyboardRate, (v) => { s.keyboardRate = v; sim.input.keyboardRate = v; }, (v) => `${v.toFixed(1)}x`);
    const fence = () => {
      sim.fenceVis.set(sim.fenceConfig, sim.fc.homeSet ? sim.fc.home : { x: 0, z: 0 });
      sim.refreshMissionPath();
    };
    bind('s-fence', null, () => s.fence.enabled, (v) => { s.fence.enabled = v; fence(); });
    bind('s-falt', 'o-falt', () => s.fence.maxAlt, (v) => { s.fence.maxAlt = v; fence(); }, (v) => `${v} m`);
    bind('s-frad', 'o-frad', () => s.fence.radius, (v) => { s.fence.radius = v; fence(); }, (v) => `${v} m`);
    if (IS_DEMO) {
      for (const id of ['s-fence', 's-falt', 's-frad']) $(id).disabled = true;
      $('fence-locked').hidden = false;
    }
    this._pidGrid();
    $('btn-pid-reset').onclick = () => {
      s.gains = JSON.parse(JSON.stringify(DEFAULT_GAINS));
      sim.fc.setGains(s.gains);
      this._pidGrid();
      this.save();
      this.message('PID gains restored to defaults');
    };
    $('c-drone').textContent = `${DRONE_X4.name} - ${DRONE_X4.description}`;
    const included = SCENES.filter((sc) => (SCENE_ACCESS[EDITION] || SCENE_ACCESS.base).includes(sc.id)).map((sc) => sc.name);
    $('c-scenery').textContent = included.join(', ');
    $('c-challenge').textContent = CHALLENGE.name;
    $('c-edition').textContent = IS_DEMO
      ? 'Demo version: flight operations are limited by a fixed geofence. Upgrade to the Base Edition to remove the limits.'
      : IS_PRO
        ? `Pro Edition: all ${SCENES.length} environments (training ground, city, forest, farmland, solar and substation), weather, payload camera with thermal mode and obstacle sensors.`
        : 'Base Edition: 1 drone, 1 training scenery and 1 structured challenge. Additional drones, environments and training modules are available as upgrades.';
  }

  _fillSettings() {
    for (const f of this._fillers || []) f();
  }

  _pidGrid() {
    const s = this.s;
    s.gains ||= JSON.parse(JSON.stringify(DEFAULT_GAINS));
    const g = s.gains;
    const rows = [
      ['Roll rate', g.rate.roll, ['p', 'i', 'd']],
      ['Pitch rate', g.rate.pitch, ['p', 'i', 'd']],
      ['Yaw rate', g.rate.yaw, ['p', 'i', 'd']],
    ];
    const el = $('pid-grid');
    el.innerHTML = '<span></span><b>P</b><b>I</b><b>D</b>';
    for (const [name, obj, keys] of rows) {
      el.insertAdjacentHTML('beforeend', `<span>${name}</span>`);
      for (const k of keys) {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = k === 'd' ? '0.05' : '0.5';
        inp.min = '0';
        inp.value = obj[k];
        inp.onchange = () => {
          obj[k] = Math.max(0, Number(inp.value) || 0);
          this.sim.fc.setGains(g);
          this.save();
        };
        el.appendChild(inp);
      }
    }
    el.insertAdjacentHTML('beforeend', '<span>Angle P</span>');
    for (const k of ['roll', 'pitch', 'yaw']) {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = '0.5';
      inp.min = '0';
      inp.value = g.angle[k];
      inp.title = `Angle P ${k}`;
      inp.onchange = () => {
        g.angle[k] = Math.max(0, Number(inp.value) || 0);
        this.sim.fc.setGains(g);
        this.save();
      };
      el.appendChild(inp);
    }
  }

  // ------------------------------------------------------------ challenge

  _challenge() {
    $('ch-abort').onclick = () => {
      this.sim.challenge.abort();
    };
  }

  openChallenge() {
    this._renderChallengeDialog();
    $('dlg-challenge').showModal();
  }

  _renderChallengeDialog() {
    const ch = this.sim.challenge;
    const body = $('chd-body');
    if (ch.finished && !ch.active) {
      const rows = ch.results.map((r) => `<tr class="${r.status}"><td>${esc(r.title)}</td><td>${r.status === 'done' ? `${r.score}` : r.status}</td><td>${r.time ? formatDuration(r.time) : '-'}</td><td>${r.notes.map(esc).join('<br>')}</td></tr>`).join('');
      const pens = ch.penalties.map((p) => `<li>${esc(p.reason)} (-${p.points})</li>`).join('');
      body.innerHTML = `
        <div class="result ${ch.passed ? 'pass' : 'fail'}"><b>${ch.passed ? 'PASSED' : 'NOT PASSED'}</b><span>${ch.totalScore ?? 0}/100</span><small>${esc(ch.failReason || `Pass mark ${CHALLENGE.passMark}`)}</small></div>
        <table class="res"><thead><tr><th>Stage</th><th>Score</th><th>Time</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>
        ${pens ? `<p class="note">Penalties:</p><ul class="note">${pens}</ul>` : ''}
        <p class="note">Total time ${formatDuration(ch.elapsed)}. Trainee: ${esc(this.s.pilotName || '-')}, UIN ${esc(this.s.registration || '-')}.</p>
        <div class="row wrap"><button type="button" id="chd-cap" class="primary">Capture overhead trail</button><button type="button" id="chd-log">Export flight log</button><button type="button" id="chd-again">Start again</button></div>`;
      $('chd-cap').onclick = () => this.sim.capture('overhead');
      $('chd-log').onclick = () => this.sim.exportLog();
      $('chd-again').onclick = () => this._startChallenge();
      return;
    }
    if (ch.active) {
      body.innerHTML = `<p>Challenge in progress: <b>${esc(ch.step.title)}</b></p><div class="row"><button type="button" id="chd-abort">Abort challenge</button></div>`;
      $('chd-abort').onclick = () => ch.abort();
      return;
    }
    body.innerHTML = `
      <p>${esc(CHALLENGE.summary)}</p>
      <ol class="steps">${CHALLENGE.steps.map((s) => `<li><b>${esc(s.title)}</b><br><span>${esc(s.instr)}</span></li>`).join('')}</ol>
      <p class="note">Each stage is scored 0-100 on accuracy (track RMS error against the reference pattern, height stability, coverage, landing accuracy). A crash ends the challenge. Pass mark: ${CHALLENGE.passMark}.</p>
      <label class="chk"><input type="checkbox" id="chd-manual" checked> Manual modes only (Stabilize, Alt Hold, Acro). GPS-assisted stages are capped at 50.</label>
      <div class="row"><button type="button" class="primary" id="chd-start">Start challenge</button></div>`;
    $('chd-start').onclick = () => this._startChallenge();
  }

  async _startChallenge() {
    const manual = $('chd-manual') ? $('chd-manual').checked : true;
    const sim = this.sim;
    if (sim.fc.armed) {
      this.message('Land and disarm before starting the challenge', 'warn');
      return;
    }
    // The challenge patterns are painted on the training ground.
    if (sim.sceneId !== 'training') {
      $('dlg-challenge').close();
      await sim.loadScene('training');
      this.save();
    }
    sim.resetDrone();
    sim.clearTrail();
    sim.logRows.length = 0;
    sim.challenge.start(manual);
    $('dlg-challenge').close();
    this.message(`${CHALLENGE.name} started`, 'good');
  }

  _challengeChanged() {
    const ch = this.sim.challenge;
    $('challenge-hud').hidden = !ch.active;
    if (ch.active) {
      $('ch-step').textContent = `Stage ${ch.index + 1}/${CHALLENGE.steps.length}`;
      $('ch-title').textContent = ch.step.title;
      $('ch-instr').textContent = ch.step.instr;
      if (ch.step.pattern && this.s.overlay !== ch.step.pattern) this.setOverlay(ch.step.pattern);
      const prev = ch.results[ch.index - 1];
      if (prev && prev.status === 'done') this.message(`Stage complete: ${prev.title} - ${prev.score}/100`, 'good');
    }
    if (ch.finished) {
      this.message(ch.passed ? `Challenge PASSED (${ch.totalScore}/100)` : `Challenge not passed: ${ch.failReason}`, ch.passed ? 'good' : 'crit');
      this.openChallenge();
    }
  }

  _challengeHud() {
    const ch = this.sim.challenge;
    if (!ch.active) return;
    $('ch-time').textContent = formatDuration(ch.elapsed);
    const live = ch.liveInfo();
    $('ch-bar').style.width = `${Math.round((live?.frac || 0) * 100)}%`;
    $('ch-live').textContent = live ? `${live.label}: ${live.value}${live.extra ? `  |  ${live.extra}` : ''}` : '';
  }

  // ------------------------------------------------------------ help

  _help() {
    $('help-body').innerHTML = helpHtml();
  }

  // ------------------------------------------------------------ keyboard

  _keys() {
    const sim = this.sim;
    sim.input.on('key', (e) => {
      if (document.querySelector('dialog[open]')) return;
      const k = e.code;
      if (this.world.handleKey(e)) return;
      if (k === 'Enter') sim.toggleArm('key');
      else if (/^Digit[1-7]$/.test(k)) sim.setMode(MODES[Number(k.slice(5)) - 1]);
      else if (k === 'KeyM') this.planner.open();
      else if (k === 'KeyC') sim.cycleView();
      else if (k === 'KeyV') {
        if (sim.cameras.view === 'overhead') sim.setView(this.prevView === 'overhead' ? 'pilot' : this.prevView);
        else {
          this.prevView = sim.cameras.view;
          sim.setView('overhead');
        }
      } else if (k === 'KeyN') this.cycleTimeOfDay();
      else if (k === 'KeyT') sim.clearTrail();
      else if (k === 'KeyY') {
        this.s.trail.visible = !this.s.trail.visible;
        sim.trail.setVisible(this.s.trail.visible);
        $('trail-visible').checked = this.s.trail.visible;
        this.save();
      } else if (k === 'KeyP') sim.capture(e.shiftKey ? 'overhead' : 'view');
      else if (k === 'KeyO') this.cycleOverlay();
      else if (k === 'KeyR') sim.resetDrone();
      else if (k === 'Space') sim.togglePause();
      else if (k === 'KeyX') {
        const now = performance.now();
        if (now - this.estopArmed < 1000) sim.emergencyStop();
        else if (sim.fc.armed) this.message('Press X again within 1 s for EMERGENCY STOP', 'warn');
        this.estopArmed = now;
      } else if (k === 'KeyE') sim.input.setThrottleKeyboard(0.5);
      else if (k === 'KeyQ') sim.input.setThrottleKeyboard(0);
      else if (k === 'KeyZ') {
        sim.cameras.pilot.auto = !sim.cameras.pilot.auto;
        this.message(`Pilot view auto-zoom ${sim.cameras.pilot.auto ? 'on' : 'off'}`);
      } else if (k === 'KeyF') {
        sim.cameras.overhead.follow = !sim.cameras.overhead.follow;
        this.message(`Overhead view ${sim.cameras.overhead.follow ? 'follows the drone' : 'fixed'}`);
      } else if (k === 'KeyH' || k === 'F1') $('dlg-help').showModal();
      else if (k === 'KeyU') document.body.classList.toggle('clean');
    });
  }

  _controllerEvents() {
    const sim = this.sim;
    const input = sim.input;
    input.on('action', ({ action }) => {
      if (action === 'arm') sim.toggleArm('controller');
      else if (action === 'rtl') sim.setMode('RTL');
      else if (action === 'modeNext') sim.cycleMode(1);
      else if (action === 'modePrev') sim.cycleMode(-1);
      else if (action === 'capture') sim.capture('overhead');
      else if (action === 'view') sim.cycleView();
      else if (action === 'clearTrail') sim.clearTrail();
    });
    input.on('switch', ({ name, pos, first, sw }) => {
      if (name === 'mode') {
        const modes = sw.modes || ['STABILIZE', 'ALT_HOLD', 'LOITER'];
        const m = modes[pos] || modes[0];
        if (!(input.switchState.rtl === 1)) sim.setMode(m);
      } else if (name === 'arm') {
        if (first) {
          if (pos === 1) this.message('Arm switch is ON at start-up: cycle it OFF then ON to arm', 'warn');
          return;
        }
        if (pos === 1) sim.fc.arm('switch');
        else sim.fc.requestDisarm('switch');
      } else if (name === 'rtl') {
        if (first && pos === 0) return;
        if (pos === 1) sim.setMode('RTL');
        else {
          const ms = input.mapping.switches.mode;
          const modes = ms?.modes || ['STABILIZE', 'ALT_HOLD', 'LOITER'];
          sim.setMode(ms ? modes[input.switchState.mode] || 'STABILIZE' : 'LOITER');
        }
      }
    });
    input.on('padconnect', (p) => this.message(`Controller connected: ${p.id.slice(0, 48)}`, 'good'));
    input.on('paddisconnect', (p) => this.message(`Controller disconnected: ${p.id.slice(0, 48)}`, 'crit'));
    input.on('padrestore', () => this.message('Controller reconnected', 'good'));
    input.on('padselect', () => this.controllerPanel.refresh());
  }

  // ------------------------------------------------------------ frame

  frame(dt) {
    this.hud.update(dt);
    this.world.frame(dt);
    this.statsTimer += dt;
    if (this.statsTimer > 0.5) {
      this.statsTimer = 0;
      this._renderStats();
      if (this.sim.cameras.view === 'overhead') this._overheadScale();
    }
    this._challengeHud();
    this.controllerPanel.frame();
  }

  _overheadScale() {
    const mpp = this.sim.cameras.metresPerPixel(window.innerHeight);
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200];
    let m = 1;
    for (const s of steps) if (s / mpp <= 180) m = s;
    document.querySelector('#overhead-scale .bar i').style.width = `${m / mpp}px`;
    $('os-label').textContent = `${m} m`;
  }
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function statRows(rows) {
  return rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
}
