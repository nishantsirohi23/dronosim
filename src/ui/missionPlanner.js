import { PATTERN_LIST } from '../world/patterns.js';
import { FIELD } from '../world/scenery.js';
import {
  ITEM_TYPES, ITEM_TYPE_LIST, MISSION_DEFAULTS, MISSION_LIMITS, cloneMission, createMission, missionFromJSON, missionPath, missionToJSON, normalizeItem,
  patternMission, surveyMission, validateMission,
} from '../fc/mission.js';
import { downloadText } from '../assess/capture.js';
import { clamp, formatDuration, timestampForFile } from '../util/math.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const HIT_PX = 11;
const hasPos = (it) => it.x !== undefined && it.x !== null;

// Ground-station style mission planner: top-down 2D map of the training field, click to add
// waypoints, drag to move, per-item height / speed / hold, templates, survey grid, JSON
// import / export and upload to the flight controller.
export class MissionPlanner {
  constructor(sim, ui) {
    this.sim = sim;
    this.ui = ui;
    this.dlg = $('dlg-mission');
    this.canvas = $('mp-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.draft = sim.fc.mission ? cloneMission(sim.fc.mission) : createMission('New mission');
    this.sel = -1;
    this.tool = 'add';
    this.undoStack = [];
    this.view = null;
    this.drag = null;
    this.hover = '';
    this.cursor = null;
    this.surveyRect = null;
    this.defaults = { alt: MISSION_DEFAULTS.alt, speed: MISSION_DEFAULTS.speed, spacing: 10, axis: 'ew' };
    this.derived = null;
    this.raf = 0;
    this._bind();
  }

  // ------------------------------------------------------------ open / close

  open() {
    if (!this.touched) this.draft = this.sim.fc.mission ? cloneMission(this.sim.fc.mission) : this.draft;
    $('mp-show3d').checked = this.sim.settings.missionPath3d !== false;
    this.dlg.showModal();
    this._resize();
    if (!this.view) this._fit();
    this._setTool(this.tool);
    this._renderAll();
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.dlg.open) return;
      this._draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  _resize() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = c.clientWidth || 600;
    this.h = c.clientHeight || 400;
    c.width = Math.round(this.w * dpr);
    c.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _fit() {
    const sc = this.sim.scenery;
    if (!sc || sc.patterns) {
      const cx = (FIELD.minX + FIELD.maxX) / 2;
      const cz = (FIELD.minZ + FIELD.maxZ) / 2;
      const k = Math.min(this.w / (FIELD.maxX - FIELD.minX + 20), this.h / (FIELD.maxZ - FIELD.minZ + 20));
      this.view = { cx, cz, k };
      return;
    }
    const e = Math.min(sc.mapExtent || 150, 220);
    this.view = { cx: 0, cz: -e * 0.25, k: Math.min(this.w, this.h) / (e * 1.4) };
  }

  // Called when the simulator switches scene.
  resetView() {
    this.view = null;
  }

  // ------------------------------------------------------------ events

  _bind() {
    const d = this.defaults;
    $('mp-alt').value = d.alt;
    $('mp-speed').value = d.speed;
    $('mp-spacing').value = d.spacing;
    $('mp-axis').value = d.axis;
    // Enter in a number field would submit the dialog form and close it.
    this.dlg.querySelector('form').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        e.target.blur();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        this._undo();
      }
    });
    this.dlg.addEventListener('close', () => cancelAnimationFrame(this.raf));
    window.addEventListener('resize', () => this.dlg.open && this._resize());

    for (const b of document.querySelectorAll('#mp-tool [data-tool]')) b.onclick = () => this._setTool(b.dataset.tool);
    const num = (id, key, lo, hi) => {
      $(id).onchange = () => {
        const v = clamp(Number($(id).value) || d[key], lo, hi);
        d[key] = v;
        $(id).value = v;
        if (key === 'spacing' && this.surveyRect) this._survey(this.surveyRect, true);
      };
    };
    num('mp-alt', 'alt', MISSION_LIMITS.alt[0], MISSION_LIMITS.alt[1]);
    num('mp-speed', 'speed', MISSION_LIMITS.speed[0], MISSION_LIMITS.speed[1]);
    num('mp-spacing', 'spacing', 2, 100);
    $('mp-axis').onchange = () => {
      d.axis = $('mp-axis').value;
      if (this.surveyRect) this._survey(this.surveyRect, true);
    };
    $('mp-apply').onclick = () => this._applyToAll();
    $('mp-template').onchange = (e) => {
      const id = e.target.value;
      e.target.value = '';
      if (!id) return;
      this._replace(patternMission(id, { alt: d.alt, speed: d.speed }), `Template applied: ${PATTERN_LIST.find((p) => p.id === id).name}`);
    };
    $('mp-name').oninput = (e) => {
      this.draft.name = e.target.value.slice(0, 60);
      this._touch();
      this._status();
    };
    for (const b of document.querySelectorAll('[data-add]')) b.onclick = () => this._insert(b.dataset.add);
    $('mp-undo').onclick = () => this._undo();
    $('mp-clear').onclick = () => this._replace(createMission(this.draft.name || 'New mission'), 'Plan cleared');
    $('mp-download').onclick = () => {
      if (!this.sim.fc.mission) return this._note('No mission on the drone', 'warn');
      this._replace(cloneMission(this.sim.fc.mission), 'Loaded the mission from the drone');
    };
    $('mp-export').onclick = () => this._export();
    $('mp-import').onclick = () => $('mp-file').click();
    $('mp-file').onchange = (e) => this._import(e.target.files[0]);
    $('mp-upload').onclick = () => this._upload();
    $('mp-show3d').onchange = (e) => {
      this.sim.settings.missionPath3d = e.target.checked;
      this.sim.missionPath.setEnabled(e.target.checked);
      this.ui.save();
    };

    const list = $('mp-items');
    list.addEventListener('change', (e) => {
      const row = e.target.closest('[data-i]');
      if (!row || !e.target.dataset.f) return;
      const i = Number(row.dataset.i);
      if (e.target.dataset.f === 'type') this._convert(i, e.target.value);
      else this._setField(i, e.target.dataset.f, e.target.value, e.target);
    });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-i]');
      if (!row) return;
      const i = Number(row.dataset.i);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'del') this._delete(i);
      else if (act === 'up') this._move(i, -1);
      else if (act === 'down') this._move(i, 1);
      else if (this.sel !== i && !e.target.closest('input, select')) this._select(i, true);
    });

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._moveEvt(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', () => (this.drag = null));
    c.addEventListener('pointerleave', () => {
      this.cursor = null;
      this.hover = '';
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [px, py] = this._local(e);
      const [wx, wz] = this._toWorld(px, py);
      const v = this.view;
      v.k = clamp(v.k * Math.exp(-e.deltaY * 0.0015), 0.4, 40);
      v.cx = wx - (px - this.w / 2) / v.k;
      v.cz = wz - (py - this.h / 2) / v.k;
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      if (!this._hit(...this._local(e)).length) this._fit();
    });
    c.addEventListener('keydown', (e) => {
      // Keep flight keys from reaching the simulator while the map has focus.
      if (e.key !== 'Escape') e.stopPropagation();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this._undo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel >= 0) {
        e.preventDefault();
        this._delete(this.sel);
      }
    });
  }

  _setTool(t) {
    this.tool = t;
    for (const b of document.querySelectorAll('#mp-tool [data-tool]')) b.classList.toggle('active', b.dataset.tool === t);
    $('mp-survey').hidden = t !== 'survey';
    $('mp-hint').textContent = t === 'survey'
      ? 'Drag a rectangle to survey it. Right-drag or Shift-drag pans, wheel zooms.'
      : 'Click to add a waypoint after the selected item. Drag a marker to move it, drag the map to pan, wheel to zoom, double-click to reset.';
  }

  // ------------------------------------------------------------ coordinates

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _toScreen(x, z) {
    const v = this.view;
    return [(x - v.cx) * v.k + this.w / 2, (z - v.cz) * v.k + this.h / 2];
  }

  _toWorld(px, py) {
    const v = this.view;
    return [(px - this.w / 2) / v.k + v.cx, (py - this.h / 2) / v.k + v.cz];
  }

  _markers() {
    return this.derived ? this.derived.path.markers : [];
  }

  // Marker hits under a screen point, nearest first (item indices).
  _hit(px, py) {
    const out = [];
    for (const m of this._markers()) {
      const [sx, sy] = this._toScreen(m.x, m.z);
      const d = Math.hypot(sx - px, sy - py);
      if (d <= HIT_PX && hasPos(this.draft.items[m.item] || {})) out.push([d, m.item]);
    }
    return out.sort((a, b) => a[0] - b[0]).map((h) => h[1]);
  }

  // ------------------------------------------------------------ map interaction

  _down(e) {
    this.canvas.focus();
    this.canvas.setPointerCapture(e.pointerId);
    const [px, py] = this._local(e);
    const pan = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey);
    const hits = pan ? [] : this._hit(px, py);
    if (hits.length) {
      const i = hits.includes(this.sel) ? this.sel : hits[0];
      this._select(i, true);
      this.drag = { kind: 'move', i, px, py, moved: false };
    } else if (!pan && this.tool === 'survey' && e.button === 0) {
      const [x, z] = this._toWorld(px, py);
      this.drag = { kind: 'rect', rect: { x0: x, z0: z, x1: x, z1: z } };
    } else {
      this.drag = { kind: 'pan', px, py, lx: px, ly: py, moved: false, add: !pan && e.button === 0 };
    }
  }

  _moveEvt(e) {
    const [px, py] = this._local(e);
    this.cursor = this._toWorld(px, py);
    const d = this.drag;
    if (!d) {
      const hit = this._hit(px, py).length > 0;
      this.canvas.style.cursor = hit ? 'move' : this.tool === 'survey' ? 'crosshair' : 'copy';
      this.hover = hit ? '' : this._obstacleAt(...this.cursor);
      return;
    }
    if (d.kind === 'move') {
      if (!d.moved && Math.hypot(px - d.px, py - d.py) < 3) return;
      if (!d.moved) this._pushUndo();
      d.moved = true;
      const it = this.draft.items[d.i];
      const [x, z] = this.cursor;
      it.x = Math.round(x * 10) / 10;
      it.z = Math.round(z * 10) / 10;
      this._touch();
      this._derive(true);
      const pos = $('mp-items').querySelector(`[data-i="${d.i}"] .mp-pos`);
      if (pos) pos.textContent = posText(it);
    } else if (d.kind === 'rect') {
      d.rect.x1 = this.cursor[0];
      d.rect.z1 = this.cursor[1];
    } else {
      if (!d.moved && Math.hypot(px - d.px, py - d.py) < 4) return;
      d.moved = true;
      this.view.cx -= (px - d.lx) / this.view.k;
      this.view.cz -= (py - d.ly) / this.view.k;
      d.lx = px;
      d.ly = py;
    }
  }

  _up(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'move' && d.moved) this._renderAll();
    else if (d.kind === 'rect') {
      const r = d.rect;
      if (Math.abs(r.x1 - r.x0) >= 2 && Math.abs(r.z1 - r.z0) >= 2) this._survey(r);
    } else if (d.kind === 'pan' && !d.moved && d.add && this.tool === 'add') {
      const [x, z] = this._toWorld(...this._local(e));
      this._addWaypoint(x, z);
    }
  }

  _obstacleAt(x, z) {
    for (const o of this.sim.scenery ? this.sim.scenery.obstacles : []) {
      if (o.type === 'seg') continue;
      const inside = o.type === 'box' ? x >= o.minX && x <= o.maxX && z >= o.minZ && z <= o.maxZ : Math.hypot(x - o.x, z - o.z) <= Math.max(o.r, 0.8);
      if (inside) return `${o.name}: ${o.h.toFixed(1)} m tall`;
    }
    return '';
  }

  // ------------------------------------------------------------ editing

  _pushUndo() {
    this.undoStack.push(JSON.stringify(this.draft));
    if (this.undoStack.length > 60) this.undoStack.shift();
  }

  _undo() {
    const s = this.undoStack.pop();
    if (!s) return this._note('Nothing to undo');
    this.draft = JSON.parse(s);
    this.sel = Math.min(this.sel, this.draft.items.length - 1);
    this._touch();
    this._renderAll();
  }

  _touch() {
    this.touched = true;
  }

  _replace(mission, note) {
    this._pushUndo();
    this.draft = mission;
    this.sel = -1;
    this._touch();
    this._renderAll();
    if (note) this._note(note, 'good');
  }

  _select(i, scroll) {
    this.sel = i;
    this._renderList();
    if (scroll) $('mp-items').querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  _wp(x, z) {
    const d = this.defaults;
    return normalizeItem({ type: 'WAYPOINT', x, z, alt: d.alt, speed: d.speed, hold: 0 });
  }

  _insertIndex() {
    const items = this.draft.items;
    if (this.sel >= 0 && this.sel < items.length) {
      const t = items[this.sel].type;
      return t === 'RTL' || t === 'LAND' ? this.sel : this.sel + 1;
    }
    let at = items.length;
    while (at > 0 && (items[at - 1].type === 'RTL' || items[at - 1].type === 'LAND')) at--;
    return at;
  }

  _addWaypoint(x, z) {
    this._pushUndo();
    const items = this.draft.items;
    if (!items.length) {
      items.push({ type: 'TAKEOFF', alt: this.defaults.alt }, this._wp(x, z), { type: 'RTL' });
      this.sel = 1;
    } else {
      const at = this._insertIndex();
      items.splice(at, 0, this._wp(x, z));
      this.sel = at;
    }
    this._touch();
    this._renderAll();
    $('mp-items').querySelector(`[data-i="${this.sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  _insert(type) {
    const items = this.draft.items;
    let at = this.sel >= 0 ? this.sel + 1 : items.length;
    if (type === 'TAKEOFF' && this.sel < 0) at = 0;
    if ((type === 'LOITER_TIME' || type === 'LAND') && this.sel < 0) at = this._insertIndex();
    this._pushUndo();
    const it = type === 'TAKEOFF' ? { type, alt: this.defaults.alt } : type === 'LOITER_TIME' ? { type, time: MISSION_DEFAULTS.loiterTime } : { type };
    items.splice(at, 0, normalizeItem(it, at));
    this.sel = at;
    this._touch();
    this._renderAll();
  }

  _delete(i) {
    this._pushUndo();
    this.draft.items.splice(i, 1);
    this.sel = Math.min(i, this.draft.items.length - 1);
    if (this.sel < 0) this.sel = -1;
    this._touch();
    this._renderAll();
  }

  _move(i, dir) {
    const items = this.draft.items;
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    this._pushUndo();
    [items[i], items[j]] = [items[j], items[i]];
    this.sel = j;
    this._touch();
    this._renderAll();
  }

  _setField(i, f, value, input) {
    const it = { ...this.draft.items[i] };
    const v = Number(value);
    if (f === 'n') it.z = -v;
    else if (f === 'e') it.x = v;
    else it[f] = v;
    try {
      const clean = normalizeItem(it, i);
      this._pushUndo();
      this.draft.items[i] = clean;
    } catch (err) {
      this._note(err.message, 'crit');
    }
    const cur = this.draft.items[i];
    if (input) input.value = f === 'n' ? -cur.z : f === 'e' ? cur.x : cur[f];
    const pos = $('mp-items').querySelector(`[data-i="${i}"] .mp-pos`);
    if (pos) pos.textContent = posText(cur);
    this._touch();
    this._derive();
  }

  // Change an item's command, keeping position / height where they still apply.
  _convert(i, type) {
    const it = this.draft.items[i];
    const d = this.defaults;
    let pos = hasPos(it) ? { x: it.x, z: it.z } : null;
    if (!pos && type === 'WAYPOINT') {
      const prev = this.derived?.path.points.filter((p) => p.item < i && p.item >= 0).pop();
      pos = prev ? { x: prev.x + 5, z: prev.z } : { x: this.view.cx, z: this.view.cz };
    }
    const alt = it.alt ?? d.alt;
    const next = {
      TAKEOFF: { type, alt },
      WAYPOINT: { type, ...pos, alt, speed: it.speed ?? d.speed, hold: it.hold ?? 0 },
      LOITER_TIME: { type, x: pos?.x ?? null, z: pos?.z ?? null, alt: pos ? alt : null, time: it.time ?? (it.hold || MISSION_DEFAULTS.loiterTime) },
      RTL: { type },
      LAND: { type, x: pos?.x ?? null, z: pos?.z ?? null },
    }[type];
    this._pushUndo();
    this.draft.items[i] = normalizeItem(next, i);
    this._touch();
    this._renderAll();
  }

  _applyToAll() {
    const { alt, speed } = this.defaults;
    this._pushUndo();
    for (const it of this.draft.items) {
      if (it.type === 'WAYPOINT') {
        it.alt = alt;
        it.speed = speed;
      } else if (it.type === 'TAKEOFF' || (it.type === 'LOITER_TIME' && hasPos(it))) it.alt = alt;
    }
    this._touch();
    this._renderAll();
    this._note(`Height ${alt} m and speed ${speed} m/s applied to every waypoint`, 'good');
  }

  _survey(rect, regenerate = false) {
    const d = this.defaults;
    try {
      const m = surveyMission(rect, { spacing: d.spacing, alt: d.alt, speed: d.speed, axis: d.axis, home: this.sim.missionHome });
      this.surveyRect = rect;
      if (regenerate) {
        this.draft = m;
        this._touch();
        this._renderAll();
      } else this._replace(m, `Survey grid: ${m.items.length - 2} waypoints`);
    } catch (err) {
      this._note(err.message, 'crit');
    }
  }

  // ------------------------------------------------------------ files and upload

  _export() {
    const name = (this.draft.name || 'mission').replace(/[^A-Za-z0-9_-]+/g, '-');
    downloadText(missionToJSON(this.draft), `DronoSim_mission_${name}_${timestampForFile()}.json`, 'application/json');
    this._note('Mission exported as JSON', 'good');
  }

  _import(file) {
    if (!file) return;
    file.text().then((text) => {
      try {
        const m = missionFromJSON(text);
        this._replace(m, `Imported "${m.name}" (${m.items.length} items). Upload it to fly it.`);
      } catch (err) {
        this._note(`Import failed: ${err.message}`, 'crit');
      }
    }).finally(() => ($('mp-file').value = ''));
  }

  _opts() {
    const sim = this.sim;
    return { home: sim.missionHome, rtlAlt: sim.fc.params.rtlAlt, fence: sim.fenceConfig, obstacles: sim.scenery ? sim.scenery.obstacles : [], groundHeight: sim.scenery ? sim.scenery.groundHeight : null };
  }

  _upload() {
    const sim = this.sim;
    if (!this.draft.items.length) {
      if (!sim.fc.mission) return this._note('Nothing to upload: add waypoints or choose a template', 'warn');
      sim.setMission(null);
      this.ui.save();
      this.ui.message('Mission cleared from the drone', 'warn');
      this._status();
      return;
    }
    const v = validateMission(this.draft, this._opts());
    if (v.errors.length) return this._note(`Upload refused: ${v.errors.join('; ')}`, 'crit');
    sim.setMission(cloneMission(this.draft));
    this.ui.save();
    const hint = sim.fc.mode === 'AUTO' ? '' : sim.fc.armed ? '. Select Auto (7) to fly it' : '. Arm in Loiter, then select Auto (7)';
    this.ui.message(`Mission uploaded: ${this.draft.items.length} items${hint}`, 'good');
    this._note(`Uploaded ${this.draft.items.length} items${v.warnings.length ? ` with ${v.warnings.length} warning(s)` : ''}`, 'good');
  }

  // ------------------------------------------------------------ rendering (DOM)

  _note(text, level = '') {
    const el = $('mp-status');
    el.textContent = text;
    el.dataset.level = level;
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => this._status(), 5000);
  }

  _status() {
    const fc = this.sim.fc;
    const el = $('mp-status');
    el.dataset.level = '';
    if (!fc.mission) el.textContent = 'No mission on the drone';
    else if (JSON.stringify(fc.mission.items) === JSON.stringify(this.draft.items)) el.textContent = `On the drone: ${fc.mission.items.length} items (matches this plan)`;
    else {
      el.textContent = 'Plan differs from the mission on the drone: upload to apply';
      el.dataset.level = 'warn';
    }
  }

  _renderAll() {
    $('mp-name').value = this.draft.name || '';
    this._renderList();
    this._derive();
    this._status();
  }

  _renderList() {
    const items = this.draft.items;
    const fc = this.sim.fc;
    const live = fc.mission && fc.armed && JSON.stringify(fc.mission.items) === JSON.stringify(items) ? fc.auto.index : -1;
    const el = $('mp-items');
    if (!items.length) {
      el.innerHTML = '<p class="note mp-empty">Click the map to add waypoints (a takeoff and RTL are added for you), choose a template, or drag a survey area.</p>';
      return;
    }
    el.innerHTML = items.map((it, i) => {
      const opts = ITEM_TYPE_LIST.map((t) => `<option value="${t}"${t === it.type ? ' selected' : ''}>${ITEM_TYPES[t].label}</option>`).join('');
      const f = (key, label, unit, value, min, max, step) => `<label class="mp-f">${label}<input type="number" data-f="${key}" value="${value}" min="${min}" max="${max}" step="${step}">${unit}</label>`;
      const L = MISSION_LIMITS;
      const fields = [];
      if (it.type === 'TAKEOFF') fields.push(f('alt', 'Height', 'm', it.alt, L.alt[0], L.alt[1], 1));
      if (it.type === 'WAYPOINT') {
        fields.push(f('alt', 'Height', 'm', it.alt, L.alt[0], L.alt[1], 1), f('speed', 'Speed', 'm/s', it.speed, L.speed[0], L.speed[1], 0.5), f('hold', 'Hold', 's', it.hold, 0, L.hold[1], 1));
      }
      if (it.type === 'LOITER_TIME') {
        if (hasPos(it)) fields.push(f('alt', 'Height', 'm', it.alt ?? this.defaults.alt, L.alt[0], L.alt[1], 1));
        fields.push(f('time', 'Time', 's', it.time, 1, L.hold[1], 1));
      }
      if (i === this.sel && hasPos(it)) fields.push(f('n', 'N', 'm', -it.z, -L.pos, L.pos, 0.5), f('e', 'E', 'm', it.x, -L.pos, L.pos, 0.5));
      const cls = `mp-row${i === this.sel ? ' sel' : ''}${i === live ? ' live' : ''}`;
      return `<div class="${cls}" data-i="${i}">
        <div class="mp-l1"><span class="mp-n">${i + 1}</span><select data-f="type" aria-label="Command">${opts}</select><span class="mp-pos">${esc(posText(it))}</span>
        <span class="mp-acts"><button type="button" data-act="up" title="Move up">&#8593;</button><button type="button" data-act="down" title="Move down">&#8595;</button><button type="button" data-act="del" title="Delete">&#215;</button></span></div>
        ${fields.length ? `<div class="mp-l2">${fields.join('')}</div>` : ''}
      </div>`;
    }).join('');
  }

  // Path, estimates and planning checks; `light` skips the DOM lists while dragging.
  _derive(light = false) {
    const opts = this._opts();
    if (light) {
      this.derived = { ...this.derived, path: missionPath(this.draft, opts) };
      clearTimeout(this.deriveTimer);
      this.deriveTimer = setTimeout(() => this._derive(), 150);
      return;
    }
    const v = validateMission(this.draft, opts);
    const path = v.path || missionPath(this.draft, opts);
    this.derived = { path, v };
    const wps = this.draft.items.filter((it) => it.type === 'WAYPOINT').length;
    $('mp-summary').innerHTML = this.draft.items.length
      ? [
        ['Items / waypoints', `${this.draft.items.length} / ${wps}`],
        ['Planned distance', `${path.distance.toFixed(0)} m`],
        ['Estimated flight time', formatDuration(path.time)],
      ].map(([k, val]) => `<div><span>${k}</span><b>${val}</b></div>`).join('')
      : '';
    const issues = this.draft.items.length ? [...v.errors.map((t) => ['err', t]), ...v.warnings.map((t) => ['warn', t])] : [];
    if (this.draft.items.length && !issues.length) issues.push(['ok', 'Plan checks passed']);
    $('mp-issues').innerHTML = issues.map(([c, t]) => `<li class="${c}">${esc(t)}</li>`).join('');
  }

  // ------------------------------------------------------------ rendering (map)

  _draw() {
    const g = this.ctx;
    const { w, h } = this;
    const v = this.view;
    const S = (x, z) => this._toScreen(x, z);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#1a2b1b';
    g.fillRect(0, 0, w, h);
    // Ground features: the training field, or the scene's own map painter.
    const sc = this.sim.scenery;
    if (!sc || sc.patterns) {
      const [fx0, fz0] = S(FIELD.minX, FIELD.minZ);
      const [fx1, fz1] = S(FIELD.maxX, FIELD.maxZ);
      g.fillStyle = '#2b4628';
      g.fillRect(fx0, fz0, fx1 - fx0, fz1 - fz0);
    } else if (sc.mapPaint) {
      g.save();
      try {
        sc.mapPaint(g, S, 1 / v.k);
      } catch {
        /* a scene's map painter is optional */
      }
      g.restore();
    }
    // Grid: 10 m, 50 m major
    const step = v.k * 10 >= 14 ? 10 : 50;
    const [wx0, wz0] = this._toWorld(0, 0);
    const [wx1, wz1] = this._toWorld(w, h);
    g.lineWidth = 1;
    for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) {
      g.strokeStyle = x % 50 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
      const sx = Math.round(S(x, 0)[0]) + 0.5;
      g.beginPath();
      g.moveTo(sx, 0);
      g.lineTo(sx, h);
      g.stroke();
    }
    for (let z = Math.ceil(wz0 / step) * step; z <= wz1; z += step) {
      g.strokeStyle = z % 50 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
      const sy = Math.round(S(0, z)[1]) + 0.5;
      g.beginPath();
      g.moveTo(0, sy);
      g.lineTo(w, sy);
      g.stroke();
    }
    // Reference patterns (training ground only)
    g.setLineDash([6, 4]);
    g.lineWidth = 1.5;
    for (const p of !sc || sc.patterns ? PATTERN_LIST : []) {
      g.strokeStyle = `#${p.color.toString(16).padStart(6, '0')}99`;
      g.beginPath();
      p.points.forEach(([x, z], i) => (i ? g.lineTo(...S(x, z)) : g.moveTo(...S(x, z))));
      g.closePath();
      g.stroke();
    }
    g.setLineDash([]);
    // Obstacles
    for (const o of sc ? sc.obstacles : []) {
      if (o.type === 'box') {
        const [x0, z0] = S(o.minX, o.minZ);
        const [x1, z1] = S(o.maxX, o.maxZ);
        g.fillStyle = 'rgba(148,163,184,0.75)';
        g.fillRect(x0, z0, x1 - x0, z1 - z0);
      } else if (o.type === 'seg') {
        g.strokeStyle = 'rgba(250,204,21,0.8)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(...S(o.ax, o.az));
        g.lineTo(...S(o.bx, o.bz));
        g.stroke();
      } else {
        const [sx, sy] = S(o.x, o.z);
        const tree = /tree/.test(o.name);
        g.fillStyle = tree ? 'rgba(20,83,45,0.9)' : '#e2e8f0';
        g.beginPath();
        g.arc(sx, sy, Math.max(tree ? o.r * v.k : 0, tree ? 2.5 : 2), 0, Math.PI * 2);
        g.fill();
      }
    }
    // Fence, home and pilot station
    const home = this.sim.missionHome;
    const [hx, hy] = S(home.x, home.z);
    const fence = this.sim.fenceConfig;
    if (fence.enabled) {
      g.strokeStyle = 'rgba(244,63,94,0.85)';
      g.setLineDash([8, 5]);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(hx, hy, fence.radius * v.k, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    const pilot = sc ? sc.pilot : { x: 0, z: 16 };
    badge(g, ...S(pilot.x, pilot.z), 'P', '#94a3b8');
    badge(g, hx, hy, 'H', '#4ade80');

    // Mission path and markers
    const path = this.derived?.path;
    const fc = this.sim.fc;
    const live = fc.mission && fc.armed && JSON.stringify(fc.mission.items) === JSON.stringify(this.draft.items) ? (fc.auto.complete ? Infinity : fc.auto.index) : -1;
    if (path && path.points.length > 1) {
      g.lineWidth = 2.5;
      g.strokeStyle = 'rgba(0,0,0,0.45)';
      tracePath(g, path.points, S, 1);
      g.strokeStyle = '#f8fafc';
      g.lineWidth = 2;
      tracePath(g, path.points, S, 0);
      // Direction arrows at leg midpoints
      g.fillStyle = '#f8fafc';
      for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1];
        const b = path.points[i];
        const [ax, ay] = S(a.x, a.z);
        const [bx, by] = S(b.x, b.z);
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 40) continue;
        const ang = Math.atan2(by - ay, bx - ax);
        g.save();
        g.translate((ax + bx) / 2, (ay + by) / 2);
        g.rotate(ang);
        g.beginPath();
        g.moveTo(6, 0);
        g.lineTo(-4, -4.5);
        g.lineTo(-4, 4.5);
        g.closePath();
        g.fill();
        g.restore();
      }
    }
    if (path) {
      g.font = '700 11px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const m of path.markers) {
        const [sx, sy] = S(m.x, m.z);
        const sel = m.item === this.sel;
        const fill = m.item === live ? '#fbbf24' : m.item < live ? '#64748b' : '#f8fafc';
        g.beginPath();
        g.arc(sx, sy, 9, 0, Math.PI * 2);
        g.fillStyle = fill;
        g.fill();
        g.lineWidth = sel ? 3 : 1.5;
        g.strokeStyle = sel ? '#22d3ee' : '#0b1220';
        g.stroke();
        g.fillStyle = '#0b1220';
        g.fillText(String(m.item + 1), sx, sy + 0.5);
        if (v.k >= 4.5) {
          g.fillStyle = 'rgba(255,255,255,0.85)';
          g.font = '600 10px system-ui, sans-serif';
          g.fillText(`${m.alt} m`, sx, sy + 17);
          g.font = '700 11px system-ui, sans-serif';
        }
      }
    }
    // Drone
    const q = this.sim.quad;
    const [dx, dy] = S(q.pos.x, q.pos.z);
    const yaw = fc.yaw;
    const f = [-Math.sin(yaw), -Math.cos(yaw)];
    const r = [Math.cos(yaw), -Math.sin(yaw)];
    g.beginPath();
    g.moveTo(dx + f[0] * 11, dy + f[1] * 11);
    g.lineTo(dx - f[0] * 7 - r[0] * 7, dy - f[1] * 7 - r[1] * 7);
    g.lineTo(dx - f[0] * 3, dy - f[1] * 3);
    g.lineTo(dx - f[0] * 7 + r[0] * 7, dy - f[1] * 7 + r[1] * 7);
    g.closePath();
    g.fillStyle = '#ffe14d';
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = '#0b1220';
    g.stroke();
    // Survey rectangle being drawn
    if (this.drag?.kind === 'rect') {
      const rc = this.drag.rect;
      const [x0, y0] = S(rc.x0, rc.z0);
      const [x1, y1] = S(rc.x1, rc.z1);
      g.setLineDash([6, 4]);
      g.strokeStyle = '#22d3ee';
      g.lineWidth = 2;
      g.fillStyle = 'rgba(34,211,238,0.12)';
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.setLineDash([]);
      g.fillStyle = '#e6edf6';
      g.font = '600 12px system-ui, sans-serif';
      g.textAlign = 'left';
      g.fillText(`${Math.abs(rc.x1 - rc.x0).toFixed(0)} x ${Math.abs(rc.z1 - rc.z0).toFixed(0)} m`, Math.max(x0, x1) + 6, Math.max(y0, y1));
    }
    this._drawOverlays(g, w, h, v);
  }

  _drawOverlays(g, w, h, v) {
    // Scale bar
    const steps = [5, 10, 20, 25, 50, 100, 200];
    let m = 5;
    for (const s of steps) if (s * v.k <= 140) m = s;
    const len = m * v.k;
    g.fillStyle = 'rgba(10,17,30,0.75)';
    g.fillRect(8, h - 30, len + 64, 22);
    g.fillStyle = '#fff';
    g.fillRect(16, h - 22, len, 4);
    g.font = '600 11px system-ui, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(`${m} m`, 22 + len, h - 19);
    // North arrow
    g.fillStyle = '#f43f5e';
    g.beginPath();
    g.moveTo(w - 22, 10);
    g.lineTo(w - 29, 26);
    g.lineTo(w - 15, 26);
    g.closePath();
    g.fill();
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.fillText('N', w - 22, 36);
    // Cursor position and hover info
    const lines = [];
    if (this.cursor) lines.push(`N ${(-this.cursor[1]).toFixed(1)}  E ${this.cursor[0].toFixed(1)}`);
    if (this.hover) lines.push(this.hover);
    g.textAlign = 'right';
    lines.forEach((t, i) => {
      const y = h - 19 - (lines.length - 1 - i) * 18;
      const tw = g.measureText(t).width;
      g.fillStyle = 'rgba(10,17,30,0.75)';
      g.fillRect(w - tw - 18, y - 9, tw + 12, 18);
      g.fillStyle = i === 1 ? '#fde68a' : '#e6edf6';
      g.fillText(t, w - 12, y);
    });
  }
}

function posText(it) {
  if (hasPos(it)) return `N ${(-it.z).toFixed(1)}  E ${it.x.toFixed(1)}`;
  if (it.type === 'RTL') return 'Home';
  if (it.type === 'TAKEOFF') return 'Vertical climb';
  return 'Where the drone is';
}

function tracePath(g, pts, S, extra) {
  g.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = S(p.x, p.z);
    if (i) g.lineTo(x, y + extra);
    else g.moveTo(x, y + extra);
  });
  g.stroke();
}

function badge(g, x, y, text, color) {
  g.beginPath();
  g.arc(x, y, 8, 0, Math.PI * 2);
  g.fillStyle = 'rgba(10,17,30,0.85)';
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = color;
  g.stroke();
  g.fillStyle = color;
  g.font = '800 10px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x, y + 0.5);
}
