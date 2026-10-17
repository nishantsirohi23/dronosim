// Waypoint mission model (ArduPilot-style mission items): validation, JSON import/export,
// planned path geometry, planning checks and templates.
// Positions use the world frame (+X = East, -Z = North, metres from the field origin);
// heights (alt) are metres above home.
import { FC_PARAMS } from '../config.js';
import { PATTERNS } from '../world/patterns.js';

export const MISSION_FORMAT = 'dronosim-mission';
export const MISSION_VERSION = 1;
const FRAME_NOTE = 'x = metres east, z = metres south (negative z is north), alt = metres above home, speed m/s, hold/time s';

export const ITEM_TYPES = {
  TAKEOFF: { label: 'Takeoff', short: 'TKOF', desc: 'Climb vertically to the given height' },
  WAYPOINT: { label: 'Waypoint', short: 'WP', desc: 'Fly to a position and height at the given speed, then optionally hold' },
  LOITER_TIME: { label: 'Loiter time', short: 'LOIT', desc: 'Hold for a set time at a position (or where the drone is)' },
  RTL: { label: 'RTL', short: 'RTL', desc: 'Return to launch and land' },
  LAND: { label: 'Land', short: 'LAND', desc: 'Land where the drone is (or at a position)' },
};
export const ITEM_TYPE_LIST = Object.keys(ITEM_TYPES);

