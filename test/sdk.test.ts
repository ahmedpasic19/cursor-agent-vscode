import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CheckpointService } from '../src/checkpoints/CheckpointService';
import type { RunOptions } from '../src/backend/AgentBackend';
import type { AgentEvent } from '../src/shared/events';
import type { CliStatus, RunRecord } from '../src/shared/protocol';
import { buildRequest, listSdkModels, SdkBackend, type SdkWorkerConfig } from '../src/sdk/SdkBackend';
import { mapToolCall, SdkEventMapper } from '../src/sdk/sdkEvents';
import { nodeVersionOk, parseNodeVersion, SdkService } from '../src/sdk/SdkService';
import { ASK_MODE_TOOLS } from '../src/sdk/workerProtocol';
import { SessionManager } from '../src/session/SessionManager';

const root = resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'sdk-test-'));
const workerPath = join(tmp, 'sdk-worker.cjs');
const sdkDir = join(tmp, 'sdk');
const ws = join(tmp, 'ws');
const recordFile = join(tmp, 'record.ndjson');

beforeAll(async () => {
  // Build the real worker, and "install" the fake SDK where the worker looks for it.
  await build({ entryPoints: [join(root, 'src/sdk/worker.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: workerPath, external: ['@cursor/sdk'], logLevel: 'silent' });
  const pkg = join(sdkDir, 'node_modules', '@cursor', 'sdk');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(sdkDir, 'package.json'), '{"name":"sdk-host","private":true}');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@cursor/sdk', version: '1.3.1', main: 'index.js' }));
  copyFileSync(join(root, 'test', 'fake-sdk.cjs'), join(pkg, 'index.js'));
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'README.md'), '# demo\n');
  process.env.FAKE_SDK_RECORD = recordFile;
});

const cfg = (over: Partial<SdkWorkerConfig> = {}): SdkWorkerConfig => ({
  nodePath: process.execPath,
  workerPath,
  sdkDir,
  apiKey: 'test-key-123',
  defaultModel: 'auto',
  ...over,
});

const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  cwd: ws,
  prompt: 'hello',
  mode: 'agent',
  partialOutput: true,
  extraArgs: [],
  postResultGraceMs: 0,
  timeoutMs: 30_000,
  ...over,
});

const records = () =>
  existsSync(recordFile)
    ? readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

async function runOnce(c: SdkWorkerConfig, o: RunOptions) {
  const events: AgentEvent[] = [];
  const outcome = await new SdkBackend(c).run(o, (e) => events.push(e)).done;
  return { events, outcome };
}

describe('SDK event mapping (pure)', () => {
  it('maps SDK tool calls to the CLI-shaped ToolCallInfo the cards use', () => {
    expect(mapToolCall('c', { type: 'read', args: { path: '/a' }, result: { status: 'success', value: { content: 'x' } } }, true)).toEqual({
      callId: 'c', name: 'read', uiKind: 'read', args: { path: '/a' }, result: { content: 'x' },
    });
    expect(mapToolCall('c', { type: 'edit', args: { path: '/a' }, result: { status: 'success', value: { linesAdded: 2 } } }, true)?.result).toEqual({
      linesAdded: 2, path: '/a',
    });
    expect(mapToolCall('c', { type: 'write', args: { path: '/b' }, result: { status: 'success', value: { linesCreated: 5 } } }, true)?.result).toMatchObject({
      linesAdded: 5, linesRemoved: 0, path: '/b',
    });
    expect(mapToolCall('c', { type: 'shell', args: { command: 'ls' }, result: { status: 'error', error: { message: 'denied' } } }, true)?.error).toBe('denied');
    expect(mapToolCall('c', { type: 'createPlan', args: { plan: '# P' } }, false)?.uiKind).toBe('plan');
  });

  it('ignores bookkeeping updates and flags truly unknown ones', () => {
    const m = new SdkEventMapper(() => 1000);
    expect(m.map({ t: 'delta', update: { type: 'token-delta', tokens: 3 } })).toEqual([]);
    expect(m.map({ t: 'delta', update: { type: 'partial-tool-call' } })).toEqual([]);
    expect(m.map({ t: 'delta', update: { type: 'brand-new' } })).toEqual([{ kind: 'unknown', raw: { type: 'brand-new' } }]);
    expect(m.map({ t: 'delta', update: { type: 'thinking-delta', text: 'a' } })).toEqual([{ kind: 'thinking', text: 'a', at: 1000 }]);
    expect(m.map({ t: 'delta', update: { type: 'thinking-completed', thinkingDurationMs: 3000 } })).toEqual([{ kind: 'thinkingDone', at: 4000 }]);
  });

  it('Ask = agent mode with the SDK-enforced read-only allowlist; Plan = plan mode', () => {
    expect(buildRequest(opts({ mode: 'ask' }), 'auto')).toMatchObject({ mode: 'agent', tools: ASK_MODE_TOOLS });
    expect(buildRequest(opts({ mode: 'plan' }), 'auto')).toMatchObject({ mode: 'plan' });
    expect(buildRequest(opts({ mode: 'plan' }), 'auto')).not.toHaveProperty('tools');
    expect(buildRequest(opts({ model: 'composer-2.5' }), 'auto').model).toBe('composer-2.5');
    expect(buildRequest(opts({ resumeSessionId: 'agent-7' }), 'auto').agentId).toBe('agent-7');
    for (const t of ['edit', 'write', 'shell', 'delete', 'task', 'mcp']) expect(ASK_MODE_TOOLS).not.toContain(t);
  });
});

