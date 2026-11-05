import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOptions } from '../src/backend/AgentBackend';
import { buildArgs, CliBackend } from '../src/backend/CliBackend';
import { parseHelpFlags, parseModels } from '../src/backend/cliCapabilities';
import { fromExplicitPath, quoteCmdArg } from '../src/backend/cliLocator';
import type { AgentEvent } from '../src/shared/events';

const FAKE = resolve(import.meta.dirname, 'fake-cursor-agent.mjs');
const cli = fromExplicitPath(FAKE)!;
const tmp = mkdtempSync(join(tmpdir(), 'cab-test-'));

function opts(over: Partial<RunOptions> = {}): RunOptions {
  return {
    cwd: tmp,
    prompt: 'hello',
    mode: 'ask',
    partialOutput: true,
    extraArgs: [],
    postResultGraceMs: 300,
    timeoutMs: 20000,
    ...over,
  };
}

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('buildArgs', () => {
  it('maps modes to flags', () => {
    expect(buildArgs(opts({ mode: 'agent' }))).toContain('--force');
    expect(buildArgs(opts({ mode: 'ask' }))).toEqual(expect.arrayContaining(['--mode', 'ask']));
    expect(buildArgs(opts({ mode: 'plan' }))).toEqual(expect.arrayContaining(['--mode', 'plan']));
    expect(buildArgs(opts({ mode: 'agent' }))).not.toContain('--mode');
  });

  it('adds resume, model, extra args; never puts the prompt in argv', () => {
    const a = buildArgs(opts({ resumeSessionId: 's1', model: 'm1', extraArgs: ['--x'], prompt: 'SECRET' }));
    expect(a).toEqual(expect.arrayContaining(['-p', '--trust', '--resume', 's1', '--model', 'm1', '--x']));
    expect(a).not.toContain('SECRET');
  });

  it('drops flags the CLI does not support', () => {
    const caps = { version: 'x', flags: new Set(['-p', '--trust']) };
    expect(buildArgs(opts({ partialOutput: true }), caps)).not.toContain('--stream-partial-output');
  });
});

describe('capability parsing', () => {
  it('parses flags from --help', () => {
    const f = parseHelpFlags('  -p, --print   Print\n  --stream-partial-output  x\n  -w, --worktree [name]');
    expect(f.has('--print')).toBe(true);
    expect(f.has('-p')).toBe(true);
    expect(f.has('--stream-partial-output')).toBe(true);
    expect(f.has('--worktree')).toBe(true);
  });

  it('parses `models` output', () => {
    const m = parseModels('Available models\n\nauto - Auto (current, default)\ngrok-4.7-low-fast - Grok 4.7  Low Fast\u200b\u200b\n');
    expect(m).toEqual([
      { id: 'auto', label: 'Auto', isDefault: true },
      { id: 'grok-4.7-low-fast', label: 'Grok 4.7  Low Fast', isDefault: false },
    ]);
  });

  it('quotes cmd args', () => {
    expect(quoteCmdArg('plain')).toBe('plain');
    expect(quoteCmdArg('C:\\a b\\')).toBe('"C:\\a b\\\\"');
    expect(quoteCmdArg('x"y')).toBe('"x\\"y"');
  });
});

describe('CliBackend with fake CLI', () => {
  it('streams a fixture and succeeds; prompt goes via stdin', async () => {
    const rec = join(tmp, 'rec1.json');
    const events: AgentEvent[] = [];
    const outcome = await withEnv({ FAKE_FIXTURE: 'ask-simple', FAKE_DELAY_MS: '1', FAKE_RECORD: rec }, () =>
      new CliBackend(cli).run(opts({ prompt: 'héllo “stdin” 🚀' }), (e) => events.push(e)).done,
    );
    expect(outcome.status).toBe('success');
    expect(outcome.sessionId).toBe('d65a4b1e-2140-45b0-8550-c1fbdcae0e57');
    expect(events[0]?.kind).toBe('init');
    expect(events.at(-1)?.kind).toBe('result');
    const recorded = JSON.parse(readFileSync(rec, 'utf8'));
    expect(recorded.stdin).toBe('héllo “stdin” 🚀');
  });

  it('reports an error with the stderr tail when no result arrives', async () => {
    const outcome = await withEnv({ FAKE_FIXTURE: 'invalid-model', FAKE_DELAY_MS: '1' }, () =>
      new CliBackend(cli).run(opts(), () => {}).done,
    );
    expect(outcome.status).toBe('error');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.message).toMatch(/^Cannot use this model: no-such-model-xyz/);
  });

  it('kills a process that hangs after result (grace period)', async () => {
    const t0 = Date.now();
    const outcome = await withEnv({ FAKE_FIXTURE: 'hang-probe', FAKE_DELAY_MS: '1', FAKE_HANG: '1' }, () =>
      new CliBackend(cli).run(opts({ postResultGraceMs: 300 }), () => {}).done,
    );
    expect(outcome.status).toBe('success');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('stop kills the process tree within 1 second', async () => {
    const events: AgentEvent[] = [];
    await withEnv({ FAKE_FIXTURE: 'plan-mode', FAKE_DELAY_MS: '300', FAKE_GRANDCHILD: '1' }, async () => {
      const handle = new CliBackend(cli).run(opts(), (e) => events.push(e));
      // Wait until streaming has started.
      while (!events.length) await new Promise((r) => setTimeout(r, 20));
      const t0 = Date.now();
      handle.stop();
      const outcome = await handle.done;
      const elapsed = Date.now() - t0;
      expect(outcome.status).toBe('stopped');
      expect(elapsed).toBeLessThan(1000);
      const gc = outcome.stderrTail.join('\n').match(/grandchild (\d+)/);
      if (gc) {
        await new Promise((r) => setTimeout(r, 200));
        expect(isAlive(Number(gc[1]))).toBe(false);
      }
    });
  });

  it('reports spawn failure', async () => {
    const outcome = await new CliBackend({
      command: join(tmp, 'does-not-exist.exe'),
      prefixArgs: [],
      shell: false,
      source: 'setting',
      display: 'missing',
    }).run(opts(), () => {}).done;
    expect(outcome.status).toBe('error');
    expect(outcome.message).toMatch(/Failed to start/);
  });
});