export const MISSION_DEFAULTS = { alt: 10, speed: 5, hold: 0, loiterTime: 10 };
export const MISSION_LIMITS = { alt: [1, 120], speed: [0.5, 12], hold: [0, 600], pos: 1000, items: 200 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round1 = (v) => Math.round(v * 10) / 10;

function readNum(v, name, idx, fallback) {
  if (v === undefined || v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Item ${idx + 1}: "${name}" is required`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Item ${idx + 1}: "${name}" must be a number`);
  return n;
}

// Returns a clean item with every field present and clamped to the allowed range.
// Throws an Error naming the item when a required field is missing or not a number.
export function normalizeItem(raw, idx = 0) {
  if (!raw || typeof raw !== 'object') throw new Error(`Item ${idx + 1}: not an object`);
  const type = String(raw.type ?? raw.command ?? '').toUpperCase().replace(/^(MAV_CMD_)?NAV_/, '');
  const L = MISSION_LIMITS;
  const D = MISSION_DEFAULTS;
  const alt = (v, fb) => round1(clamp(readNum(v, 'alt', idx, fb), L.alt[0], L.alt[1]));
  const pos = (v, name) => round1(clamp(readNum(v, name, idx), -L.pos, L.pos));
  const hasPos = raw.x !== undefined && raw.x !== null && raw.z !== undefined && raw.z !== null;
  switch (type) {
    case 'TAKEOFF':
      return { type, alt: alt(raw.alt ?? raw.height, D.alt) };
    case 'WAYPOINT':
      return {
        type,
        x: pos(raw.x, 'x'),
        z: pos(raw.z, 'z'),
        alt: alt(raw.alt ?? raw.height, D.alt),
        speed: round1(clamp(readNum(raw.speed, 'speed', idx, D.speed), L.speed[0], L.speed[1])),
        hold: round1(clamp(readNum(raw.hold, 'hold', idx, D.hold), L.hold[0], L.hold[1])),
      };
    case 'LOITER_TIME': {
      const a = raw.alt ?? raw.height;
      return {
        type,
        x: hasPos ? pos(raw.x, 'x') : null,
        z: hasPos ? pos(raw.z, 'z') : null,
        alt: hasPos && a !== undefined && a !== null ? alt(a) : null,
        time: round1(clamp(readNum(raw.time ?? raw.hold, 'time', idx, D.loiterTime), 1, L.hold[1])),
      };
    }
    case 'RTL':
    case 'RETURN_TO_LAUNCH':
      return { type: 'RTL' };
    case 'LAND':
      return { type, x: hasPos ? pos(raw.x, 'x') : null, z: hasPos ? pos(raw.z, 'z') : null };
    default:
      throw new Error(`Item ${idx + 1}: unknown command "${raw.type ?? raw.command ?? ''}"`);
  }
}

export function createMission(name = 'New mission', items = []) {
  return { name, items: items.map((it, i) => normalizeItem(it, i)) };
}

export function cloneMission(m) {
  return { name: m.name, items: m.items.map((it) => ({ ...it })) };
}

export function missionToJSON(m) {
  return JSON.stringify({ format: MISSION_FORMAT, version: MISSION_VERSION, name: m.name, frame: FRAME_NOTE, items: m.items }, null, 2);
}

// Accepts a JSON string or an already-parsed object (or a bare array of items).
export function missionFromJSON(src) {
  let data = src;
  if (typeof src === 'string') {
    try {
      data = JSON.parse(src);
    } catch (e) {
      throw new Error(`Not valid JSON (${e.message})`);
    }
  }
  const items = Array.isArray(data) ? data : data && data.items;
  if (!Array.isArray(items)) throw new Error('No "items" list found');
  if (!Array.isArray(data) && data.format && data.format !== MISSION_FORMAT) throw new Error(`Unknown file format "${data.format}"`);
  if (!Array.isArray(data) && Number(data.version) > MISSION_VERSION) throw new Error(`Mission version ${data.version} is newer than this simulator supports`);
  if (items.length > MISSION_LIMITS.items) throw new Error(`Too many items (${items.length}, max ${MISSION_LIMITS.items})`);
  const name = (!Array.isArray(data) && data.name ? String(data.name) : 'Imported mission').slice(0, 60);
  return { name, items: items.map((it, i) => normalizeItem(it, i)) };
}

// Planned flight path as the flight controller will fly it, starting on the ground at home.
// points: polyline vertices ({x, z, alt, item}); markers: numbered positions (item index).
export function missionPath(mission, opts = {}) {
  const p = { ...FC_PARAMS, ...(opts.params || {}) };
  const home = opts.home || { x: 0, z: 0 };
  const rtlAlt = opts.rtlAlt ?? p.rtlAlt;
  const fence = opts.fence;
  let cur = { x: home.x, z: home.z, alt: 0, item: -1 };
  const points = [cur];
  const markers = [];
  let distance = 0;
  let time = 0;
  let ended = false;
  const go = (x, z, alt, item, speed) => {
    const h = Math.hypot(x - cur.x, z - cur.z);
    const v = alt - cur.alt;
    distance += Math.hypot(h, v);
    time += Math.max(h / speed, v > 0 ? v / p.wpSpeedUp : -v / p.wpSpeedDn);
    cur = { x, z, alt, item };
    points.push(cur);
  };
  const descend = (item) => {
    const hi = Math.max(cur.alt - p.landAltLow, 0);
    time += hi / p.landSpeedHigh + (cur.alt - hi) / p.landSpeed;
    distance += cur.alt;
    cur = { x: cur.x, z: cur.z, alt: 0, item };
    points.push(cur);
  };
  const items = mission ? mission.items : [];
  for (let i = 0; i < items.length && !ended; i++) {
    const it = items[i];
    switch (it.type) {
      case 'TAKEOFF':
        if (it.alt > cur.alt) go(cur.x, cur.z, it.alt, i, 1);
        break;
      case 'WAYPOINT':
        go(it.x, it.z, it.alt, i, it.speed);
        markers.push({ ...cur, item: i });
        time += it.hold;
        break;
      case 'LOITER_TIME':
        if (it.x !== null) go(it.x, it.z, it.alt ?? cur.alt, i, p.wpSpeed);
        markers.push({ ...cur, item: i });
        time += it.time;
        break;
      case 'RTL': {
        let ra = Math.max(rtlAlt, cur.alt);
        if (fence && fence.enabled) ra = Math.min(ra, Math.max(fence.maxAlt - 2, 3));
        if (Math.hypot(cur.x - home.x, cur.z - home.z) < p.rtlConeDist) ra = cur.alt;
        if (ra > cur.alt) go(cur.x, cur.z, ra, i, 1);
        go(home.x, home.z, ra, i, p.rtlSpeed);
        time += p.rtlLoiterTime;
        descend(i);
        ended = true;
        break;
      }
      case 'LAND':
        if (it.x !== null) go(it.x, it.z, cur.alt, i, p.wpSpeed);
        markers.push({ ...cur, item: i });
        descend(i);
        ended = true;
        break;
      default:
        break;
    }
  }
  return { points, markers, distance, time, ended };
}

function clearance(o, x, z) {
  if (o.type === 'box') return Math.hypot(Math.max(o.minX - x, 0, x - o.maxX), Math.max(o.minZ - z, 0, z - o.maxZ));
  if (o.type === 'seg') {
    // Horizontal distance to a wire segment.
    const dx = o.bx - o.ax;
    const dz = o.bz - o.az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.min(Math.max(((x - o.ax) * dx + (z - o.az) * dz) / l2, 0), 1) : 0;
    return Math.hypot(x - (o.ax + dx * t), z - (o.az + dz * t)) - o.r;
  }
  return Math.hypot(x - o.x, z - o.z) - o.r;
}

function obstacleBounds(o) {
  if (o.type === 'box') return [o.minX, o.maxX, o.minZ, o.maxZ, o.h];
  if (o.type === 'seg') return [Math.min(o.ax, o.bx) - o.r, Math.max(o.ax, o.bx) + o.r, Math.min(o.az, o.bz) - o.r, Math.max(o.az, o.bz) + o.r, Math.max(o.ay, o.by)];
  return [o.x - o.r, o.x + o.r, o.z - o.r, o.z + o.r, o.h];
}

// Legs of the planned path that pass close to and below the top of an obstacle, or below
// the terrain (groundHeight is optional; heights are relative to home at ground level 0).
export function missionHazards(path, obstacles = [], margin = 3, groundHeight = null) {
  const out = [];
  const pts = path.points;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(len));
    const minX = Math.min(a.x, b.x) - margin;
    const maxX = Math.max(a.x, b.x) + margin;
    const minZ = Math.min(a.z, b.z) - margin;
    const maxZ = Math.max(a.z, b.z) + margin;
    for (const o of obstacles) {
      const [ox0, ox1, oz0, oz1, top] = obstacleBounds(o);
      if (ox1 < minX || ox0 > maxX || oz1 < minZ || oz0 > maxZ) continue;
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const alt = a.alt + (b.alt - a.alt) * t;
        if (alt > 0.5 && clearance(o, x, z) < margin && alt < top + margin) {
          out.push({ item: b.item, name: o.name, height: top });
          break;
        }
      }
    }
    if (groundHeight) {
      for (let s = 0; s <= n; s += 2) {
        const t = s / n;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const alt = a.alt + (b.alt - a.alt) * t;
        const g = groundHeight(x, z);
        if (alt > 0.5 && alt < g + margin) {
          out.push({ item: b.item, name: 'terrain', height: g });
          break;
        }
      }
    }
  }
  return out;
}

