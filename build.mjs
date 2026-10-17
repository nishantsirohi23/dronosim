// Bundles the simulator into a self-contained folder that runs offline: open index.html
// directly (file://) or serve it with `npm start`. Produces the Base Edition in dist/,
// the geofenced Demo version in dist-demo/ and the Pro Edition (all scenes) in dist-pro/.
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const editions = [
  { edition: 'base', out: 'dist' },
  { edition: 'demo', out: 'dist-demo' },
  { edition: 'pro', out: 'dist-pro' },
];

function copyStatic(out) {
  mkdirSync(out, { recursive: true });
  copyFileSync('index.html', `${out}/index.html`);
  copyFileSync('style.css', `${out}/style.css`);
}

for (const { edition, out } of editions) {
  if (!watch) rmSync(out, { recursive: true, force: true });
  copyStatic(out);
  const options = {
    entryPoints: ['src/main.js'],
    bundle: true,
    format: 'iife',
    target: ['chrome100', 'edge100', 'firefox100', 'safari15'],
    outfile: `${out}/dronosim.js`,
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    legalComments: 'eof',
    define: { __EDITION__: JSON.stringify(edition) },
    logLevel: 'info',
  };
  if (watch) {
    const ctx = await esbuild.context({
      ...options,
      plugins: [{ name: 'static', setup: (b) => b.onEnd(() => copyStatic(out)) }],
    });
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
}
if (watch) console.log('Watching for changes...');
