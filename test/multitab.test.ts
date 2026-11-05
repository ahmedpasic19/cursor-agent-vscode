import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliBackend } from '../src/backend/CliBackend';
import { fromExplicitPath } from '../src/backend/cliLocator';
import { CheckpointService } from '../src/checkpoints/CheckpointService';
import { CursorStreamParser } from '../src/parser/cursorStreamJson';
import type { AgentEvent } from '../src/shared/events';
import type { HostMessage, RunRecord } from '../src/shared/protocol';
import { buildRunView, compactEvents } from '../src/shared/transcript';
import { SessionManager } from '../src/session/SessionManager';
import { TabSession } from '../src/session/TabSession';
import { HistoryStore } from '../src/storage/HistoryStore';
import { loadFixtures } from './helpers';

const cli = fromExplicitPath(resolve(import.meta.dirname, 'fake-cursor-agent.mjs'))!;
const fake = (cfg: Record<string, unknown>) => `<<fake ${JSON.stringify(cfg)}>>`;

function manager(ws: string, opts: { max?: number; checkpoints?: CheckpointService } = {}) {
  const posted: HostMessage[] = [];
  const mgr = new SessionManager({
    getBackend: () => new CliBackend(cli),
    getRunSettings: () => ({ partialOutput: true, extraArgs: [], postResultGraceMs: 2000, timeoutMs: 60_000 }),
    getMaxConcurrent: () => opts.max ?? 3,
    getDefaultMode: () => 'ask',
    getDefaultModel: () => undefined,
    getCwd: () => ws,
    post: (m) => posted.push(m),
    getCheckpoints: opts.checkpoints ? async () => opts.checkpoints : undefined,
  });
  return { mgr, posted };
}

const idle = (tabs: TabSession[]) =>
  new Promise<void>((res) => {
    const t = setInterval(() => {
      if (tabs.every((x) => !x.running)) {
        clearInterval(t);
        res();
      }
    }, 20);
  });

function expected(fixture: string): AgentEvent[] {
  const fx = loadFixtures().find((f) => f.name === fixture)!;
  const p = new CursorStreamParser({ partialOutput: fx.partial });
  return fx.lines.flatMap((l) => p.parseLine(l));
}

describe('compactEvents', () => {
  it('renders identically for every fixture', () => {
    for (const fx of loadFixtures()) {
      const p = new CursorStreamParser({ partialOutput: fx.partial });
      const evs = fx.lines.flatMap((l) => p.parseLine(l));
      const compact = compactEvents(evs);
      expect(buildRunView(compact)).toEqual(buildRunView(evs));
      if (evs.filter((e) => e.kind === 'text').length > 1) expect(compact.length).toBeLessThan(evs.length);
    }
  });
});

