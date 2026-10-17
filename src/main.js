import { loadSettings } from './settings.js';
import { Simulator } from './sim.js';
import { UI } from './ui/ui.js';
import { applyUrlParams, autoFly, installBrowserApi } from './agent/browserApi.js';

function boot() {
  const settings = loadSettings();
  const url = applyUrlParams(settings);
  let sim;
  try {
    sim = new Simulator(document.getElementById('stage'), settings);
  } catch (err) {
    document.getElementById('stage').innerHTML = `<div style="padding:80px 24px;max-width:640px;margin:auto;font:15px system-ui;color:#e6edf6">
      <h2>DronoSim could not start</h2><p>WebGL 2 is required. Update your graphics driver or browser (Chrome, Edge or Firefox) and enable hardware acceleration.</p>
      <pre style="white-space:pre-wrap;color:#94a3b8">${String(err && err.message ? err.message : err)}</pre></div>`;
    throw err;
  }
  const ui = new UI(sim);
  sim.start();
  const api = installBrowserApi(sim);
  if (url.view) sim.ready.then(() => sim.setView(url.view));
  if (url.autofly > 0) autoFly(sim, api, url.autofly);
  if (url.ui === '0') document.body.classList.add('clean');
  if (url.ff > 0) sim.ready.then(() => sim.advance(url.ff));
  window.dronosim = { sim, ui };
}

boot();
