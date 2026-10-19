import { build } from 'esbuild';
import { mkdir, copyFile, cp } from 'node:fs/promises';
await mkdir('dist/public', { recursive: true });
await build({
  entryPoints: ['src/server/main.ts'],
  outfile: 'dist/server/main.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
});
await build({
  entryPoints: ['src/client/main.ts'],
  outfile: 'dist/public/app.js',
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'esm',
  sourcemap: true,
});
await copyFile('src/client/index.html', 'dist/public/index.html');
await cp('src/client/styles', 'dist/public/styles', { recursive: true });
await build({
  entryPoints: ['tests/sync.test.ts', 'tests/playback.test.ts'],
  outdir: 'dist/tests',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
});
