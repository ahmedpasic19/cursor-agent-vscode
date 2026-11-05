/**
 * End-to-end against the REAL cursor-agent (uses model usage). Opt-in:
 *   CURSOR_E2E=1 npx vitest run test/e2e.real.test.ts
 * Runs in a throwaway temp workspace. Agent-mode tests use --force there only.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliService } from '../src/backend/CliService';
import { CheckpointService } from '../src/checkpoints/CheckpointService';
import { SessionManager } from '../src/session/SessionManager';
import type { HostMessage, RunRecord } from '../src/shared/protocol';

const enabled = process.env.CURSOR_E2E === '1';
const model = process.env.CURSOR_E2E_MODEL ?? 'composer-2.5-fast';

describe.skipIf(!enabled)('real cursor-agent', () => {
  const ws = mkdtempSync(join(tmpdir(), 'cursor-e2e-'));
  writeFileSync(join(ws, 'math.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  const ckpt = new CheckpointService({ root: ws, gitDir: join(mkdtempSync(join(tmpdir(), 'cursor-e2e-store-')), 'shadow.git') });
  const posted: HostMessage[] = [];
  const log: string[] = [];
  const cli = new CliService(() => '', (l) => log.push(l), { get: () => undefined, set: () => {} }, () => {});
  const mgr = new SessionManager({
    getBackend: () => cli.backend(),
    getRunSettings: () => ({ partialOutput: true, extraArgs: [], postResultGraceMs: 3000, timeoutMs: 300_000 }),
    getMaxConcurrent: () => 3,
    getDefaultMode: () => 'ask',
    getDefaultModel: () => model,
    getCwd: () => ws,
    post: (m) => posted.push(m),
    getCheckpoints: async () => ckpt,
  });

  const waitFinished = (n: number) =>
    new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (posted.filter((m) => m.type === 'run/finished').length >= n) {
          clearInterval(t);
          resolve();
        }
      }, 50);
    });

  it('CLI is ready', async () => {
    const s = await cli.refresh();
    expect(s.state).toBe('ready');
  }, 60_000);

  it('streams an answer and resumes the same session', async () => {
    const tab = mgr.newTab();
    mgr.send(tab.id, 'In one short sentence: what does math.ts export?', 'ask', model);
    await waitFinished(1);
    const deltas = posted.filter((m) => m.type === 'run/event' && m.event.kind === 'text').length;
    expect(deltas).toBeGreaterThan(1); // streamed, not one blob
    const first = tab.transcript[1] as RunRecord;
    expect(first.status).toBe('success');
    const sid = tab.sessionId;
    expect(sid).toBeTruthy();

    mgr.send(tab.id, 'What was my previous question? Quote it.', 'ask', model);
    await waitFinished(2);
    const second = tab.transcript[3] as RunRecord;
    expect(second.status).toBe('success');
    expect(tab.sessionId).toBe(sid);
    const args = log.filter((l) => l.startsWith('[run] args')).at(-1)!;
    expect(args).toContain(`"--resume","${sid}"`);
    const result = second.events.find((e) => e.kind === 'result');
    expect(result && result.kind === 'result' && result.text).toMatch(/math\.ts/);
  }, 180_000);

  it('Plan → "Run this plan" resumes the session in Agent mode and edits the file', async () => {
    const tab = mgr.newTab();
    const before = posted.filter((m) => m.type === 'run/finished').length;
    mgr.send(tab.id, 'Plan (do not implement) adding an exported multiply(a, b) function to math.ts. Two bullets max.', 'plan', model);
    await waitFinished(before + 1);
    const planRun = tab.transcript[1] as RunRecord;
    expect(planRun.status).toBe('success');
    expect(readFileSync(join(ws, 'math.ts'), 'utf8')).not.toMatch(/multiply/); // plan mode changed nothing
    const sid = tab.sessionId;

    mgr.executePlan(tab.id);
    await waitFinished(before + 2);
    const agentRun = tab.transcript[3] as RunRecord;
    expect(agentRun.mode).toBe('agent');
    expect(agentRun.status).toBe('success');
    expect(tab.sessionId).toBe(sid); // same session resumed
    const args = log.filter((l) => l.startsWith('[run] args')).at(-1)!;
    expect(args).toContain('"--force"');
    expect(args).toContain(`"--resume","${sid}"`);
    const prompt = log.filter((l) => l.startsWith('[run] prompt')).at(-1)!;
    expect(prompt).toContain('Switch to agent mode');
    expect(readFileSync(join(ws, 'math.ts'), 'utf8')).toMatch(/export function multiply/);
    const failedEdits = agentRun.events.filter((e) => e.kind === 'toolCompleted' && e.tool.uiKind === 'edit' && e.tool.error);
    console.log(`failed edits before mode switch: ${failedEdits.length}`);
  }, 300_000);

  it('Agent run editing two files + a shell command: checkpoint lists all three, revert is byte-exact', async () => {
    const CRLF = 'export const a = 1;\r\nexport const b = 2;\r\n';
    writeFileSync(join(ws, 'one.ts'), CRLF);
    writeFileSync(join(ws, 'two.ts'), 'export const two = 2;\n');
    const tab = mgr.newTab();
    const before = posted.filter((m) => m.type === 'run/finished').length;
    mgr.send(
      tab.id,
      'Do exactly these three things and nothing else: (1) in one.ts change `a = 1` to `a = 10`; ' +
        '(2) in two.ts change `two = 2` to `two = 20`; (3) run this shell command: node -e "require(\'fs\').writeFileSync(\'three.txt\', \'made by shell\')". ' +
        'Then reply with one word: done.',
      'agent',
      model,
    );
    await waitFinished(before + 1);
    const run = tab.transcript[1] as RunRecord;
    expect(run.status).toBe('success');
    expect(run.changes?.status).toBe('ready');
    const files = run.changes!.files.map((f) => `${f.status} ${f.path}`);
    console.log('changed files:', files);
    expect(files).toEqual(expect.arrayContaining(['M one.ts', 'M two.ts', 'A three.txt']));
    const shell = run.events.some((e) => e.kind === 'toolCompleted' && e.tool.uiKind === 'shell');
    expect(shell).toBe(true);
    // Revert everything and compare bytes.
    for (const f of run.changes!.files) await ckpt.restoreFile(run.changes!.preSha!, f.path);
    expect(readFileSync(join(ws, 'one.ts'))).toEqual(Buffer.from(CRLF));
    expect(readFileSync(join(ws, 'two.ts'), 'utf8')).toBe('export const two = 2;\n');
    expect(existsSync(join(ws, 'three.txt'))).toBe(false);
  }, 300_000);

  it('Stop kills the run within 1 second', async () => {
    const tab = mgr.newTab();
    const before = posted.filter((m) => m.type === 'run/finished').length;
    mgr.send(tab.id, 'Explain in detail, in at least 400 words, how JavaScript closures work.', 'ask', model);
    // Wait for streaming to start.
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (posted.some((m) => m.type === 'run/event' && m.tabId === tab.id && m.event.kind !== 'init')) {
          clearInterval(t);
          resolve();
        }
      }, 20);
    });
    const t0 = Date.now();
    mgr.stop(tab.id);
    await waitFinished(before + 1);
    const elapsed = Date.now() - t0;
    console.log(`stop took ${elapsed} ms`);
    expect((tab.transcript[1] as RunRecord).status).toBe('stopped');
    expect(elapsed).toBeLessThan(1000);
    expect(tab.running).toBe(false);
  }, 120_000);
});
