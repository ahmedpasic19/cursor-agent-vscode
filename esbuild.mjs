import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = { bundle: true, format: 'cjs', platform: 'node', sourcemap: true, logLevel: 'info' };

const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', target: 'node20', external: ['vscode'] }),
  // The SDK worker runs under the user's Node (>= 22.13); @cursor/sdk is loaded at runtime.
  esbuild.context({ ...common, entryPoints: ['src/sdk/worker.ts'], outfile: 'dist/sdk-worker.cjs', target: 'node22', external: ['@cursor/sdk'] }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
