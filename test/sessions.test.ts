import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAbout } from '../src/backend/cliCapabilities';
import type { RunRecord, TranscriptItem } from '../src/shared/protocol';
import { type LiveTab, SessionIndex, statusFromRun } from '../src/session/SessionIndex';
import { SessionManager } from '../src/session/SessionManager';
import { GroupStore } from '../src/storage/GroupStore';
import { startOfDay, UsageLedger, usageOfEvents } from '../src/storage/UsageLedger';
import { compactNumber, matchesSearch, relativeTime } from '../webview-ui/src/sessions/store';

const tmp = () => mkdtempSync(join(tmpdir(), 'ca-sessions-'));

const user = (text: string): TranscriptItem => ({ id: `m_${text}`, role: 'user', text, mode: 'ask', at: 1 });
const run = (status: RunRecord['status']): RunRecord => ({ id: `r_${status}`, role: 'run', mode: 'ask', status, events: [], startedAt: 1 });
const live = (id: string, transcript: TranscriptItem[], running = false, updatedAt = 10): LiveTab => ({
  id,
  title: `T ${id}`,
  createdAt: 1,
  updatedAt,
  running,
  transcript,
});

describe('SessionIndex', () => {
  it('maps saved run status: active runs on disk were interrupted by a restart', () => {
    expect(statusFromRun('running', false)).toBe('interrupted');
    expect(statusFromRun('queued', false)).toBe('interrupted');
    expect(statusFromRun('running', true)).toBe('running');
    expect(statusFromRun('timeout', false)).toBe('error');
    expect(statusFromRun('success', false)).toBe('idle');
    expect(statusFromRun(undefined, false)).toBe('idle');
  });

  it('merges saved chats with live tabs, newest first, with unread and groups', () => {
    const idx = new SessionIndex();
    idx.seed([
      { id: 'a', title: 'A', createdAt: 1, updatedAt: 5, messageCount: 1, preview: 'pa', open: false, lastStatus: 'running' },
      { id: 'b', title: 'B', createdAt: 1, updatedAt: 7, messageCount: 2, preview: 'pb', open: false, lastStatus: 'success' },
    ]);
    const c = live('c', [user('hi'), run('queued')], true, 9);
    idx.update(c);
    const rows = idx.rows(new Map([['c', c]]), new Set(['b']), (id) => (id === 'a' ? 'g1' : undefined));
    expect(rows.map((r) => [r.id, r.status, r.unread, r.groupId])).toEqual([
      ['c', 'queued', false, undefined],
      ['b', 'idle', true, undefined],
      ['a', 'interrupted', false, 'g1'],
    ]);
  });

  it('drops a chat that /clear emptied and never lists empty new tabs', () => {
    const idx = new SessionIndex();
    const t = live('t', [user('x'), run('success')]);
    idx.update(t);
    expect(idx.has('t')).toBe(true);
    idx.update({ ...t, transcript: [] });
    expect(idx.has('t')).toBe(false);
    idx.update(live('empty', []));
    expect(idx.rows(new Map(), new Set(), () => undefined)).toEqual([]);
  });
});

describe('SessionManager unread + unloading', () => {
  const mgr = () =>
    new SessionManager({
      getBackend: () => 'no backend in this test',
      getRunSettings: () => ({ partialOutput: true, extraArgs: [], postResultGraceMs: 0, timeoutMs: 1000 }),
      getMaxConcurrent: () => 1,
      getDefaultMode: () => 'ask',
      getDefaultModel: () => undefined,
      getCwd: () => tmpdir(),
      post: () => {},
    });

  it('marks a session unread when its run finishes in the background, clears on activate', () => {
    const m = mgr();
    const a = m.newTab();
    const b = m.newTab(); // b is active
    m.send(a.id, 'hello', 'ask', undefined); // fails at once: backend unavailable → finished
    expect(m.unread.has(a.id)).toBe(true);
    expect(m.unread.has(b.id)).toBe(false);
    m.activate(a.id);
    expect(m.unread.has(a.id)).toBe(false);
  });

  it('unloads idle tabs least recently shown first, never the active one', async () => {
    const m = mgr();
    const tabs = [m.newTab(), m.newTab(), m.newTab(), m.newTab()];
    m.activate(tabs[0]!.id); // shown last → most recent besides the active
    const gone = m.unloadIdle(2);
    expect(gone).toEqual([tabs[1]!.id, tabs[2]!.id]);
    expect(m.tabs.map((t) => t.id)).toEqual([tabs[0]!.id, tabs[3]!.id]);
    expect(m.activeTabId).toBe(tabs[0]!.id);
  });
});