describe('parallel tabs', () => {
  it('two tabs stream at the same time without mixing events', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mt-'));
    const { mgr, posted } = manager(ws);
    const a = mgr.newTab();
    const b = mgr.newTab();
    mgr.send(a.id, `${fake({ fixture: 'plan-mode', delay: 8 })} plan it`, 'plan', undefined);
    mgr.send(b.id, `${fake({ fixture: 'ask-simple', delay: 8 })} ask it`, 'ask', undefined);
    let bothRunning = false;
    const t = setInterval(() => {
      const ra = a.transcript[1] as RunRecord;
      const rb = b.transcript[1] as RunRecord;
      if (ra.events.length > 2 && rb.events.length > 2 && a.running && b.running) bothRunning = true;
    }, 5);
    await idle([a, b]);
    clearInterval(t);
    expect(bothRunning).toBe(true);
    // Every streamed event went to the right tab (compare the live posts per tab).
    const live = (tabId: string) => posted.flatMap((m) => (m.type === 'run/event' && m.tabId === tabId ? [m.event] : []));
    expect(live(a.id)).toEqual(expected('plan-mode'));
    expect(live(b.id)).toEqual(expected('ask-simple'));
    // Stored transcripts are compacted but render the same.
    expect(buildRunView((a.transcript[1] as RunRecord).events)).toEqual(buildRunView(expected('plan-mode')));
    expect(buildRunView((b.transcript[1] as RunRecord).events)).toEqual(buildRunView(expected('ask-simple')));
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('runs beyond maxConcurrentRuns are queued', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mt-'));
    const { mgr } = manager(ws, { max: 1 });
    const a = mgr.newTab();
    const b = mgr.newTab();
    mgr.send(a.id, `${fake({ fixture: 'ask-simple', delay: 10 })} one`, 'ask', undefined);
    mgr.send(b.id, `${fake({ fixture: 'ask-simple', delay: 1 })} two`, 'ask', undefined);
    await new Promise((r) => setTimeout(r, 50)); // the first run starts on the next tick
    expect((a.transcript[1] as RunRecord).status).toBe('running');
    expect((b.transcript[1] as RunRecord).status).toBe('queued');
    await idle([a, b]);
    const ra = a.transcript[1] as RunRecord;
    const rb = b.transcript[1] as RunRecord;
    expect(ra.status).toBe('success');
    expect(rb.status).toBe('success');
    expect(rb.startedAt).toBeGreaterThanOrEqual(ra.endedAt! - 5);
  });

  it('closing a tab stops its run and activates a neighbour', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mt-'));
    const { mgr, posted } = manager(ws);
    const a = mgr.newTab();
    const b = mgr.newTab();
    mgr.send(b.id, `${fake({ fixture: 'ask-simple', delay: 200 })} slow`, 'ask', undefined);
    mgr.closeTab(b.id);
    await idle([b]);
    expect((b.transcript[1] as RunRecord).status).toBe('stopped');
    expect(mgr.tabs.map((t) => t.id)).toEqual([a.id]);
    expect(mgr.activeTabId).toBe(a.id);
    expect(posted.some((m) => m.type === 'tab/closed' && m.tabId === b.id)).toBe(true);
  });

  it('overlapping Agent runs: warning on both, and the other tab’s file is flagged foreign', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mt-'));
    writeFileSync(join(ws, 'a.txt'), 'A original\r\n');
    writeFileSync(join(ws, 'b.txt'), 'B original\r\n');
    const ckpt = new CheckpointService({ root: ws, gitDir: join(mkdtempSync(join(tmpdir(), 'mt-store-')), 'shadow.git') });
    const { mgr } = manager(ws, { checkpoints: ckpt });
    const A = mgr.newTab();
    const B = mgr.newTab();
    A.rename('Tab A');
    B.rename('Tab B');
    // A is slow; B starts while A runs and finishes first.
    mgr.send(A.id, `${fake({ fixture: 'edit-file', file: 'a.txt', delay: 250, actions: [{ op: 'write', path: 'a.txt', content: 'A by agent\n' }] })}`, 'agent', undefined);
    await new Promise((r) => setTimeout(r, 600)); // A's checkpoint + spawn
    mgr.send(B.id, `${fake({ fixture: 'edit-file', file: 'b.txt', delay: 1, actions: [{ op: 'write', path: 'b.txt', content: 'B by agent\n' }] })}`, 'agent', undefined);
    await idle([A, B]);
    const ra = A.transcript[1] as RunRecord;
    const rb = B.transcript[1] as RunRecord;
    expect(ra.status).toBe('success');
    expect(rb.status).toBe('success');
    expect(ra.warnings?.[0]).toContain('Tab B');
    expect(rb.warnings?.[0]).toContain('Tab A');
    // A's diff spans B's edit (it overlapped) — b.txt must be flagged as the other tab's.
    const fa = Object.fromEntries(ra.changes!.files.map((f) => [f.path, !!f.foreign]));
    expect(fa).toEqual({ 'a.txt': false, 'b.txt': true });
    // B's own diff only has b.txt (A wrote a.txt before B's pre-checkpoint).
    expect(rb.changes!.files.map((f) => `${f.path}:${!!f.foreign}`)).toEqual(['b.txt:false']);
    // Revert-all semantics for A (non-foreign only) leave B's change in place.
    for (const f of ra.changes!.files.filter((x) => !x.foreign)) await ckpt.restoreFile(ra.changes!.preSha!, f.path);
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('A original\r\n');
    expect(readFileSync(join(ws, 'b.txt'), 'utf8')).toBe('B by agent\n');
  }, 30_000);
});

