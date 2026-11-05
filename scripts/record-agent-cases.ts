/**
 * Records the Phase 0 fixtures that need Agent mode with --force (auto-approve).
 * These edit files and run shell commands, so they run in a throwaway workspace
 * under the OS temp dir, never in this repo.
 *
 *   node scripts/record-agent-cases.ts [--model composer-2.5-fast]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const modelIdx = process.argv.indexOf('--model');
const model = modelIdx > 0 ? process.argv[modelIdx + 1] : 'composer-2.5-fast';

const ws = mkdtempSync(join(tmpdir(), 'cursor-agent-fixture-'));
writeFileSync(join(ws, 'math.ts'), 'export function add(a: number, b: number) {\r\n  return a + b;\r\n}\r\n');
writeFileSync(join(ws, 'README.md'), '# demo\n');
console.log(`workspace: ${ws}`);

const recordScript = resolve(import.meta.dirname, 'record.ts');
const fixtures = resolve(import.meta.dirname, '..', 'test', 'fixtures');
const base = ['-p', '--trust', '--output-format', 'stream-json', '--workspace', ws, '--model', model];

function record(name: string, prompt: string, args: string[]): void {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [recordScript, name, '--cwd', ws, '--prompt', prompt, '--', ...args], {
    stdio: 'inherit',
  });
  if (r.status !== 0) console.error(`${name}: recorder exited ${r.status}`);
}

function sessionOf(name: string): string {
  const first = readFileSync(join(fixtures, `${name}.ndjson`), 'utf8').split('\n')[0];
  return JSON.parse(first).session_id;
}

record('agent-edit', 'In math.ts add an exported function sub(a, b) that returns a - b. Keep the existing code and line endings. Do nothing else.', [
  ...base, '--stream-partial-output', '--force',
]);
record('agent-shell', 'Run this shell command: echo hello-from-agent > out.txt   Then reply with one word: done.', [
  ...base, '--stream-partial-output', '--force',
]);
record('agent-no-partial', 'Create a file notes.txt containing the single line: hi. Then reply with one word: done.', [
  ...base, '--force',
]);

// Mode switch on resume: plan first, then resume the same session in Agent mode.
record('switch-plan', 'Plan (do not implement) adding a multiply function to math.ts. Three bullet points max.', [
  ...base, '--stream-partial-output', '--mode', 'plan',
]);
record('switch-agent', 'Implement the plan above.', [
  ...base, '--stream-partial-output', '--force', '--resume', sessionOf('switch-plan'),
]);

// Hang-bug probe: record.ts waits up to 20 s after `result` before killing; see meta.killedAfterResult.
record('hang-probe', 'Reply with the single word: pong.', [...base, '--stream-partial-output', '--force']);

console.log('\nFinal math.ts bytes (CRLF preserved?):');
const final = readFileSync(join(ws, 'math.ts'));
console.log(JSON.stringify(final.toString('utf8')));
console.log(`out.txt exists: ${existsSync(join(ws, 'out.txt'))}`);
