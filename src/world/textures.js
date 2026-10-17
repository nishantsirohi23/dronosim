import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';
import { mulberry32 } from '../util/math.js';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function finish(canvas, repeat = null, anisotropy = 8) {
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = anisotropy;
  if (repeat) {
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

function speckle(ctx, w, h, rnd, colors, count, size) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
    const s = size * (0.5 + rnd());
    ctx.fillRect(rnd() * w, rnd() * h, s, s * (1 + rnd() * 2));
  }
}

export function grassTexture(repeat) {
  const c = makeCanvas(256, 256);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(7);
  ctx.fillStyle = '#4f7a35';
  ctx.fillRect(0, 0, 256, 256);
  speckle(ctx, 256, 256, rnd, ['#46702e', '#5a8a3c', '#3f6629', '#668f42', '#557f37'], 5000, 2);
  speckle(ctx, 256, 256, rnd, ['#7a8a4a', '#6b5a3a'], 120, 2);
  return finish(c, repeat);
}

// Two 5 m mowing stripes per tile; repeat so one tile spans 10 m for crisp close-up detail.
export function mowedTexture(repeat) {
  const c = makeCanvas(256, 256);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(11);
  ctx.fillStyle = '#6ea24b';
  ctx.fillRect(0, 0, 128, 256);
  ctx.fillStyle = '#5f9140';
  ctx.fillRect(128, 0, 128, 256);
  speckle(ctx, 256, 256, rnd, ['rgba(40,70,25,0.45)', 'rgba(120,160,80,0.35)', 'rgba(70,110,45,0.5)'], 6000, 1.5);
  return finish(c, repeat);
}

export function concreteTexture() {
  const c = makeCanvas(512, 512);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(3);
  ctx.fillStyle = '#8d8f8f';
  ctx.fillRect(0, 0, 512, 512);
  speckle(ctx, 512, 512, rnd, ['#9a9c9c', '#7f8181', '#a3a5a4', '#86898a'], 9000, 2);
  return c;
}

export function helipadTexture() {
  const c = concreteTexture();
  const ctx = c.getContext('2d');
  ctx.strokeStyle = '#f5c518';
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.arc(256, 256, 200, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#f4f4f4';
  ctx.fillRect(166, 136, 40, 240);
  ctx.fillRect(306, 136, 40, 240);
  ctx.fillRect(206, 236, 100, 40);
  ctx.strokeStyle = '#f4f4f4';
  ctx.lineWidth = 8;
  ctx.strokeRect(12, 12, 488, 488);
  ctx.fillStyle = '#f5c518';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('HOME', 256, 44 + 4);
  // North marker
  ctx.beginPath();
  ctx.moveTo(256, 66);
  ctx.lineTo(240, 96);
  ctx.lineTo(272, 96);
  ctx.closePath();
  ctx.fill();
  return finish(c);
}

export function windsockTexture() {
  const c = makeCanvas(256, 64);
  const ctx = c.getContext('2d');
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i % 2 ? '#f5f5f5' : '#ff6a00';
    ctx.fillRect((i * 256) / 5, 0, 256 / 5 + 1, 64);
  }
  return finish(c);
}

export function labelTexture(text, { bg = '#ffffff', fg = '#111111', w = 512, h = 128, font = 'bold 72px sans-serif', border = null } = {}) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, w - 8, h - 8);
  }
  ctx.fillStyle = fg;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = parseInt(font.match(/(\d+)px/)[1], 10);
  while (ctx.measureText(text).width > w * 0.9 && size > 12) {
    size -= 2;
    ctx.font = font.replace(/\d+px/, `${size}px`);
  }
  ctx.fillText(text, w / 2, h / 2 + 2);
  return finish(c);
}

export function barkTexture() {
  const c = makeCanvas(64, 64);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(5);
  ctx.fillStyle = '#5b4330';
  ctx.fillRect(0, 0, 64, 64);
  speckle(ctx, 64, 64, rnd, ['#4a3526', '#6a503a'], 300, 1.5);
  return finish(c);
}