// Planning checks: errors block upload, warnings are advice for the trainee.
export function validateMission(mission, opts = {}) {
  const errors = [];
  const warnings = [];
  const items = mission ? mission.items : [];
  if (!items.length) {
    errors.push('Mission is empty');
    return { errors, warnings };
  }
  if (items[0].type !== 'TAKEOFF') warnings.push('Item 1 is not TAKEOFF: AUTO can then only be engaged in the air');
  const endIdx = items.findIndex((it) => it.type === 'RTL' || it.type === 'LAND');
  if (endIdx >= 0 && endIdx < items.length - 1) warnings.push(`Items after ${items[endIdx].type} (item ${endIdx + 1}) are never flown`);
  if (endIdx < 0) warnings.push('No RTL or LAND at the end: the drone will hold at the last waypoint until you take over');
  if (!items.some((it) => it.type === 'WAYPOINT' || (it.type === 'LOITER_TIME' && it.x !== null))) warnings.push('Mission has no waypoints');
  const home = opts.home || { x: 0, z: 0 };
  const path = missionPath(mission, opts);
  const fence = opts.fence;
  if (fence && fence.enabled) {
    for (const m of path.markers) {
      const d = Math.hypot(m.x - home.x, m.z - home.z);
      if (d > fence.radius) warnings.push(`Item ${m.item + 1} is outside the geofence radius (${d.toFixed(0)} m > ${fence.radius} m)`);
      if (m.alt > fence.maxAlt - 1.5) warnings.push(`Item ${m.item + 1} height ${m.alt} m is at or above the fence ceiling (${fence.maxAlt} m)`);
    }
    const tk = items.find((it) => it.type === 'TAKEOFF');
    if (tk && tk.alt > fence.maxAlt - 1.5) warnings.push(`Takeoff height ${tk.alt} m is at or above the fence ceiling (${fence.maxAlt} m)`);
  }
  for (const h of missionHazards(path, opts.obstacles || [], 3, opts.groundHeight || null)) {
    warnings.push(`Leg to item ${h.item + 1} passes close to a ${h.name} (${h.height.toFixed(0)} m tall)`);
  }
  return { errors, warnings, path };
}

