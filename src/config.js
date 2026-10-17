import { DEG } from './util/math.js';

/* global __EDITION__ */
export const EDITION = typeof __EDITION__ !== 'undefined' ? __EDITION__ : 'base';
export const IS_DEMO = EDITION === 'demo';
export const IS_PRO = EDITION === 'pro';
export const EDITION_LABEL = { base: 'Base Edition', demo: 'Demo', pro: 'Pro Edition' }[EDITION] || 'Base Edition';

// Scenes available per edition (ids from src/world/scenes/index.js). Scenes not listed are
// shown as locked upgrades.
export const SCENE_ACCESS = {
  demo: ['training'],
  base: ['training'],
  pro: ['training', 'city', 'forest', 'farm', 'industrial'],
};
export const APP_NAME = 'DronoSim';
export const VERSION = '1.0.0';

// Demo builds enforce this geofence; it cannot be disabled from the UI.
export const DEMO_FENCE = { enabled: true, maxAlt: 25, radius: 60 };

// Base Edition content: 1 drone, 1 scenery, 1 structured challenge.
export const DRONE_X4 = {
  id: 'ds-x4',
  name: 'DS-X4 Trainer',
  description: '450-class quadcopter, 4S 5200 mAh, X frame',
  mass: 1.6, // kg incl. battery
  armLength: 0.225, // centre to motor (m)
  inertia: { pitch: 0.0165, yaw: 0.03, roll: 0.0165 }, // kg·m²
  maxThrustPerMotor: 8.5, // N at full pack voltage
  motorTau: 0.045, // s, first-order spool response
  yawTorqueCoeff: 0.016, // N·m reaction torque per N thrust
  idle: 0.06, // armed spin
  dragLinear: 0.25, // N per m/s, rotor drag
  cdaHorizontal: 0.055, // m²
  cdaVertical: 0.11, // m²
  angularDamping: 0.0025, // N·m per rad/s
  propRadius: 0.127, // 10" props
  gearHeight: 0.15, // CoM to skid bottom (m)
  contactHalfSpan: 0.24,
  collisionRadius: 0.3,
  currentCoeff: 0.45, // A per N^1.5 per motor
  avionicsCurrent: 0.6, // A
  crashVz: 3.2, // m/s vertical impact
  crashVh: 4.5, // m/s horizontal speed while touching the ground
  battery: { cells: 4, capacityMah: 5200, internalResistance: 0.06 },
};

export const SCENERY = { id: 'training-ground', name: 'RPTO Training Ground' };

export const FC_PARAMS = {
  angleMax: 35 * DEG,
  loiterAngleMax: 30 * DEG,
  angleRateMax: 220 * DEG,
  pilotYawRate: 90 * DEG,
  acroRate: 360 * DEG,
  acroYawRate: 180 * DEG,
  rpExpo: 0.25,
  yawExpo: 0.2,
  acroExpo: 0.4,
  thrDeadband: 0.1,
  climbMax: 2.5,
  descentMax: 1.5,
  loiterSpeed: 6,
  loiterAccel: 3,
  loiterBrake: 4,
  posLeash: 4,
  rtlAlt: 15,
  rtlSpeed: 5,
  rtlClimbRate: 2.5,
  rtlLoiterTime: 3,
  rtlConeDist: 3,
  rtlYawRate: 60 * DEG,
  landSpeed: 0.5,
  landSpeedHigh: 1.5,
  landAltLow: 8,
  landReposition: 2.5,
  wpRadius: 2, // AUTO waypoint acceptance radius (m), ArduPilot WPNAV_RADIUS
  wpSpeed: 5, // default horizontal speed (m/s) for items without their own speed
  wpSpeedUp: 2.5,
  wpSpeedDn: 1.5,
  wpAccel: 2.5,
  disarmDelay: 10,
  armGestureTime: 2,
  battLowPct: 25,
  battCritPct: 10,
  maxArmTilt: 25 * DEG,
};

export const DEFAULT_GAINS = {
  rate: {
    roll: { p: 18, i: 8, d: 0.35, imax: 10 },
    pitch: { p: 18, i: 8, d: 0.35, imax: 10 },
    yaw: { p: 6, i: 2, d: 0, imax: 3 },
  },
  angle: { roll: 7, pitch: 7, yaw: 4 },
  alt: { posP: 1.2, velP: 4, velI: 2, imax: 4 },
  pos: { posP: 1.0, velP: 1.8, velI: 0.5, velD: 0.1, imax: 3 },
};

// Controller profiles shipped with the simulator. `validated` should be set to true only
// for hardware that has actually been tested on a release build; the UI shows a
// "Validated" badge for those and "Profile" for the rest. Any HID joystick can be used
// through the calibration wizard.
export const CONTROLLER_PROFILES = [
  { name: 'Xbox / PlayStation gamepad (browser "standard" mapping)', match: 'standard', validated: false, note: 'Mode 2 preset. Throttle on spring-centred left stick (centre = hover in Stabilize).' },
  { name: 'RadioMaster TX16S / Boxer / Zorro (EdgeTX USB joystick)', match: 'radiomaster', validated: false, note: 'Run calibration wizard once; assign SA/SB/SC as mode, arm and RTL switches.' },
  { name: 'Jumper T-Pro / T20 / T-Lite (EdgeTX USB joystick)', match: 'jumper', validated: false, note: 'Run calibration wizard once.' },
  { name: 'FrSky Taranis X9D / X-Lite / QX7 (OpenTX/EdgeTX USB joystick)', match: 'frsky', validated: false, note: 'Run calibration wizard once.' },
  { name: 'FlySky FS-i6S / Paladin (USB HID)', match: 'flysky', validated: false, note: 'Run calibration wizard once.' },
  { name: 'Generic USB RC simulator dongle (e.g. 22-in-1 / FMS cable)', match: 'simulator', validated: false, note: 'Run calibration wizard once.' },
  { name: 'Generic HID joystick / flight stick', match: '*', validated: false, note: 'Run calibration wizard once.' },
];

export const DEFAULT_SETTINGS = {
  registration: 'UIN-DEMO-0001',
  pilotName: '',
  instructorName: '',
  organisation: '',
  wind: { speed: 3, dirDeg: 270, gustiness: 0.35, turbulence: true },
  timeOfDay: 'day',
  trail: { visible: true, colorMode: 'altitude', width: 3, groundTrack: true },
  overlay: 'none',
  fence: { enabled: false, maxAlt: 60, radius: 150 },
  rtlAlt: 15,
  batteryDrain: 1,
  keyboardRate: 1,
  showSticks: true,
  hudCompact: false,
  mission: null, // last mission uploaded to the drone (mission JSON object)
  missionPath3d: true,
  scene: 'training',
  weather: 'clear',
  quality: 'medium',
  sensors: { avoidance: true, beeper: true },
  sound: true,
  minimap: true,
};
