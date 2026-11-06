import { mkdirSync, mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentBackend, RunOptions } from '../src/backend/AgentBackend';
import { buildArgs } from '../src/backend/CliBackend';
import { findStoreDb, setChatMode } from '../src/backend/cliChatStore';
import type { Mode } from '../src/shared/events';
import { SWITCH_TO_AGENT_PREFIX } from '../src/session/promptBuilder';
import { TabSession, type TabEvents } from '../src/session/TabSession';

const SID = '11111111-2222-3333-4444-555555555555';
const KEY = 'c2VjcmV0LWtleQ==';

function makeStore(mode: string, meta: Record<string, unknown> = {}): { chatsDir: string; db: string } {
  const chatsDir = mkdtempSync(join(tmpdir(), 'cab-chats-'));
  mkdirSync(join(chatsDir, 'otherhash'));
  const dir = join(chatsDir, 'abc123hash', SID);
  mkdirSync(dir, { recursive: true });
  const db = join(dir, 'store.db');
  const d = new DatabaseSync(db);
  d.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  const json = JSON.stringify({ agentId: SID, latestRootBlobId: 'b1', name: 'n', createdAt: 1, mode, isRunEverything: true, blobEncryptionKey: KEY, ...meta });
  d.prepare("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(json).toString('hex'));
  d.close();
  return { chatsDir, db };
}

function readMeta(db: string): Record<string, unknown> {
  const d = new DatabaseSync(db, { readOnly: true });
  const row = d.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value: string };
  d.close();
  return JSON.parse(Buffer.from(row.value, 'hex').toString('utf8'));
}

describe('cliChatStore', () => {
  it('finds the store one level below the chats dir', () => {
    const { chatsDir, db } = makeStore('search');
    expect(findStoreDb(SID, chatsDir)).toBe(db);
    expect(findStoreDb('nope', chatsDir)).toBeUndefined();
    expect(findStoreDb('../x', chatsDir)).toBeUndefined();
  });

  it('flips search → default and changes nothing else', async () => {
    const { chatsDir, db } = makeStore('search');
    const before = readMeta(db);
    expect(await setChatMode(SID, 'agent', { chatsDir })).toBe('ok');
    const after = readMeta(db);
    expect(after.mode).toBe('default');
    expect({ ...after, mode: before.mode }).toEqual(before);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(after.blobEncryptionKey).toBe(KEY);
    expect(await setChatMode(SID, 'agent', { chatsDir })).toBe('unchanged');
  });

  it('uses a child Node process when the host has no node:sqlite', async () => {
    const { chatsDir, db } = makeStore('plan');
    const p = process as { getBuiltinModule?: unknown };
    const saved = p.getBuiltinModule;
    p.getBuiltinModule = () => undefined;
    const log: string[] = [];
    try {
      expect(await setChatMode(SID, 'agent', { chatsDir, log: (l) => log.push(l) })).toBe('ok');
    } finally {
      p.getBuiltinModule = saved;
    }
    expect(readMeta(db).mode).toBe('default');
    expect(readMeta(db).blobEncryptionKey).toBe(KEY);
    expect(log.join('\n')).toContain('child process');
  });

  it('reports a missing store or an unknown format without throwing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cab-chats-'));
    expect(await setChatMode(SID, 'agent', { chatsDir: empty })).toBe('notFound');
    const { chatsDir, db } = makeStore('search');
    const d = new DatabaseSync(db);
    d.prepare("UPDATE meta SET value = 'not-hex' WHERE key = '0'").run();
    d.close();
    expect(await setChatMode(SID, 'agent', { chatsDir })).toBe('error');
  });
});

describe('buildArgs fallback', () => {
  const base: RunOptions = { cwd: '/w', prompt: 'p', mode: 'agent', partialOutput: false, extraArgs: [], postResultGraceMs: 1, timeoutMs: 1 };
  it('adds --mode plan next to --force only for the fallback', () => {
    expect(buildArgs({ ...base, switchViaPlan: true })).toEqual(expect.arrayContaining(['--force', '--mode', 'plan']));
    expect(buildArgs(base)).not.toContain('--mode');
  });
});

const noop: TabEvents = {
  onRunStarted() {},
  onRunEvent() {},
  onRunFinished() {},
  onTabUpdated() {},
  onChipsUpdated() {},
  onTabReset() {},
  onRunChanges() {},
  onRunWarnings() {},
};

function stub(setMode: boolean | undefined) {
  const runs: RunOptions[] = [];
  const calls: Array<[string, Mode]> = [];
  const backend: AgentBackend = {
    run(opts) {
      runs.push(opts);
      return { done: Promise.resolve({ status: 'success', exitCode: 0, stderrTail: [], sessionId: SID }), stop() {} };
    },
  };
  if (setMode !== undefined) {
    backend.setSessionMode = async (id, m) => {
      calls.push([id, m]);
      return setMode;
    };
  }
  return { backend, runs, calls };
}

const settings = { partialOutput: false, extraArgs: [], postResultGraceMs: 1, timeoutMs: 1000 };

async function turn(tab: TabSession, backend: AgentBackend, mode: Mode) {
  tab.enqueue('do it', mode, undefined);
  await tab.start(backend, settings);
}

describe('Ask → Agent in TabSession', () => {
  it('rewrites the stored mode and resumes without the switch prefix', async () => {
    const tab = new TabSession(tmpdir(), 'ask', undefined, noop);
    const { backend, runs, calls } = stub(true);
    await turn(tab, backend, 'ask');
    await turn(tab, backend, 'agent');
    expect(calls).toEqual([[SID, 'agent']]);
    expect(runs[1]!.resumeSessionId).toBe(SID);
    expect(runs[1]!.switchViaPlan).toBeUndefined();
    expect(runs[1]!.prompt.startsWith(SWITCH_TO_AGENT_PREFIX)).toBe(false);
    // Next agent turn: already in Agent, nothing to rewrite.
    await turn(tab, backend, 'agent');
    expect(calls).toHaveLength(1);
  });

  it('falls back to --mode plan + prefix when the store cannot be edited', async () => {
    const tab = new TabSession(tmpdir(), 'ask', undefined, noop);
    const { backend, runs, calls } = stub(false);
    await turn(tab, backend, 'ask');
    await turn(tab, backend, 'agent');
    expect(runs[1]!.switchViaPlan).toBe(true);
    expect(runs[1]!.prompt.startsWith(SWITCH_TO_AGENT_PREFIX)).toBe(true);
    // The store stays in Plan, so the next agent turn tries again.
    await turn(tab, backend, 'agent');
    expect(calls).toHaveLength(2);
    expect(runs[2]!.prompt.startsWith(SWITCH_TO_AGENT_PREFIX)).toBe(true);
  });

  it('keeps the prefix on backends without a stored mode (SDK)', async () => {
    const tab = new TabSession(tmpdir(), 'ask', undefined, noop);
    const { backend, runs } = stub(undefined);
    await turn(tab, backend, 'ask');
    await turn(tab, backend, 'agent');
    expect(runs[1]!.switchViaPlan).toBeUndefined();
    expect(runs[1]!.prompt.startsWith(SWITCH_TO_AGENT_PREFIX)).toBe(true);
  });
});