// ------------------------------------------------------------------ templates

const wp = (x, z, alt, speed) => ({ type: 'WAYPOINT', x: round1(x), z: round1(z), alt, speed, hold: 0 });

export const PATTERN_TEMPLATES = ['circle', 'square', 'figure8'];

// Mission that flies a reference pattern (the same checkpoints the assessment uses) and returns home.
export function patternMission(id, { alt = 10, speed = 4 } = {}) {
  const p = PATTERNS[id];
  if (!p) throw new Error(`Unknown pattern "${id}"`);
  const pts = p.checkpoints;
  const items = [{ type: 'TAKEOFF', alt }];
  for (const [x, z] of [...pts, pts[0]]) items.push(wp(x, z, alt, speed));
  items.push({ type: 'RTL' });
  return createMission(`${p.name} pattern`, items);
}

// Lawnmower survey grid over a rectangle. axis 'ew' flies east-west lines stepped north-south,
// 'ns' flies north-south lines stepped east-west. Starts at the corner nearest home.
export function surveyMission(rect, { spacing = 10, alt = 15, speed = 5, axis = 'ew', home = { x: 0, z: 0 } } = {}) {
  const x0 = Math.min(rect.x0, rect.x1);
  const x1 = Math.max(rect.x0, rect.x1);
  const z0 = Math.min(rect.z0, rect.z1);
  const z1 = Math.max(rect.z0, rect.z1);
  if (x1 - x0 < 2 || z1 - z0 < 2) throw new Error('Survey area is too small (at least 2 x 2 m)');
  const sp = clamp(spacing, 2, 100);
  const ew = axis !== 'ns';
  const span = ew ? z1 - z0 : x1 - x0;
  const n = Math.max(1, Math.ceil(span / sp - 1e-6));
  if ((n + 1) * 2 + 2 > MISSION_LIMITS.items) throw new Error('Too many survey lines: increase the line spacing');
  const step = span / n;
  const sx = Math.abs(home.x - x0) <= Math.abs(home.x - x1) ? x0 : x1;
  const sz = Math.abs(home.z - z0) <= Math.abs(home.z - z1) ? z0 : z1;
  const ox = sx === x0 ? x1 : x0;
  const oz = sz === z0 ? z1 : z0;
  const items = [{ type: 'TAKEOFF', alt }];
  for (let i = 0; i <= n; i++) {
    const flip = i % 2 === 1;
    if (ew) {
      const z = sz === z0 ? z0 + i * step : z1 - i * step;
      items.push(wp(flip ? ox : sx, z, alt, speed), wp(flip ? sx : ox, z, alt, speed));
    } else {
      const x = sx === x0 ? x0 + i * step : x1 - i * step;
      items.push(wp(x, flip ? oz : sz, alt, speed), wp(x, flip ? sz : oz, alt, speed));
    }
  }
  items.push({ type: 'RTL' });
  return createMission('Survey grid', items);
}
