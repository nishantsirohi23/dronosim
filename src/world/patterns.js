// Training manoeuvre reference geometry (metres, XZ plane; -Z is North).
// Shared by the painted field markings, overlays, live analysis and the challenge.

export const HOME = { x: 0, z: 0 };
export const PILOT_STATION = { x: 0, z: 16 };
export const PATTERN_ALT = { min: 4, max: 15 };

function circle(cx, cz, r, n, a0 = 0, dir = 1) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (dir * 2 * Math.PI * i) / n;
    pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return pts;
}

function rectangle(cx, cz, half, perSide) {
  const c = [
    [cx - half, cz + half],
    [cx - half, cz - half],
    [cx + half, cz - half],
    [cx + half, cz + half],
  ];
  const pts = [];
  for (let s = 0; s < 4; s++) {
    const [x0, z0] = c[s];
    const [x1, z1] = c[(s + 1) % 4];
    for (let i = 0; i < perSide; i++) {
      const t = i / perSide;
      pts.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]);
    }
  }
  return pts;
}

function figureEight(cx, cz, r, nPerLobe) {
  // Two tangent circles flown in opposite directions, touching at (cx, cz).
  const left = circle(cx - r, cz, r, nPerLobe, 0, 1);
  const right = circle(cx + r, cz, r, nPerLobe, Math.PI, -1);
  return [...left, ...right];
}

function pickEvery(pts, step) {
  const out = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
  return out;
}

const circleCentre = { x: -38, z: -40 };
const squareCentre = { x: 0, z: -40 };
const eightCentre = { x: 38, z: -40 };

const circlePts = circle(circleCentre.x, circleCentre.z, 12, 96);
const squarePts = rectangle(squareCentre.x, squareCentre.z, 10, 24);
const eightPts = figureEight(eightCentre.x, eightCentre.z, 9, 72);

export const PATTERNS = {
  circle: {
    id: 'circle',
    name: 'Circle',
    detail: 'Radius 12 m, constant altitude 4-15 m',
    centre: circleCentre,
    radius: 12,
    points: circlePts,
    checkpoints: pickEvery(circlePts, 8),
    poles: [[circleCentre.x, circleCentre.z]],
    color: 0x38bdf8,
  },
  square: {
    id: 'square',
    name: 'Square',
    detail: '20 m sides, pass every corner, 4-15 m',
    centre: squareCentre,
    radius: 10,
    points: squarePts,
    checkpoints: pickEvery(squarePts, 12),
    poles: [
      [squareCentre.x - 10, squareCentre.z + 10],
      [squareCentre.x - 10, squareCentre.z - 10],
      [squareCentre.x + 10, squareCentre.z - 10],
      [squareCentre.x + 10, squareCentre.z + 10],
    ],
    color: 0xfbbf24,
  },
  figure8: {
    id: 'figure8',
    name: 'Figure-of-eight',
    detail: 'Two 9 m radius loops flown in opposite directions, 4-15 m',
    centre: eightCentre,
    radius: 18,
    points: eightPts,
    checkpoints: pickEvery(eightPts, 9),
    poles: [
      [eightCentre.x - 9, eightCentre.z],
      [eightCentre.x + 9, eightCentre.z],
    ],
    color: 0xf472b6,
  },
};

export const PATTERN_LIST = Object.values(PATTERNS);

// Horizontal distance from a point to a closed polyline; also returns the arc-length
// fraction of the closest point (for coverage bins).
export function distanceToPolyline(pts, x, z) {
  let best = Infinity;
  let bestFrac = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % n];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - x0) * dx + (z - z0) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x0 + dx * t - x;
    const pz = z0 + dz * t - z;
    const d = px * px + pz * pz;
    if (d < best) {
      best = d;
      bestFrac = (i + t) / n;
    }
  }
  return { dist: Math.sqrt(best), frac: bestFrac };
}
