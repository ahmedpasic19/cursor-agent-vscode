/**
 * Phase 0 recording script.
 *
 * Runs the Cursor Agent CLI with the given flags, writes the prompt to stdin,
 * and saves raw stdout / stderr plus run metadata to test/fixtures/.
 *
 * Usage (Node >= 22.18 strips TS types natively):
 *   node scripts/record.ts <name> --prompt "text" [--cwd <dir>] [--hang-wait <ms>] -- <cli flags...>
 *
 * Outputs:
 *   test/fixtures/<name>.ndjson       raw stdout
 *   test/fixtures/<name>.stderr.txt   raw stderr
 *   test/fixtures/<name>.meta.json    argv, exit code, timings, hang observation
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function locateCli(): { command: string; prefixArgs: string[] } {
  if (process.env.CURSOR_AGENT_PATH) return { command: process.env.CURSOR_AGENT_PATH, prefixArgs: [] };
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const versions = join(process.env.LOCALAPPDATA, 'cursor-agent', 'versions');
    if (existsSync(versions)) {
      const dirs = readdirSync(versions, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(d.name))
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const d of dirs) {
        const node = join(versions, d, 'node.exe');
        const index = join(versions, d, 'index.js');
        if (existsSync(node) && existsSync(index)) return { command: node, prefixArgs: [index] };
      }
    }
  }
  return { command: 'cursor-agent', prefixArgs: [] };
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

const argv = process.argv.slice(2);
const name = argv.shift();
if (!name) {
  console.error('usage: node scripts/record.ts <name> --prompt "..." [--cwd dir] [--hang-wait ms] -- <cli flags>');
  process.exit(2);
}
let prompt = '';
let cwd = process.cwd();
let hangWait = 20000;
let cliArgs: string[] = [];
while (argv.length) {
  const a = argv.shift()!;
  if (a === '--prompt') prompt = argv.shift() ?? '';
  else if (a === '--cwd') cwd = resolve(argv.shift() ?? '.');
  else if (a === '--hang-wait') hangWait = Number(argv.shift());
  else if (a === '--') {
    cliArgs = argv.splice(0);
  } else throw new Error(`unknown option ${a}`);
}

const outDir = resolve(import.meta.dirname, '..', 'test', 'fixtures');
mkdirSync(outDir, { recursive: true });

const cli = locateCli();
const fullArgs = [...cli.prefixArgs, ...cliArgs];
const started = Date.now();
const child = spawn(cli.command, fullArgs, {
  cwd,
  windowsHide: true,
  detached: process.platform !== 'win32',
  stdio: ['pipe', 'pipe', 'pipe'],
});

const stdout: Buffer[] = [];
const stderr: Buffer[] = [];
let lineBuf = '';
let firstEventMs: number | null = null;
let resultMs: number | null = null;
let killedAfterResult = false;
let eventTypes: Record<string, number> = {};

child.stdout.on('data', (chunk: Buffer) => {
  stdout.push(chunk);
  lineBuf += chunk.toString('utf8');
  let nl: number;
  while ((nl = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, nl).replace(/\r$/, '');
    lineBuf = lineBuf.slice(nl + 1);
    if (!line.trim()) continue;
    firstEventMs ??= Date.now() - started;
    try {
      const ev = JSON.parse(line);
      const key = `${ev.type}${ev.subtype ? ':' + ev.subtype : ''}`;
      eventTypes[key] = (eventTypes[key] ?? 0) + 1;
      if (ev.type === 'result' && resultMs === null) {
        resultMs = Date.now() - started;
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            killedAfterResult = true;
            killTree(child.pid!);
          }
        }, hangWait);
      }
    } catch {
      eventTypes['<non-json>'] = (eventTypes['<non-json>'] ?? 0) + 1;
    }
  }
});
child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

const hardTimeout = setTimeout(() => killTree(child.pid!), 10 * 60 * 1000);

child.stdin.end(prompt, 'utf8');

child.on('close', (code, signal) => {
  clearTimeout(hardTimeout);
  const exitMs = Date.now() - started;
  writeFileSync(join(outDir, `${name}.ndjson`), Buffer.concat(stdout));
  writeFileSync(join(outDir, `${name}.stderr.txt`), Buffer.concat(stderr));
  const meta = {
    name,
    command: cli.command,
    args: fullArgs,
    cwd,
    prompt,
    exitCode: code,
    signal,
    firstEventMs,
    resultMs,
    exitMs,
    exitedAfterResultMs: resultMs === null ? null : exitMs - resultMs,
    killedAfterResult,
    eventTypes,
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, `${name}.meta.json`), JSON.stringify(meta, null, 2) + '\n');
  console.log(JSON.stringify(meta, null, 2));
});
