import { clamp } from '../util/math.js';
import { PATTERNS, HOME } from '../world/patterns.js';
import { PatternProgress, PatternTracker } from './analysis.js';

export const CHALLENGE = {
  id: 'basic-proficiency',
  name: 'Basic Proficiency Challenge',
  summary: 'Structured six-stage exercise: pre-flight arming, precision hover, square, circle, figure-of-eight and a precision landing.',
  passMark: 70,
  steps: [
    { id: 'arm', title: 'Pre-flight and arm', instr: 'Throttle fully down, select a flight mode and arm on the pad (Enter, ARM button or throttle-down + yaw-right for 2 s).' },
    { id: 'hover', title: 'Take-off and precision hover', instr: 'Climb to 5 m (+/- 1 m) and hold within 2 m of the pad centre for 10 s.' },
    { id: 'square', title: 'Square pattern', instr: 'Fly the 20 m square (yellow flags) at 4-15 m, passing every corner and returning to your start point.', pattern: 'square' },
    { id: 'circle', title: 'Circle', instr: 'Fly the 12 m radius circle (blue flag) at constant height (4-15 m) and close the loop.', pattern: 'circle' },
    { id: 'figure8', title: 'Figure-of-eight', instr: 'Fly both 9 m loops around the pink flags in opposite directions at 4-15 m.', pattern: 'figure8' },
    { id: 'land', title: 'Return and precision landing', instr: 'Return to the pad, land within 1.5 m of the centre and disarm.' },
  ],
};

const MANUAL_MODES = new Set(['STABILIZE', 'ALT_HOLD', 'ACRO']);

