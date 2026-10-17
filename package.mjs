// Packages the desktop app with electron-builder: a Windows NSIS installer and a macOS dmg per
// edition, written to release/<edition>/. Builds both web editions first (build.mjs) and ships
// the chosen one as resources/web next to the Electron shell in electron/main.mjs.
// Usage: node package.mjs [base|demo|pro] [--mac] [--win] [--dir]
//   no platform flag: installer for this OS; --dir: unpacked app only (quick local check)
import { execFileSync } from 'node:child_process';
import { build } from 'electron-builder';

const args = process.argv.slice(2);
const edition = args.includes('demo') ? 'demo' : args.includes('pro') ? 'pro' : 'base';
const EDITIONS = {
  base: { name: 'dronosim', productName: 'DronoSim', appId: 'com.dronosim.desktop', web: 'dist', file: 'DronoSim' },
  demo: { name: 'dronosim-demo', productName: 'DronoSim Demo', appId: 'com.dronosim.desktop.demo', web: 'dist-demo', file: 'DronoSim-Demo' },
  pro: { name: 'dronosim-pro', productName: 'DronoSim Pro', appId: 'com.dronosim.desktop.pro', web: 'dist-pro', file: 'DronoSim-Pro' },
};
const ed = EDITIONS[edition];

let mac = args.includes('--mac');
let win = args.includes('--win');
if (!mac && !win) {
  mac = process.platform === 'darwin';
  win = process.platform === 'win32';
  if (!mac && !win) throw new Error('Pass --mac or --win to choose the installer platform.');
}

// Without a Developer ID (CSC_NAME / CSC_LINK) the macOS app is ad-hoc signed so it still
// launches on Apple Silicon. Ad-hoc signing needs the hardened runtime off.
const adHoc = !process.env.CSC_NAME && !process.env.CSC_LINK;

const config = {
  appId: ed.appId,
  productName: ed.productName,
  directories: { output: `release/${edition}`, buildResources: 'build' },
  files: ['electron/main.mjs', 'package.json'],
  extraResources: [{ from: ed.web, to: 'web' }],
  extraMetadata: { name: ed.name, productName: ed.productName, main: 'electron/main.mjs' },
  artifactName: `${ed.file}-\${version}-\${os}-\${arch}.\${ext}`,
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.education',
    ...(adHoc ? { identity: '-', hardenedRuntime: false } : {}),
  },
  // No auto-update server, so skip the blockmaps for differential updates (dmg and nsis).
  dmg: { title: `${ed.productName} \${version}`, writeUpdateInfo: false },
  win: { target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: ed.productName,
    uninstallDisplayName: ed.productName,
    differentialPackage: false,
  },
};

execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' });
const files = await build({
  config,
  publish: 'never',
  dir: args.includes('--dir'),
  ...(mac ? { mac: [] } : {}),
  ...(win ? { win: [] } : {}),
});
console.log(`\n${ed.productName}:\n${files.map((f) => `  ${f}`).join('\n')}`);
