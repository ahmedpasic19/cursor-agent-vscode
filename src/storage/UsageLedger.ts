/**
 * Token usage of runs made through this extension (all workspaces): <globalStorage>/usage.jsonl.
 * One JSON line per finished run that reported usage. Entries older than RAW_DAYS are compacted
 * into one line per local day. No vscode imports (unit-tested).
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Usage } from '../shared/events';
import type { UsageTotals } from '../shared/protocol';

export interface UsageEntry {
  at: number;
  chatId?: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Number of runs this line stands for (1, or more for a compacted day). */
  runs: number;
}

const RAW_DAYS = 30;
const DAY = 86_400_000;

export const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, runs: 0 });

export function totalTokens(t: UsageTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/** Local midnight of the day containing `ts`. */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function add(t: UsageTotals, e: UsageEntry): void {
  t.input += e.input;
  t.output += e.output;
  t.cacheRead += e.cacheRead;
  t.cacheWrite += e.cacheWrite;
  t.runs += e.runs;
}

export class UsageLedger {
  private entries: UsageEntry[];

  constructor(
    private readonly file: string,
    private readonly log?: (l: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.entries = this.read();
    this.compact();
  }

  private read(): UsageEntry[] {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out: UsageEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as UsageEntry;
        if (typeof e.at === 'number') out.push({ ...e, runs: e.runs ?? 1 });
      } catch {
        // skip a torn line (crash during append)
      }
    }
    return out;
  }

  /** Records one run's usage; ignores runs that reported none. */
  record(usage: Usage | undefined, meta: { chatId?: string; model?: string } = {}): UsageEntry | undefined {
    if (!usage) return undefined;
    const e: UsageEntry = {
      at: this.now(),
      chatId: meta.chatId,
      model: meta.model,
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
      runs: 1,
    };
    if (!e.input && !e.output && !e.cacheRead && !e.cacheWrite) return undefined;
    this.entries.push(e);
    try {
      appendFileSync(this.file, JSON.stringify(e) + '\n');
    } catch (err) {
      this.log?.(`[usage] append failed: ${String(err)}`);
    }
    return e;
  }

  /** Totals since `since` (inclusive), optionally for one chat. */
  totals(since: number, chatId?: string): UsageTotals {
    const t = emptyTotals();
    for (const e of this.entries) if (e.at >= since && (!chatId || e.chatId === chatId)) add(t, e);
    return t;
  }

  /** All-time totals for one chat (compacted days drop chat ids, so this covers RAW_DAYS). */
  chatTotals(chatId: string): UsageTotals {
    return this.totals(0, chatId);
  }

  today(): UsageTotals {
    return this.totals(startOfDay(this.now()));
  }

  /** Today plus the 6 days before it. */
  week(): UsageTotals {
    return this.totals(startOfDay(this.now()) - 6 * DAY);
  }

  /** Per-model totals over the last 7 days, largest first (for "View details"). */
  byModel(): { model: string; totals: UsageTotals }[] {
    const since = startOfDay(this.now()) - 6 * DAY;
    const m = new Map<string, UsageTotals>();
    for (const e of this.entries) {
      if (e.at < since) continue;
      const k = e.model || 'default';
      const t = m.get(k) ?? emptyTotals();
      add(t, e);
      m.set(k, t);
    }
    return [...m].map(([model, totals]) => ({ model, totals })).sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals));
  }

  /** Merge raw entries older than RAW_DAYS into one entry per local day and rewrite the file. */
  private compact(): void {
    const cutoff = startOfDay(this.now()) - RAW_DAYS * DAY;
    const old = this.entries.filter((e) => e.at < cutoff && (e.chatId || e.model || e.runs === 1));
    if (!old.length) return;
    const days = new Map<number, UsageEntry>();
    const keep: UsageEntry[] = [];
    for (const e of this.entries) {
      if (e.at >= cutoff) {
        keep.push(e);
        continue;
      }
      const day = startOfDay(e.at);
      const d = days.get(day) ?? { at: day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, runs: 0 };
      d.input += e.input;
      d.output += e.output;
      d.cacheRead += e.cacheRead;
      d.cacheWrite += e.cacheWrite;
      d.runs += e.runs;
      days.set(day, d);
    }
    this.entries = [...[...days.values()].sort((a, b) => a.at - b.at), ...keep];
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
      renameSync(tmp, this.file);
    } catch (err) {
      this.log?.(`[usage] compact failed: ${String(err)}`);
    }
  }
}

/** Usage reported by a run's `result` event, if any. */
export function usageOfEvents(events: readonly { kind: string; usage?: Usage }[]): Usage | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'result' && e.usage) return e.usage;
  }
  return undefined;
}
