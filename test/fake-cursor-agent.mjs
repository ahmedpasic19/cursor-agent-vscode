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
 *   FAKE_ACTIONS      JSON file of file writes/deletes applied in cwd before replaying
 *   FAKE_FILE         replaces __FILE__ in synthetic fixtures (__CWD__ becomes the cwd)
 * A `<<fake {...}>>` directive in the prompt overrides these per run (fixture, delay, actions, file, hang).
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

if (process.env.FAKE_GRANDCHILD === '1') {
  const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  process.stderr.write(`grandchild ${gc.pid}\n`);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', async () => {
  if (process.env.FAKE_RECORD) writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, stdin }));

  // Per-run config can come from the prompt: <<fake {"fixture":..,"delay":..,"actions":[..],"file":..,"hang":true}>>
  // (env vars are read at spawn time, which races when several tabs start together).
  const directive = /<<fake (\{.*?\})>>/s.exec(stdin);
  const cfg = directive ? JSON.parse(directive[1]) : {};

  const fx = cfg.fixture ?? process.env.FAKE_FIXTURE ?? 'ask-simple';
  const base = fx.endsWith('.ndjson')
    ? fx.slice(0, -'.ndjson'.length)
    : existsSync(join(here, 'fixtures', `${fx}.ndjson`))
      ? join(here, 'fixtures', fx)
      : join(here, 'synthetic', fx);
  const cwdJson = JSON.stringify(process.cwd()).slice(1, -1);
  const file = cfg.file ?? process.env.FAKE_FILE ?? 'file.txt';
  // Synthetic fixtures may use __CWD__ / __FILE__ placeholders.
  const lines = readFileSync(`${base}.ndjson`, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.replaceAll('__CWD__', cwdJson).replaceAll('__FILE__', file));
  const stderrText = existsSync(`${base}.stderr.txt`) ? readFileSync(`${base}.stderr.txt`, 'utf8') : '';
  const meta = existsSync(`${base}.meta.json`) ? JSON.parse(readFileSync(`${base}.meta.json`, 'utf8')) : { exitCode: 0 };
  const delay = Number(cfg.delay ?? process.env.FAKE_DELAY_MS ?? 20);

  // Actions [{op:"write", path, content} | {op:"delete", path}] applied in cwd, simulating the
  // agent's edits and shell commands. From the directive, or the FAKE_ACTIONS file.
  let actions = cfg.actions;
  if (!actions && process.env.FAKE_ACTIONS && existsSync(process.env.FAKE_ACTIONS)) {
    actions = JSON.parse(readFileSync(process.env.FAKE_ACTIONS, 'utf8'));
  }
  if (actions) {
    const { mkdirSync, rmSync } = await import('node:fs');
    for (const a of actions) {
      const p = join(process.cwd(), a.path);
      if (a.op === 'write') {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, a.content);
      } else if (a.op === 'delete') rmSync(p, { force: true });
    }
  }
  for (const line of lines) {
    await new Promise((r) => setTimeout(r, delay));
    process.stdout.write(line + '\n');
  }
  if (stderrText) process.stderr.write(stderrText);
  if (cfg.hang || process.env.FAKE_HANG === '1') {
    setInterval(() => {}, 1000);
    // Safety net so an orphaned fake (e.g. VS Code killed in a test) doesn't live forever.
    setTimeout(() => process.exit(0), 120_000).unref?.();
    return;
  }
  process.exitCode = meta.exitCode ?? 0;
});
