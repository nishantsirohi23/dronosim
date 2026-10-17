import { Group, Vector3 } from 'three';
import { Scenery } from '../scenery.js';
import { PILOT_STATION } from '../patterns.js';

// Scene registry. `pack` controls edition access: 'base' scenes ship in every edition,
// 'pro' scenes need the Pro edition (see SCENE_ACCESS in config.js).
export const SCENES = [
  { id: 'training', name: 'RPTO Training Ground', pack: 'base', summary: 'Open training field with painted circle, square and figure-of-eight patterns, cones and a pilot station.', load: async () => ({ build: buildTraining }) },
  { id: 'city', name: 'City Streets', pack: 'pro', summary: 'Downtown grid with mid-rise buildings, traffic, street lights and overhead cables. Tight urban flying.', load: () => import('./city.js') },
  { id: 'forest', name: 'Forest Hills', pack: 'pro', summary: 'Hilly forest with a river, a ranger clearing, a fire lookout tower and a missing-person search target.', load: () => import('./forest.js') },
  { id: 'farm', name: 'Farmland', pack: 'pro', summary: 'Patchwork crop fields, a village, an irrigation canal, a water tower and 11 kV lines. Agri-drone training.', load: () => import('./farm.js') },
  { id: 'industrial', name: 'Solar & Substation', pack: 'pro', summary: 'Solar farm, substation and high-voltage transmission towers. Inspection training with a hot-spot panel.', load: () => import('./industrial.js') },
];

export function sceneInfo(id) {
  return SCENES.find((s) => s.id === id) || SCENES[0];
}

const _w = new Vector3();

// Wraps the original training ground (src/world/scenery.js) in the scene interface.
function buildTraining() {
  const holder = new Group();
  const s = new Scenery(holder);
  const root = holder.children[0];
  holder.remove(root);
  return {
    root,
    obstacles: s.obstacles,
    groundHeight: () => 0,
    pilot: { x: PILOT_STATION.x, z: PILOT_STATION.z },
    setNight: (k) => s.setNight(k),
    update(dt, t, windAt) {
      s.updateWindsock(dt, windAt(-12, 6, 8, _w));
    },
    swayMaterials: [],
    patterns: true,
    mapExtent: 110,
    mapPaint(ctx, toPx) {
      const [x0, y0] = toPx(-75, -85);
      const [x1, y1] = toPx(75, 35);
      ctx.fillStyle = '#5f8f3e';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    },
    poi: [],
    dispose() {},
  };
}
