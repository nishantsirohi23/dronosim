// Minimal DOM shim so scene modules (which paint canvas textures) can be built in Node for
// headless training. Geometry and textures are created but never rendered.
export function installHeadlessDom() {
  if (typeof globalThis.document !== 'undefined') return false;
  const noop = () => {};
  const gradient = () => ({ addColorStop: noop });
  const imageData = (w, h) => {
    const width = typeof w === 'object' ? w.width : w || 1;
    const height = typeof w === 'object' ? w.height : h || 1;
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  };
  const ctx2d = new Proxy(
    {},
    {
      get(t, k) {
        if (k === 'measureText') return () => ({ width: 10 });
        if (k === 'createRadialGradient' || k === 'createLinearGradient' || k === 'createPattern') return gradient;
        if (k === 'createImageData' || k === 'getImageData') return imageData;
        return k in t ? t[k] : noop;
      },
      set(t, k, v) {
        t[k] = v;
        return true;
      },
    },
  );
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d, toDataURL: () => '' }),
  };
  return true;
}
