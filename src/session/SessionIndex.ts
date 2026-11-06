/**
 * Builds the Session Manager rows: saved chats (HistoryStore) merged with the live state of
 * loaded tabs. Keeps a metadata cache so a streaming run doesn't re-read every chat file.
 * No vscode imports (unit-tested).
 */
import type { HistoryItem, RunRecord, SessionRow, SessionStatus, TranscriptItem } from '../shared/protocol';
import { chipLabel, expandChipTokens } from '../shared/inlineChips';
import type { ContextChip } from '../shared/protocol';

/** The parts of a TabSession the index needs. */
export interface LiveTab {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  running: boolean;
  transcript: readonly TranscriptItem[];
}

export function statusFromRun(status: RunRecord['status'] | undefined, live: boolean): SessionStatus {
  switch (status) {
    case 'queued':
      return live ? 'queued' : 'interrupted';
    case 'running':
      return live ? 'running' : 'interrupted';
    case 'interrupted':
      return 'interrupted';
    case 'error':
    case 'timeout':
      return 'error';
    default:
      return 'idle';
  }
}

function lastRun(transcript: readonly TranscriptItem[]): RunRecord | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const t = transcript[i]!;
    if (t.role === 'run') return t;
  }
  return undefined;
}

export class SessionIndex {
  private readonly saved = new Map<string, HistoryItem>();

  /** Seed from HistoryStore.list() (once at startup). */
  seed(items: HistoryItem[]): void {
    this.saved.clear();
    for (const i of items) this.saved.set(i.id, i);
  }

  /** Refresh the cached metadata of a loaded tab (called when it changes). */
  update(tab: LiveTab): void {
    const users = tab.transcript.filter((t) => t.role === 'user');
    if (!users.length) {
      this.saved.delete(tab.id); // /clear emptied it
      return;
    }
    this.saved.set(tab.id, {
      id: tab.id,
      title: tab.title,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
      messageCount: users.length,
      preview: previewOf(users[0] as { text: string; chips?: ContextChip[] }),
      open: true,
      lastStatus: lastRun(tab.transcript)?.status,
    });
  }

  remove(id: string): void {
    this.saved.delete(id);
  }

  has(id: string): boolean {
    return this.saved.has(id);
  }

  get ids(): string[] {
    return [...this.saved.keys()];
  }

  /** Rows newest first. Loaded tabs supply live status; empty chats are not listed. */
  rows(live: Map<string, LiveTab>, unread: ReadonlySet<string>, groupOf: (id: string) => string | undefined): SessionRow[] {
    const rows: SessionRow[] = [];
    for (const item of this.saved.values()) {
      const tab = live.get(item.id);
      const status = tab
        ? tab.running
          ? lastRun(tab.transcript)?.status === 'queued'
            ? 'queued'
            : 'running'
          : statusFromRun(lastRun(tab.transcript)?.status, true)
        : statusFromRun(item.lastStatus, false);
      rows.push({
        id: item.id,
        title: tab?.title ?? item.title,
        createdAt: item.createdAt,
        updatedAt: tab?.updatedAt ?? item.updatedAt,
        preview: item.preview,
        messageCount: item.messageCount,
        status,
        unread: unread.has(item.id),
        groupId: groupOf(item.id),
      });
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

function previewOf(u: { text: string; chips?: ContextChip[] }): string {
  return expandChipTokens(u.text, u.chips, chipLabel).slice(0, 300);
}
