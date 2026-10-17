import { clamp } from '../util/math.js';

// Typical LiPo open-circuit voltage per cell vs state of charge.
const OCV = [
  [0.0, 3.27], [0.05, 3.5], [0.1, 3.69], [0.2, 3.73], [0.3, 3.77], [0.4, 3.79],
  [0.5, 3.82], [0.6, 3.87], [0.7, 3.92], [0.8, 3.98], [0.9, 4.06], [1.0, 4.2],
];

function ocvPerCell(soc) {
  soc = clamp(soc, 0, 1);
  for (let i = 1; i < OCV.length; i++) {
    if (soc <= OCV[i][0]) {
      const [s0, v0] = OCV[i - 1];
      const [s1, v1] = OCV[i];
      return v0 + ((soc - s0) / (s1 - s0)) * (v1 - v0);
    }
  }
  return OCV[OCV.length - 1][1];
}

export class Battery {
  constructor({ cells, capacityMah, internalResistance }) {
    this.cells = cells;
    this.capacityMah = capacityMah;
    this.r = internalResistance;
    this.reset();
  }

  reset() {
    this.usedMah = 0;
    this.current = 0;
    this.voltage = this.cells * 4.2;
    this.filtered = this.voltage;
  }

  get soc() {
    return clamp(1 - this.usedMah / this.capacityMah, 0, 1);
  }

  get pct() {
    return this.soc * 100;
  }

  get cellVoltage() {
    return this.filtered / this.cells;
  }

  // Available thrust scales with loaded pack voltage.
  get thrustScale() {
    return clamp(this.voltage / (this.cells * 4.0), 0.6, 1.05);
  }

  update(dt, currentA, drainMultiplier = 1) {
    this.current = currentA;
    this.usedMah += (currentA * dt * drainMultiplier) / 3.6;
    this.voltage = this.cells * ocvPerCell(this.soc) - currentA * this.r;
    this.filtered += (this.voltage - this.filtered) * clamp(dt * 2, 0, 1);
  }
}
