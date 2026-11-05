#!/usr/bin/env node
/**
 * Fake cursor-agent: replays a recorded fixture so the extension can be tested
 * without spending model usage. Point `cursorAgent.cliPath` at this file.
 *
 * Env:
 *   FAKE_FIXTURE      fixture name in test/fixtures (default: ask-simple) or an absolute .ndjson path
 *   FAKE_DELAY_MS     delay between lines (default 20)
 *   FAKE_HANG=1       keep running after the `result` line (reproduces the headless hang bug)
 *   FAKE_GRANDCHILD=1 spawn a long-lived child process (tests tree kill); its pid goes to stderr
 *   FAKE_RECORD       file path; argv + stdin are written there as JSON
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('0000.00.00-fake');
  process.exit(0);
}
if (args[0] === 'status') {
  console.log(JSON.stringify({ status: 'authenticated', isAuthenticated: true, userInfo: { email: 'fake@example.com' } }));
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('Options:\n  -p, --print\n  --output-format <format>\n  --stream-partial-output\n  --mode <mode>\n  --resume [chatId]\n  --model <model>\n  -f, --force\n  --trust\n  --workspace <path>');
  process.exit(0);
}

const fx = process.env.FAKE_FIXTURE ?? 'ask-simple';
const base = fx.endsWith('.ndjson') ? fx.slice(0, -'.ndjson'.length) : join(here, 'fixtures', fx);
const lines = readFileSync(`${base}.ndjson`, 'utf8').split('\n').filter((l) => l.trim());
const stderrText = existsSync(`${base}.stderr.txt`) ? readFileSync(`${base}.stderr.txt`, 'utf8') : '';
const meta = existsSync(`${base}.meta.json`) ? JSON.parse(readFileSync(`${base}.meta.json`, 'utf8')) : { exitCode: 0 };
const delay = Number(process.env.FAKE_DELAY_MS ?? 20);

if (process.env.FAKE_GRANDCHILD === '1') {
  const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  process.stderr.write(`grandchild ${gc.pid}\n`);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', async () => {
  if (process.env.FAKE_RECORD) writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, stdin }));
  for (const line of lines) {
    await new Promise((r) => setTimeout(r, delay));
    process.stdout.write(line + '\n');
  }
  if (stderrText) process.stderr.write(stderrText);
  if (process.env.FAKE_HANG === '1') {
    setInterval(() => {}, 1000);
    return;
  }
  process.exitCode = meta.exitCode ?? 0;
});
