import { DEFAULT_SETTINGS, DEMO_FENCE, IS_DEMO } from './config.js';

const KEY = 'dronosim.settings';

function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

export function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    stored = {};
  }
  const s = merge(DEFAULT_SETTINGS, stored);
  if (IS_DEMO) s.fence = { ...DEMO_FENCE };
  return s;
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable (private window): settings last for this session */
  }
}
