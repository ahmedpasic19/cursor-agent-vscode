/**
 * Integration tests in a real VS Code with the fake CLI (no model usage).
 *   npm run test:integration
 * Uses the installed VS Code when found (CODE_PATH overrides), with a throwaway profile.
 */
import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');

await build({
  entryPoints: [join(root, 'test/integration/suite.ts')],
  bundle: true,
  outfile: join(root, 'dist-test/suite.cjs'),
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'warning',
});

const tmp = mkdtempSync(join(tmpdir(), 'cursor-agent-it-'));
const ws = join(tmp, 'workspace');
mkdirSync(join(ws, 'src'), { recursive: true });
// CRLF on purpose: chips must normalize to LF.
const api = Array.from({ length: 40 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\r\n') + '\r\n';
writeFileSync(join(ws, 'src', 'api.ts'), api);
writeFileSync(join(ws, 'src', 'app.ts'), "import { line1 } from './api';\nconst y: { a: number } = { a: 1 };\nconsole.log(line1, y);\n");

// Make the workspace a real git repo: checkpoints must never touch the user's .git.
const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=User', '-c', 'user.email=u@example.com', '-c', 'core.autocrlf=false', ...args], { cwd: ws, stdio: 'pipe' });
git('init', '-q');
git('add', '-A');
git('commit', '-q', '-m', 'user commit');

const userData = join(tmp, 'user-data');
mkdirSync(join(userData, 'User'), { recursive: true });
writeFileSync(
  join(userData, 'User', 'settings.json'),
  JSON.stringify(
    {
      'cursorAgent.cliPath': join(root, 'test', 'fake-cursor-agent.mjs'),
      'security.workspace.trust.enabled': false,
      'terminal.integrated.shellIntegration.enabled': true,
      'workbench.startupEditor': 'none',
    },
    null,
    2,
  ),
);

const candidates = [
  process.env.CODE_PATH,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
  'C:\\Program Files\\Microsoft VS Code\\Code.exe',
].filter(Boolean);
const vscodeExecutablePath = candidates.find((p) => existsSync(p));

const record = join(tmp, 'stdin-record.json');
try {
  await runTests({
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version: 'stable' }),
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'dist-test/suite.cjs'),
    launchArgs: [ws, '--disable-extensions', '--disable-extension', 'vscode.git', '--disable-extension', 'vscode.github', '--disable-extension', 'vscode.git-base', '--user-data-dir', userData, '--extensions-dir', join(tmp, 'ext'), '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: { FAKE_RECORD: record, FAKE_FIXTURE: 'ask-simple', FAKE_DELAY_MS: '1' },
  });
  console.log(`\nIntegration tests passed (workspace: ${ws})`);
} catch (e) {
  console.error('Integration tests failed', e);
  process.exit(1);
}