describe('SdkBackend with the real worker and a fake SDK', () => {
  it('streams a run: init → thinking → tool → text → result', async () => {
    const { events, outcome } = await runOnce(cfg(), opts({ prompt: 'say hi' }));
    expect(outcome.status).toBe('success');
    expect(outcome.sessionId).toMatch(/^agent-/);
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('init');
    expect(kinds).toEqual(expect.arrayContaining(['thinking', 'thinkingDone', 'toolStarted', 'toolCompleted', 'text', 'result']));
    expect(kinds.at(-1)).toBe('result');
    expect(events.filter((e) => e.kind === 'unknown')).toEqual([]);
    const text = events.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join('');
    expect(text).toBe('Hello from the fake SDK (mode=agent, tools=default).');
    const result = events.at(-1) as Extract<AgentEvent, { kind: 'result' }>;
    expect(result.usage).toMatchObject({ inputTokens: 1000, outputTokens: 42 });
    const create = records().filter((r) => r.op === 'create').at(-1)!;
    expect(create).toMatchObject({ hasKey: true, model: { id: 'auto' }, mode: 'agent', cwd: ws });
    expect(JSON.stringify(records())).not.toContain('test-key-123'); // key never leaves the env
  });

  it('follow-ups resume the same agent; Ask passes the read-only allowlist again', async () => {
    const first = await runOnce(cfg(), opts({ prompt: 'one' }));
    const id = first.outcome.sessionId!;
    const second = await runOnce(cfg(), opts({ prompt: 'two', mode: 'ask', resumeSessionId: id }));
    expect(second.outcome.status).toBe('success');
    expect(second.outcome.sessionId).toBe(id);
    const resume = records().filter((r) => r.op === 'resume').at(-1)!;
    expect(resume).toMatchObject({ agentId: id, mode: 'agent', tools: ASK_MODE_TOOLS });
    const text = second.events.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join('');
    expect(text).toContain(`tools=${ASK_MODE_TOOLS.join('|')}`);
  });

  it('Plan mode reaches the SDK as mode "plan"', async () => {
    await runOnce(cfg(), opts({ prompt: 'plan it', mode: 'plan' }));
    expect(records().filter((r) => r.op === 'send').at(-1)).toMatchObject({ mode: 'plan' });
  });

  it('stop cancels and the run ends as stopped within 1 second', async () => {
    const events: AgentEvent[] = [];
    const h = new SdkBackend(cfg()).run(opts({ prompt: 'slow please' }), (e) => events.push(e));
    while (!events.some((e) => e.kind === 'text')) await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    h.stop();
    const outcome = await h.done;
    expect(outcome.status).toBe('stopped');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('a failed run is an error with the SDK message', async () => {
    const { outcome } = await runOnce(cfg(), opts({ prompt: 'please fail' }));
    expect(outcome.status).toBe('error');
    expect(outcome.message).toBe('model exploded');
  });

  it('a rejected API key gives an actionable error', async () => {
    const { outcome } = await runOnce(cfg({ apiKey: 'bad' }), opts());
    expect(outcome.status).toBe('error');
    expect(outcome.message).toMatch(/rejected the SDK API key.*Set SDK API Key/);
  });

  it('a vanished agent suggests /clear', async () => {
    const { outcome } = await runOnce(cfg(), opts({ resumeSessionId: 'missing' }));
    expect(outcome.message).toMatch(/no longer exists.*\/clear/);
  });

  it('missing SDK install is reported, not crashed', async () => {
    const { outcome } = await runOnce(cfg({ sdkDir: join(tmp, 'nowhere') }), opts());
    expect(outcome.status).toBe('error');
    expect(outcome.message).toMatch(/not installed.*Install SDK Backend/);
  });

  it('lists models through the worker', async () => {
    expect((await listSdkModels(cfg())).models).toEqual([
      { id: 'auto', label: 'Auto' },
      { id: 'composer-2.5', label: 'Composer 2.5' },
    ]);
  });

  it('checkpoints and the Changes card work the same with the SDK backend', async () => {
    const ckpt = new CheckpointService({ root: ws, gitDir: join(tmp, 'store', 'shadow.git') });
    const mgr = new SessionManager({
      getBackend: () => new SdkBackend(cfg()),
      getRunSettings: () => ({ partialOutput: true, extraArgs: [], postResultGraceMs: 0, timeoutMs: 30_000 }),
      getMaxConcurrent: () => 3,
      getDefaultMode: () => 'agent',
      getDefaultModel: () => undefined,
      getCwd: () => ws,
      post: () => {},
      getCheckpoints: async () => ckpt,
    });
    const tab = mgr.newTab();
    mgr.send(tab.id, 'edit:src/new.ts', 'agent', undefined);
    await new Promise<void>((res) => {
      const t = setInterval(() => !tab.running && (clearInterval(t), res()), 20);
    });
    const run = tab.transcript[1] as RunRecord;
    expect(run.status).toBe('success');
    expect(run.changes?.files.map((f) => `${f.status} ${f.path}`)).toEqual(['A src/new.ts']);
    expect(tab.sessionId).toMatch(/^agent-/);
  }, 30_000);
});

describe('SdkService status', () => {
  it('parses and checks Node versions', () => {
    expect(parseNodeVersion('v22.20.0')).toEqual([22, 20, 0]);
    expect(nodeVersionOk([22, 13, 0])).toBe(true);
    expect(nodeVersionOk([22, 12, 9])).toBe(false);
    expect(nodeVersionOk([20, 99, 0])).toBe(false);
    expect(nodeVersionOk([24, 0, 0])).toBe(true);
  });

  const svc = (dir: string, key: string | undefined) => {
    const statuses: CliStatus[] = [];
    const s = new SdkService({
      sdkDir: dir,
      workerPath,
      nodePath: () => process.execPath,
      defaultModel: () => 'auto',
      getApiKey: async () => key,
      log: () => {},
      onStatus: (x) => statuses.push(x),
    });
    return { s, statuses };
  };

  it('reports not installed → no API key → ready', async () => {
    expect((await svc(join(tmp, 'empty'), 'k').s.refresh()).state).toBe('sdkNotInstalled');
    expect((await svc(sdkDir, undefined).s.refresh()).state).toBe('noApiKey');
    const ready = svc(sdkDir, 'k');
    const st = await ready.s.refresh();
    expect(st).toMatchObject({ state: 'ready', backend: 'sdk', version: 'sdk 1.3.1', features: { worktree: false } });
    expect(typeof ready.s.backend()).not.toBe('string');
    expect(await ready.s.models()).toHaveLength(2);
  });

  it('a bad Node path is an error with guidance', async () => {
    const s = new SdkService({
      sdkDir, workerPath, nodePath: () => join(tmp, 'no-node.exe'), defaultModel: () => 'auto',
      getApiKey: async () => 'k', log: () => {}, onStatus: () => {},
    });
    const st = await s.refresh();
    expect(st.state).toBe('error');
    expect(st.message).toMatch(/sdk\.nodePath/);
    expect(s.backend()).toEqual(expect.any(String));
  });
});