export class Challenge {
  constructor() {
    this.active = false;
    this.finished = false;
    this.manualOnly = true;
    this.listeners = [];
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  _changed() {
    for (const fn of this.listeners) fn(this);
  }

  start(manualOnly = true) {
    this.active = true;
    this.finished = false;
    this.passed = false;
    this.failReason = '';
    this.manualOnly = manualOnly;
    this.index = 0;
    this.elapsed = 0;
    this.penalties = [];
    this.results = CHALLENGE.steps.map((s) => ({ id: s.id, title: s.title, status: 'pending', score: 0, time: 0, notes: [] }));
    this.armFails = 0;
    this.totalScore = undefined;
    this.wasAirborneEver = false;
    this._enterStep();
    this._changed();
  }

  abort(reason = 'Aborted by user') {
    if (!this.active) return;
    this._finish(false, reason);
  }

  get step() {
    return CHALLENGE.steps[this.index];
  }

  get result() {
    return this.results?.[this.index];
  }

  _enterStep() {
    const s = this.step;
    this.stepTime = 0;
    this.hold = 0;
    this.hoverSamples = [];
    this.gpsUsed = false;
    this.wasAirborne = false;
    if (s.pattern) {
      this.progress = new PatternProgress(PATTERNS[s.pattern]);
      this.tracker = new PatternTracker(PATTERNS[s.pattern], 10);
    } else {
      this.progress = null;
      this.tracker = null;
    }
    this.result.status = 'active';
  }

  _complete(score, notes = []) {
    const r = this.result;
    if (this.gpsUsed && this.manualOnly && this.index > 0) {
      score = Math.min(score, 50);
      notes.push('GPS-assisted mode used (score capped at 50)');
    }
    r.status = 'done';
    r.score = Math.round(clamp(score, 0, 100));
    r.time = this.stepTime;
    r.notes.push(...notes);
    this.index += 1;
    if (this.index >= CHALLENGE.steps.length) {
      const total = this.results.reduce((a, b) => a + b.score, 0) / this.results.length;
      const pen = this.penalties.reduce((a, b) => a + b.points, 0);
      this.totalScore = Math.round(clamp(total - pen, 0, 100));
      this._finish(this.totalScore >= CHALLENGE.passMark, this.totalScore >= CHALLENGE.passMark ? '' : `Score below pass mark (${CHALLENGE.passMark})`);
      return;
    }
    this._enterStep();
    this._changed();
  }

  _finish(passed, reason) {
    this.active = false;
    this.finished = true;
    this.passed = passed;
    this.failReason = reason;
    if (this.totalScore === undefined || !passed) {
      const done = this.results.filter((r) => r.status === 'done');
      this.totalScore = done.length ? Math.round(done.reduce((a, b) => a + b.score, 0) / this.results.length) : 0;
    }
    for (const r of this.results) if (r.status === 'active' || r.status === 'pending') r.status = passed ? r.status : 'failed';
    this._changed();
  }

  // Events forwarded from the simulator.
  event(type, data) {
    if (!this.active) return;
    if (type === 'crash') this._finish(false, `Crash: ${data.reason}`);
    if (type === 'armfail' && this.index === 0) this.armFails += 1;
    if (type === 'fence') this.penalties.push({ reason: 'Geofence breach', points: 10 });
    if (type === 'disarmed' && this.index > 0 && this.index < 5 && this.wasAirborneEver) this._finish(false, 'Disarmed before completing the exercise');
  }

  sample(p) {
    if (!this.active || !this.tracker) return;
    // Score only from the first checkpoint onwards so the approach is not penalised.
    this.progress.update(p.x, p.z);
    if (this.progress.started) this.tracker.add(p);
  }

  update(dt, fc, quad) {
    if (!this.active) return;
    this.elapsed += dt;
    this.stepTime += dt;
    if (fc.armed && !fc.landed) {
      this.wasAirborne = true;
      this.wasAirborneEver = true;
    }
    if (fc.armed && !MANUAL_MODES.has(fc.mode) && !MODE_AUTO_OK(fc.mode, this.step.id)) this.gpsUsed = true;
    const s = this.step;
    switch (s.id) {
      case 'arm':
        this.wasAirborneEver = false;
        if (fc.armed) this._complete(100 - this.armFails * 10, this.armFails ? [`${this.armFails} failed arming attempt(s)`] : []);
        break;
      case 'hover': {
        const d = Math.hypot(quad.pos.x - HOME.x, quad.pos.z - HOME.z);
        const ok = fc.armed && !fc.landed && Math.abs(fc.alt - 5) <= 1 && d <= 2;
        if (ok) {
          this.hold += dt;
          this.hoverSamples.push([d, fc.alt - 5]);
        } else {
          this.hold = 0;
          this.hoverSamples.length = 0;
        }
        if (this.hold >= 10) {
          const n = this.hoverSamples.length;
          const pr = Math.sqrt(this.hoverSamples.reduce((a, [x]) => a + x * x, 0) / n);
          const ar = Math.sqrt(this.hoverSamples.reduce((a, [, y]) => a + y * y, 0) / n);
          this._complete(100 - pr * 18 - ar * 35, [`position RMS ${pr.toFixed(2)} m`, `height RMS ${ar.toFixed(2)} m`]);
        }
        break;
      }
      case 'square':
      case 'circle':
      case 'figure8':
        if (this.progress.complete) {
          const st = this.tracker.stats();
          const missed = this.progress.missed;
          this._complete(st.score - missed * 5, [
            `track RMS ${st.rms.toFixed(2)} m (max ${st.max.toFixed(1)} m)`,
            `height ${st.altMean.toFixed(1)} m +/- ${st.altStd.toFixed(2)} m`,
            `coverage ${(st.coverage * 100).toFixed(0)}%`,
            ...(missed ? [`${missed} checkpoint(s) cut`] : []),
          ]);
        }
        break;
      case 'land': {
        if (!fc.armed && quad.contact && !quad.crashed && this.wasAirborneEver) {
          const d = Math.hypot(quad.pos.x - HOME.x, quad.pos.z - HOME.z);
          const impact = quad.lastImpact;
          if (d > 1.5) {
            this._complete(clamp(40 - (d - 1.5) * 10, 0, 40), [`landed ${d.toFixed(2)} m from centre (outside 1.5 m)`]);
          } else {
            this._complete(100 - d * 30 - Math.max(impact - 0.8, 0) * 30, [`landed ${d.toFixed(2)} m from centre`, `touchdown ${impact.toFixed(2)} m/s`]);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  liveInfo() {
    if (!this.active) return null;
    const s = this.step;
    if (s.id === 'hover') return { label: 'Hold', value: `${this.hold.toFixed(1)} / 10 s`, frac: this.hold / 10 };
    if (this.progress) {
      const st = this.tracker.stats();
      return {
        label: this.progress.started ? 'Checkpoints' : 'Fly to the pattern',
        value: `${Math.min(this.progress.count, this.progress.total)} / ${this.progress.total}`,
        frac: this.progress.fraction,
        extra: st.samples ? `RMS ${st.rms.toFixed(2)} m` : '',
      };
    }
    return null;
  }
}

// RTL/LAND are allowed during the landing stage without counting as GPS assistance.
function MODE_AUTO_OK(mode, stepId) {
  return stepId === 'land' && mode === 'LAND';
}
