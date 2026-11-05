/**
 * End-to-end against the REAL cursor-agent (uses model usage). Opt-in:
 *   CURSOR_E2E=1 npx vitest run test/e2e.real.test.ts
 * Uses Ask mode only (read-only) in a throwaway temp workspace.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliService } from '../src/backend/CliService';
import { SessionManager } from '../src/session/SessionManager';
import type { HostMessage, RunRecord } from '../src/shared/protocol';

const enabled = process.env.CURSOR_E2E === '1';
const model = process.env.CURSOR_E2E_MODEL ?? 'composer-2.5-fast';

describe.skipIf(!enabled)('real cursor-agent', () => {
  const ws = mkdtempSync(join(tmpdir(), 'cursor-e2e-'));
  writeFileSync(join(ws, 'math.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
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
