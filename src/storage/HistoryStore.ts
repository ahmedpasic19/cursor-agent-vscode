/**
 * Chat history on disk (PLAN.md §5.7): one JSON file per chat plus a small state file with the
 * open tabs, under <globalStorage>/<workspaceHash>/. No vscode imports (unit-tested).
 *
 * Writes are debounced while streaming and flushed when a run finishes; flushSync() is for
 * deactivate(), where async work may not complete.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { chipLabel, expandChipTokens } from '../shared/inlineChips';
import type { ContextChip } from '../shared/protocol';
import { join } from 'node:path';
import type { HistoryItem } from '../shared/protocol';
import type { PersistedTab } from '../session/TabSession';

export interface OpenState {
  openTabs: string[];
  activeTabId?: string;
}

interface Snapshotable {
  id: string;
  serialize(): PersistedTab;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export class HistoryStore {
  private readonly chatsDir: string;
  private readonly stateFile: string;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly dirty = new Map<string, Snapshotable>();

  constructor(
    dir: string,
    private readonly opts: { debounceMs?: number; limit?: () => number; log?: (l: string) => void } = {},
  ) {
    this.chatsDir = join(dir, 'chats');
    this.stateFile = join(dir, 'state.json');
    mkdirSync(this.chatsDir, { recursive: true });
  }

  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`invalid chat id ${id}`);
    return join(this.chatsDir, `${id}.json`);
  }

  private writeAtomic(path: string, data: string): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }

  /** Schedule a save. `urgent` saves on the next tick; otherwise after the debounce. */
  schedule(tab: Snapshotable, urgent: boolean): void {
    this.dirty.set(tab.id, tab);
    const existing = this.timers.get(tab.id);
    if (existing && !urgent) return; // already scheduled; debounce keeps the first timer
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => this.flush(tab.id), urgent ? 0 : (this.opts.debounceMs ?? 500));
    this.timers.set(tab.id, t);
  }

  /** Write one tab now if it has pending changes. */
  flush(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    const tab = this.dirty.get(id);
    if (!tab) return;
    this.dirty.delete(id);
    try {
      this.writeAtomic(this.file(id), JSON.stringify(tab.serialize()));
    } catch (e) {
      this.opts.log?.(`[history] save ${id} failed: ${String(e)}`);
    }
  }

  /** Synchronously write everything pending (deactivate). */
  flushSync(): void {
    for (const id of [...this.dirty.keys()]) this.flush(id);
  }

  saveOpenState(state: OpenState): void {
    try {
      this.writeAtomic(this.stateFile, JSON.stringify(state));
    } catch (e) {
      this.opts.log?.(`[history] save state failed: ${String(e)}`);
    }
  }

  loadOpenState(): OpenState {
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8')) as OpenState;
      return { openTabs: Array.isArray(s.openTabs) ? s.openTabs.filter((x) => SAFE_ID.test(x)) : [], activeTabId: s.activeTabId };
    } catch {
      return { openTabs: [] };
    }
  }

  load(id: string): PersistedTab | undefined {
    try {
      const data = JSON.parse(readFileSync(this.file(id), 'utf8')) as PersistedTab;
      if (data.version !== 1 || data.id !== id || !Array.isArray(data.transcript)) return undefined;
      return data;
    } catch (e) {
      if (existsSync(join(this.chatsDir, `${id}.json`))) this.opts.log?.(`[history] could not read ${id}: ${String(e)}`);
      return undefined;
    }
  }

  delete(id: string): void {
    this.dirty.delete(id);
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    rmSync(this.file(id), { force: true });
    // Pasted images of this chat (src/context/Attachments.ts).
    rmSync(join(this.chatsDir, '..', 'attachments', id), { recursive: true, force: true });
  }

  /** All saved chats, newest first. Empty chats (no messages) are skipped. */
  list(openIds: Set<string>): HistoryItem[] {
    const items: HistoryItem[] = [];
    for (const name of readdirSync(this.chatsDir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      const data = this.load(id);
      if (!data) continue;
      const users = data.transcript.filter((t) => t.role === 'user');
      if (!users.length) continue;
      const lastRun = [...data.transcript].reverse().find((t) => t.role === 'run');
      items.push({
        lastStatus: lastRun?.role === 'run' ? lastRun.status : undefined,
        id,
        title: data.title,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        messageCount: users.length,
        preview: previewOf(users[0] as { text: string; chips?: ContextChip[] }),
        open: openIds.has(id),
      });
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Delete the oldest chats beyond the limit, never touching open tabs. Returns deleted ids. */
  prune(openIds: Set<string>): string[] {
    const limit = this.opts.limit?.() ?? 200;
    const files = readdirSync(this.chatsDir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => ({ id: n.slice(0, -5), mtime: statSync(join(this.chatsDir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const deleted: string[] = [];
    for (const f of files.slice(limit)) {
      if (openIds.has(f.id)) continue;
      this.delete(f.id);
      deleted.push(f.id);
    }
    if (deleted.length) this.opts.log?.(`[history] pruned ${deleted.length} old chat(s)`);
    return deleted;
  }
}

function previewOf(u: { text: string; chips?: ContextChip[] }): string {
  return expandChipTokens(u.text, u.chips, chipLabel).slice(0, 300);
}
