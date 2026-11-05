import { create } from 'zustand';
import type { AccountInfo, HostMessage, SessionGroup, SessionRow, UsageSummary } from '../../../src/shared/protocol';
import { vscodeState } from '../vscode';

export type SortKey = 'updated' | 'created';

/** UI state kept across reloads (vscode.setState). */
interface Persisted {
  accountOpen: boolean;
  sessionsOpen: boolean;
  sort: SortKey;
  activeOnly: boolean;
}

const saved = vscodeState.get<Partial<Persisted>>() ?? {};

interface SessionsStore extends Persisted {
  rows: SessionRow[];
  groups: SessionGroup[];
  activeId?: string;
  account?: AccountInfo;
  usage?: UsageSummary;
  searchRequest: number;
  notice?: { id: number; level: 'info' | 'warning' | 'error'; text: string };
  /** Lets the harness re-run "now" for relative times. */
  now: number;
  set<K extends keyof Persisted>(key: K, value: Persisted[K]): void;
  handle(msg: HostMessage): void;
  dismissNotice(): void;
}

export const useSessions = create<SessionsStore>((set, get) => ({
  accountOpen: saved.accountOpen ?? true,
  sessionsOpen: saved.sessionsOpen ?? true,
  sort: saved.sort === 'created' ? 'created' : 'updated',
  activeOnly: !!saved.activeOnly,
  rows: [],
  groups: [],
  searchRequest: 0,
  now: Date.now(),

  set(key, value) {
    set({ [key]: value } as Partial<SessionsStore>);
    const s = get();
    vscodeState.set({ accountOpen: s.accountOpen, sessionsOpen: s.sessionsOpen, sort: s.sort, activeOnly: s.activeOnly } satisfies Persisted);
  },

  dismissNotice() {
    set({ notice: undefined });
  },

  handle(msg) {
    switch (msg.type) {
      case 'sessions/state':
        set({ rows: msg.rows, groups: msg.groups, activeId: msg.activeId, now: Date.now() });
        break;
      case 'account/state':
        set({ account: msg.account, usage: msg.usage });
        break;
      case 'sessions/focusSearch':
        set({ searchRequest: get().searchRequest + 1, sessionsOpen: true });
        break;
      case 'notice':
        set({ notice: { id: Date.now(), level: msg.level, text: msg.text } });
        break;
      default:
        break; // chat-only messages
    }
  },
}));

/** "now", "21m", "3h", "1d", "2w", then a short date. */
export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** 950 → "950", 18_200 → "18.2k", 1_400_000 → "1.4M". */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
  return `${trim(n / 1_000_000_000)}B`;
}

function trim(x: number): string {
  return (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10).toString();
}

/** Case-insensitive, every word must appear in the title or first message. */
export function matchesSearch(row: SessionRow, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${row.title}\n${row.preview}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export const isActive = (r: SessionRow) => r.status === 'running' || r.status === 'queued';
