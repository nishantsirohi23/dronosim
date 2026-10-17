// North-up minimap: pre-rendered scene layout plus live drone, home, trail and fence.
// Click toggles between the whole scene and a 150 m local window around the drone.
export class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.local = false;
    this.bg = document.createElement('canvas');
    this.bg.width = 1024;
    this.bg.height = 1024;
    this.extent = 120;
    this.dynamic = [];
    canvas.addEventListener('click', () => (this.local = !this.local));
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 190;
    const h = this.canvas.clientHeight || 190;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssW = w;
    this.cssH = h;
  }

  setScene(inst) {
    this.inst = inst;
    this.extent = inst.mapExtent || 150;
    const ctx = this.bg.getContext('2d');
    const S = this.bg.width;
    const mpp = (2 * this.extent) / S;
    const toPx = (x, z) => [(x + this.extent) / mpp, (z + this.extent) / mpp];
    ctx.fillStyle = '#26381f';
    ctx.fillRect(0, 0, S, S);
    try {
      inst.mapPaint?.(ctx, toPx, mpp);
    } catch (e) {
      console.warn('mapPaint failed', e);
    }
    this.dynamic = [];
    const wires = [];
    for (const o of inst.obstacles) {
      if (o.dynamic) {
        this.dynamic.push(o);
        continue;
      }
      if (o.type === 'box') {
        const [x0, y0] = toPx(o.minX, o.minZ);
        const [x1, y1] = toPx(o.maxX, o.maxZ);
        ctx.fillStyle = o.name === 'building' || o.h > 6 ? '#c4c7cc' : '#8e939a';
        ctx.fillRect(x0, y0, Math.max(x1 - x0, 1), Math.max(y1 - y0, 1));
        ctx.strokeStyle = 'rgba(20,24,30,0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x0, y0, Math.max(x1 - x0, 1), Math.max(y1 - y0, 1));
      } else if (o.type === 'cyl') {
        const [x, y] = toPx(o.x, o.z);
        const tree = /tree/.test(o.name);
        ctx.fillStyle = tree ? 'rgba(20,70,25,0.9)' : '#d8d8d8';
        ctx.beginPath();
        ctx.arc(x, y, Math.max(o.r / mpp, tree ? 1.2 : 1.6), 0, Math.PI * 2);
        ctx.fill();
      } else if (o.type === 'seg') {
        wires.push(o);
      }
    }
    ctx.strokeStyle = 'rgba(250,204,21,0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    for (const o of wires) {
      const [x0, y0] = toPx(o.ax, o.az);
      const [x1, y1] = toPx(o.bx, o.bz);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = 'bold 18px system-ui, sans-serif';
    for (const p of inst.poi || []) {
      if (p.hidden) continue;
      const [x, y] = toPx(p.x, p.z);
      ctx.fillStyle = '#22d3ee';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText(p.name, x + 8, y + 6);
    }
    this.bgMpp = mpp;
  }

  draw({ pos, yaw, home, pilot, trail, fence }) {
    if (!this.inst) return;
    const ctx = this.ctx;
    const W = this.cssW;
    const H = this.cssH;
    const view = this.local ? 75 : this.extent;
    const cx = this.local ? pos.x : 0;
    const cz = this.local ? pos.z : 0;
    const mpp = (2 * view) / W;
    const toPx = (x, z) => [W / 2 + (x - cx) / mpp, H / 2 + (z - cz) / mpp];
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#1b2616';
    ctx.fillRect(0, 0, W, H);
    // Background crop from the pre-rendered layout.
    const bm = this.bgMpp;
    const sx = (cx - view + this.extent) / bm;
    const sy = (cz - view + this.extent) / bm;
    const sw = (2 * view) / bm;
    ctx.drawImage(this.bg, sx, sy, sw, sw, 0, 0, W, H);
    // Moving obstacles (traffic).
    ctx.fillStyle = '#f97316';
    for (const o of this.dynamic) {
      if (o.type !== 'box') continue;
      const [x0, y0] = toPx(o.minX, o.minZ);
      const [x1, y1] = toPx(o.maxX, o.maxZ);
      ctx.fillRect(x0, y0, Math.max(x1 - x0, 2), Math.max(y1 - y0, 2));
    }
    if (fence && fence.enabled) {
      const [hx, hy] = toPx(home.x, home.z);
      ctx.strokeStyle = 'rgba(244,63,94,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(hx, hy, fence.radius / mpp, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (trail && trail.length > 1) {
      ctx.strokeStyle = 'rgba(255,43,214,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const step = Math.max(1, Math.floor(trail.length / 600));
      for (let i = 0; i < trail.length; i += step) {
        const [x, y] = toPx(trail[i].x, trail[i].z);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    const [hx, hy] = toPx(home.x, home.z);
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    ctx.arc(hx, hy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b1220';
    ctx.fillText('H', hx, hy + 0.5);
    if (pilot) {
      const [px, py] = toPx(pilot.x, pilot.z);
      ctx.fillStyle = '#60a5fa';
      ctx.fillRect(px - 3, py - 3, 6, 6);
    }
    const [dx, dy] = toPx(pos.x, pos.z);
    ctx.save();
    ctx.translate(dx, dy);
    ctx.rotate(-yaw);
    ctx.fillStyle = '#ffe14d';
    ctx.strokeStyle = '#0b1220';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Scale label and north marker.
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'left';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillText(`${Math.round(view * 2)} m`, 6, H - 8);
    ctx.fillStyle = '#f43f5e';
    ctx.textAlign = 'right';
    ctx.fillText('N ▲', W - 6, 10);
  }
}
