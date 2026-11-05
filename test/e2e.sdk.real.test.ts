/**
 * End-to-end against the REAL @cursor/sdk (billed by usage). Opt-in:
 *
 *   CURSOR_SDK_E2E=1 CURSOR_API_KEY=<key> CURSOR_SDK_DIR=<folder with node_modules/@cursor/sdk> \
 *     npx vitest run test/e2e.sdk.real.test.ts
 *
 * CURSOR_SDK_DIR is where "Cursor Agent: Install SDK Backend" installed it
 * (%APPDATA%/Code/User/globalStorage/local.cursor-agent-vscode/sdk), or any `npm i @cursor/sdk` folder.
 * Runs in a throwaway temp workspace: one Ask run, one resumed Agent run that creates a file.
 */
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/shared/events';
import { SdkBackend, type SdkWorkerConfig } from '../src/sdk/SdkBackend';

const enabled = process.env.CURSOR_SDK_E2E === '1' && !!process.env.CURSOR_API_KEY && !!process.env.CURSOR_SDK_DIR;
const model = process.env.CURSOR_E2E_MODEL ?? 'composer-2.5';

describe.skipIf(!enabled)('real @cursor/sdk', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sdk-e2e-'));
  const ws = mkdtempSync(join(tmpdir(), 'sdk-e2e-ws-'));
  const workerPath = join(tmp, 'sdk-worker.cjs');
  let cfg: SdkWorkerConfig;

  beforeAll(async () => {
    await build({ entryPoints: [resolve(import.meta.dirname, '../src/sdk/worker.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: workerPath, external: ['@cursor/sdk'], logLevel: 'silent' });
    writeFileSync(join(ws, 'math.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    cfg = { nodePath: process.execPath, workerPath, sdkDir: process.env.CURSOR_SDK_DIR!, apiKey: process.env.CURSOR_API_KEY!, defaultModel: model };
  });

  const run = async (prompt: string, mode: 'agent' | 'ask' | 'plan', resumeSessionId?: string) => {
    const events: AgentEvent[] = [];
    const outcome = await new SdkBackend(cfg, (l) => console.log(l)).run(
      { cwd: ws, prompt, mode, model, resumeSessionId, partialOutput: true, extraArgs: [], postResultGraceMs: 0, timeoutMs: 240_000 },
      (e) => events.push(e),
    ).done;
    return { events, outcome };
  };

  let agentId: string | undefined;

  it('Ask: streams an answer without editing anything', async () => {
    const { events, outcome } = await run('In one sentence: what does math.ts export?', 'ask');
    expect(outcome.status).toBe('success');
    agentId = outcome.sessionId;
    expect(agentId).toBeTruthy();
    expect(events.filter((e) => e.kind === 'text').length).toBeGreaterThan(1);
    expect(events.filter((e) => e.kind === 'unknown')).toEqual([]);
    expect(events.some((e) => e.kind === 'toolCompleted' && e.tool.uiKind === 'edit')).toBe(false);
  }, 300_000);

  it('Agent (resumed): creates a file', async () => {
    const { events, outcome } = await run('Create a file notes.txt containing exactly: hi from sdk. Then reply: done.', 'agent', agentId);
    expect(outcome.status).toBe('success');
    expect(outcome.sessionId).toBe(agentId);
    expect(existsSync(join(ws, 'notes.txt'))).toBe(true);
    expect(readFileSync(join(ws, 'notes.txt'), 'utf8')).toContain('hi from sdk');
    console.log('tool kinds:', events.flatMap((e) => (e.kind === 'toolCompleted' ? [e.tool.name] : [])));
  }, 300_000);
});
