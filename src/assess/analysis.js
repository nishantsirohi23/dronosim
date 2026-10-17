import { clamp } from '../util/math.js';
import { distanceToPolyline, PATTERN_ALT } from '../world/patterns.js';

const BINS = 48;

// Tracks ordered checkpoint progress around a closed pattern, in either direction.
export class PatternProgress {
  constructor(pattern, capture = 4) {
    this.pattern = pattern;
    this.capture = capture;
    this.reset();
  }

  reset() {
    this.started = false;
    this.dir = 0;
    this.cur = -1;
    this.start = -1;
    this.count = 0;
    this.missed = 0;
    this.complete = false;
    this.candidates = [];
  }

  _near(i, x, z) {
    const [cx, cz] = this.pattern.checkpoints[i];
    return Math.hypot(cx - x, cz - z) < this.capture;
  }

  get total() {
    return this.pattern.checkpoints.length;
  }

  update(x, z) {
    if (this.complete) return;
    const n = this.total;
    if (!this.started || this.dir === 0) {
      const near = [];
      for (let i = 0; i < n; i++) if (this._near(i, x, z)) near.push(i);
      if (!this.started) {
        if (near.length) {
          this.started = true;
          this.candidates = near;
        }
        return;
      }
      for (const c of this.candidates) {
        for (const d of [1, -1]) {
          const nx = (c + d + n) % n;
          if (near.includes(nx)) {
            this.dir = d;
            this.start = c;
            this.cur = nx;
            this.count = 1;
            return;
          }
        }
      }
      if (near.length) this.candidates = Array.from(new Set([...this.candidates, ...near]));
      return;
    }
    const n1 = (this.cur + this.dir + n) % n;
    const n2 = (this.cur + 2 * this.dir + n) % n;
    if (this._near(n1, x, z)) {
      this.cur = n1;
      this.count += 1;
    } else if (this._near(n2, x, z)) {
      this.cur = n2;
      this.count += 2;
      this.missed += 1;
    }
    if (this.count >= n) this.complete = true;
  }

  get fraction() {
    return this.complete ? 1 : clamp(this.count / this.total, 0, 1);
  }
}

// Live deviation statistics of flown samples against a reference pattern.
export class PatternTracker {
  constructor(pattern, window = 8) {
    this.pattern = pattern;
    this.window = window;
    this.reset();
  }

  reset() {
    this.n = 0;
    this.sumSq = 0;
    this.sum = 0;
    this.max = 0;
    this.altSum = 0;
    this.altSq = 0;
    this.altOut = 0;
    this.bins = new Uint8Array(BINS);
    this.speedSum = 0;
    this.t0 = null;
    this.t1 = null;
  }

  add(p) {
    const r = distanceToPolyline(this.pattern.points, p.x, p.z);
    if (r.dist > this.window) return false;
    this.n += 1;
    this.sum += r.dist;
    this.sumSq += r.dist * r.dist;
    this.max = Math.max(this.max, r.dist);
    this.altSum += p.alt;
    this.altSq += p.alt * p.alt;
    if (p.alt < PATTERN_ALT.min || p.alt > PATTERN_ALT.max) this.altOut += 1;
    if (r.dist < 3) this.bins[Math.floor(r.frac * BINS) % BINS] = 1;
    this.speedSum += p.speed;
    if (this.t0 === null) this.t0 = p.t;
    this.t1 = p.t;
    return true;
  }

  stats() {
    const n = Math.max(this.n, 1);
    const rms = Math.sqrt(this.sumSq / n);
    const altMean = this.altSum / n;
    const altStd = Math.sqrt(Math.max(this.altSq / n - altMean * altMean, 0));
    const coverage = this.bins.reduce((a, b) => a + b, 0) / BINS;
    const trackScore = clamp(100 - (rms - 0.5) * 22, 0, 100);
    const altScore = clamp(100 - altStd * 30 - (this.altOut / n) * 100, 0, 100);
    const score = this.n < 5 ? 0 : Math.round((0.6 * trackScore + 0.25 * altScore + 15 * coverage) * clamp(coverage / 0.9, 0, 1));
    return {
      samples: this.n,
      rms,
      mean: this.sum / n,
      max: this.max,
      altMean,
      altStd,
      altOutPct: (this.altOut / n) * 100,
      coverage,
      duration: this.t0 === null ? 0 : this.t1 - this.t0,
      avgSpeed: this.speedSum / n,
      score: clamp(score, 0, 100),
    };
  }
}

export function summariseFlight(points) {
  let dist = 0;
  let maxAlt = 0;
  let maxSpeed = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    maxAlt = Math.max(maxAlt, p.alt);
    maxSpeed = Math.max(maxSpeed, p.speed);
    if (i > 0) {
      const q = points[i - 1];
      dist += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    }
  }
  const duration = points.length > 1 ? points[points.length - 1].t - points[0].t : 0;
  return { dist, maxAlt, maxSpeed, duration, samples: points.length };
}

export function trackStats(points, pattern) {
  const t = new PatternTracker(pattern);
  for (const p of points) t.add(p);
  return t.stats();
}