describe('HistoryStore', () => {
  const dummyEvents = { onRunStarted() {}, onRunEvent() {}, onRunFinished() {}, onTabUpdated() {}, onChipsUpdated() {}, onTabReset() {}, onRunChanges() {}, onRunWarnings() {} };

  it('round-trips a tab and marks unfinished runs interrupted', () => {
    const store = new HistoryStore(mkdtempSync(join(tmpdir(), 'hist-')));
    const tab = new TabSession('C:\\ws', 'agent', 'auto', dummyEvents);
    tab.enqueue('hello there', 'agent', 'auto');
    tab.sessionId = 'sess-1';
    store.schedule(tab, true);
    store.flushSync();
    const data = store.load(tab.id)!;
    expect(data.title).toBe('hello there');
    expect(data.sessionId).toBe('sess-1');
    const restored = new TabSession(data.cwd, data.mode, data.model, dummyEvents, data);
    expect(restored.id).toBe(tab.id);
    expect((restored.transcript[1] as RunRecord).status).toBe('interrupted');
    expect(restored.sessionId).toBe('sess-1');
    expect(restored.running).toBe(false);
  });

  it('debounces streaming writes and flushes urgent ones', async () => {
    const store = new HistoryStore(mkdtempSync(join(tmpdir(), 'hist-')), { debounceMs: 100 });
    let n = 0;
    const tab = { id: 'tab_x', serialize: () => ({ ...(n++, {}), version: 1, id: 'tab_x', title: `t${n}`, titled: true, mode: 'ask', chips: [], transcript: [], createdAt: 1, updatedAt: 1 }) as never };
    for (let i = 0; i < 20; i++) store.schedule(tab, false);
    await new Promise((r) => setTimeout(r, 200));
    expect(n).toBe(1);
    store.schedule(tab, true);
    await new Promise((r) => setTimeout(r, 20));
    expect(n).toBe(2);
  });

  it('lists newest first, skips empty chats, prunes oldest closed chats only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hist-'));
    const store = new HistoryStore(dir, { limit: () => 2 });
    const mk = (id: string, updatedAt: number, msgs: number) => {
      const transcript = Array.from({ length: msgs }, (_, i) => ({ id: `m${i}`, role: 'user', text: `msg ${id}`, mode: 'ask', at: 1 }));
      writeFileSync(join(dir, 'chats', `${id}.json`), JSON.stringify({ version: 1, id, title: id, titled: true, mode: 'ask', chips: [], transcript, createdAt: 1, updatedAt }));
      const t = new Date(updatedAt);
      utimesSync(join(dir, 'chats', `${id}.json`), t, t);
    };
    mk('old', 1_000_000, 1);
    mk('mid', 2_000_000, 1);
    mk('new', 3_000_000, 1);
    mk('empty', 4_000_000, 0);
    expect(store.list(new Set(['mid'])).map((i) => `${i.id}${i.open ? '*' : ''}`)).toEqual(['new', 'mid*', 'old']);
    // Limit 2 by mtime: keep empty+new; mid is open so it survives; old goes.
    expect(store.prune(new Set(['mid']))).toEqual(['old']);
    expect(store.list(new Set()).map((i) => i.id)).toEqual(['new', 'mid']);
  });

  it('saves and loads the open-tab state; rejects unsafe ids', () => {
    const store = new HistoryStore(mkdtempSync(join(tmpdir(), 'hist-')));
    store.saveOpenState({ openTabs: ['tab_a', '../evil', 'tab_b'], activeTabId: 'tab_b' });
    expect(store.loadOpenState()).toEqual({ openTabs: ['tab_a', 'tab_b'], activeTabId: 'tab_b' });
    expect(store.load('../evil')).toBeUndefined();
  });
});