describe('GroupStore', () => {
  it('creates, moves, deletes (sessions become ungrouped) and persists', () => {
    const dir = tmp();
    const g = new GroupStore(dir);
    const a = g.create('  Invoices ');
    const b = g.create('Fiscal');
    expect(a.name).toBe('Invoices');
    g.move('chat1', a.id);
    g.move('chat2', b.id);
    g.move('chat3', 'missing'); // unknown group: ignored
    g.setCollapsed(a.id, true);
    g.rename(b.id, 'Fiscalization');

    const again = new GroupStore(dir);
    expect(again.groups).toEqual([
      { id: a.id, name: 'Invoices', collapsed: true },
      { id: b.id, name: 'Fiscalization', collapsed: false },
    ]);
    expect(again.groupOf('chat1')).toBe(a.id);
    expect(again.groupOf('chat3')).toBeUndefined();

    again.delete(a.id);
    expect(again.groupOf('chat1')).toBeUndefined();
    again.forget(['chat2']);
    expect(new GroupStore(dir).groupOf('chat2')).toBeUndefined();
  });

  it('ignores a corrupt file and memberships of unknown groups', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'groups.json'), '{"groups":[{"id":"g","name":"G"}],"membership":{"x":"g","y":"nope"}}');
    const g = new GroupStore(dir);
    expect(g.groupOf('x')).toBe('g');
    expect(g.groupOf('y')).toBeUndefined();
    writeFileSync(join(dir, 'groups.json'), 'not json');
    expect(new GroupStore(dir).groups).toEqual([]);
  });
});

describe('UsageLedger', () => {
  const DAY = 86_400_000;
  const noon = (() => {
    const d = new Date(2026, 10, 5, 12, 0, 0);
    return d.getTime();
  })();

  it('sums today, the last 7 days, and per chat; skips runs without usage', () => {
    const file = join(tmp(), 'usage.jsonl');
    let now = noon - 8 * DAY;
    const l = new UsageLedger(file, undefined, () => now);
    l.record({ inputTokens: 1000, outputTokens: 1 }, { chatId: 'old' }); // 8 days ago: outside the week
    now = noon - 2 * DAY;
    l.record({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 }, { chatId: 'a', model: 'm1' });
    now = startOfDay(noon) + 1000; // just after midnight today
    l.record({ inputTokens: 7, outputTokens: 3 }, { chatId: 'a', model: 'm2' });
    expect(l.record(undefined)).toBeUndefined();
    expect(l.record({})).toBeUndefined();
    now = noon;

    expect(l.today()).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, runs: 1 });
    expect(l.week()).toEqual({ input: 107, output: 13, cacheRead: 5, cacheWrite: 0, runs: 2 });
    expect(l.chatTotals('a').runs).toBe(2);
    expect(l.byModel().map((m) => m.model)).toEqual(['m1', 'm2']);

    // Survives a reload, and a torn last line is skipped.
    writeFileSync(file, readFileSync(file, 'utf8') + '{"at":');
    const again = new UsageLedger(file, undefined, () => now);
    expect(again.week().runs).toBe(2);
  });

  it('compacts entries older than 30 days into one per day', () => {
    const file = join(tmp(), 'usage.jsonl');
    let now = noon - 40 * DAY;
    const l = new UsageLedger(file, undefined, () => now);
    l.record({ inputTokens: 1 }, { chatId: 'x' });
    now += 1000;
    l.record({ inputTokens: 2 }, { chatId: 'y' });
    now = noon;
    const again = new UsageLedger(file, undefined, () => now);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ input: 3, runs: 2 });
    expect(again.totals(0).runs).toBe(2);
  });

  it('finds the usage of a run from its result event', () => {
    expect(usageOfEvents([{ kind: 'text' }, { kind: 'result', usage: { inputTokens: 4 } }])).toEqual({ inputTokens: 4 });
    expect(usageOfEvents([{ kind: 'text' }])).toBeUndefined();
  });
});

describe('parseAbout', () => {
  it('reads tier, model and versions from about --format json', () => {
    const out = JSON.stringify({
      cliVersion: '2026.11.05-86047df',
      latestStatus: 'up_to_date',
      latestVersion: '2026.11.05-86047df',
      model: 'Auto',
      subscriptionTier: 'Pro',
      userEmail: 'dev@example.com',
      shell: 'bash',
    });
    expect(parseAbout(out)).toEqual({
      tier: 'Pro',
      model: 'Auto',
      email: 'dev@example.com',
      cliVersion: '2026.11.05-86047df',
      latestVersion: '2026.11.05-86047df',
      latestStatus: 'up_to_date',
    });
    expect(parseAbout('About Cursor CLI\n…')).toBeUndefined();
    expect(parseAbout('{"subscriptionTier":""}')).toEqual({});
  });
});

describe('sessions view helpers', () => {
  it('formats relative times like Claude Code', () => {
    const now = new Date(2026, 10, 5, 12).getTime();
    expect(relativeTime(now - 10_000, now)).toBe('now');
    expect(relativeTime(now - 21 * 60_000, now)).toBe('21m');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h');
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe('1d');
    expect(relativeTime(now - 15 * 86_400_000, now)).toBe('2w');
    expect(relativeTime(now + 5000, now)).toBe('now');
  });

  it('compacts token counts', () => {
    expect(compactNumber(950)).toBe('950');
    expect(compactNumber(18_240)).toBe('18.2k');
    expect(compactNumber(182_000)).toBe('182k');
    expect(compactNumber(1_400_000)).toBe('1.4M');
  });

  it('matches every search word in the title or first message', () => {
    const row = { id: 'x', title: 'Fix TableOffers total', preview: 'the display is wrong', createdAt: 0, updatedAt: 0, messageCount: 1, status: 'idle' as const, unread: false };
    expect(matchesSearch(row, 'tableoffers display')).toBe(true);
    expect(matchesSearch(row, 'tableoffers invoice')).toBe(false);
    expect(matchesSearch(row, '  ')).toBe(true);
  });
});
