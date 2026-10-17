// Builds the standalone scene viewer into dist-viewer/. Scene modules that do not exist yet
// are replaced by an empty stub so the viewer can be built while scenes are in progress.
import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

mkdirSync('dist-viewer', { recursive: true });
copyFileSync('tools/viewer.html', 'dist-viewer/index.html');
const stubMissing = {
  name: 'stub-missing-scenes',
  setup(b) {
    b.onResolve({ filter: /^\.\/(city|forest|farm|industrial)\.js$/ }, (args) => {
      const p = resolve(dirname(args.importer), args.path);
      return existsSync(p) ? { path: p } : { path: p, namespace: 'stub' };
    });
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export function build(){ throw new Error("scene not built yet"); }', loader: 'js' }));
  },
};
await esbuild.build({ entryPoints: ['tools/sceneViewer.js'], bundle: true, format: 'iife', outfile: 'dist-viewer/viewer.js', define: { __EDITION__: '"pro"' }, plugins: [stubMissing], logLevel: 'warning' });
console.log('viewer built: node serve.mjs dist-viewer 5175');
