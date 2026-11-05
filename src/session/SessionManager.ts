import type { AgentBackend } from '../backend/AgentBackend';
import type { Mode } from '../shared/events';
import type { ContextChip, HostMessage, RunRecord } from '../shared/protocol';
import {
  type CheckpointSource,
  type OverlapTracker,
  type PersistedTab,
  type RunSettings,
  TabSession,
  type TabEvents,
} from './TabSession';

/** Sent by "Run this plan"; promptBuilder adds the switch-to-agent prefix for plan sessions. */
export const PLAN_EXECUTE_TEXT = 'Implement the plan above.';
/** Sent by "Resume" on an interrupted run. */
export const RESUME_TEXT = 'continue';

export interface ManagerDeps {
  /** Returns a backend for the current CLI, or an error message if the CLI is unavailable. */
  getBackend(): AgentBackend | string;
  getRunSettings(): RunSettings;
  getMaxConcurrent(): number;
  getDefaultMode(): Mode;
  getDefaultModel(): string | undefined;
  /** Working directory for a new tab. */
  getCwd(): string | undefined;
  /** Checkpoints for a workspace root (Agent runs). Optional: tests may omit it. */
  getCheckpoints?(root: string): Promise<CheckpointSource>;
  post(msg: HostMessage): void;
  /**
   * Persistence hook. `urgent` = something the user would hate to lose (finished run, rename,
   * chips); streaming events are not urgent and get debounced.
   */
  onTabChanged?(tab: TabSession, urgent: boolean): void;
  /** The open-tab list or active tab changed. */
  onTabsChanged?(): void;
  /** A run finished (after its record is final). */
  onRunFinished?(tab: TabSession, run: RunRecord): void;
}

interface ActiveAgentRun {
  tab: TabSession;
  run: RunRecord;
  /** Run ids of other tabs' Agent runs (same root) that overlapped in time. */
  overlaps: Set<string>;
}

/** Owns all tabs, routes webview intents, and enforces the concurrent-run limit. */
export class SessionManager implements OverlapTracker {
  readonly tabs: TabSession[] = [];
  activeTabId?: string;
  /** Sessions whose run finished while another session was shown in the chat. */
  readonly unread = new Set<string>();
  /** When each loaded tab was last shown, for unloading the least recently used. */
  private readonly lastShown = new Map<string, number>();
  private readonly queue: TabSession[] = [];
  private runningCount = 0;
  private readonly agentRuns = new Map<string, ActiveAgentRun>();

  private readonly tabEvents: TabEvents = {
    onRunStarted: (tab, user, run) => {
      this.deps.post({ type: 'run/started', tabId: tab.id, user, run: { ...run, events: [] } });
      this.changed(tab, true);
    },
    onRunEvent: (tab, run, event) => {
      this.deps.post({ type: 'run/event', tabId: tab.id, runId: run.id, event });
      this.changed(tab, false);
    },
    onRunFinished: (tab, run, outcome) => {
      if (tab.id !== this.activeTabId) this.unread.add(tab.id);
      this.deps.onRunFinished?.(tab, run);
      this.deps.post({ type: 'run/finished', tabId: tab.id, runId: run.id, status: run.status, outcome });
      this.changed(tab, true);
    },
    onTabUpdated: (tab) => {
      const { transcript: _t, chips: _c, ...meta } = tab.snapshot();
      this.deps.post({ type: 'tab/updated', tab: meta });
      this.changed(tab, true);
    },
    onChipsUpdated: (tab) => {
      this.deps.post({ type: 'chips/updated', tabId: tab.id, chips: tab.chips });
      this.changed(tab, true);
    },
    onTabReset: (tab) => {
      this.deps.post({ type: 'tab/reset', tab: tab.snapshot() });
      this.changed(tab, true);
    },
    onRunChanges: (tab, run) => {
      if (run.changes) this.deps.post({ type: 'changes/updated', tabId: tab.id, runId: run.id, changes: run.changes });
      this.changed(tab, true);
    },
    onRunWarnings: (tab, run) => {
      this.deps.post({ type: 'run/warnings', tabId: tab.id, runId: run.id, warnings: run.warnings ?? [] });
      this.changed(tab, true);
    },
  };

  constructor(private readonly deps: ManagerDeps) {}

  private changed(tab: TabSession, urgent: boolean): void {
    this.deps.onTabChanged?.(tab, urgent);
  }

  get activeTab(): TabSession | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
  }

  get runningTabs(): number {
    return this.tabs.filter((t) => t.running).length;
  }

  // ---------- tab lifecycle ----------

  /** Creates a tab and makes it active. `announce` posts tab/created + tab/activated. */
  newTab(announce = false): TabSession {
    const tab = new TabSession(this.deps.getCwd(), this.deps.getDefaultMode(), this.deps.getDefaultModel(), this.tabEvents);
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    this.lastShown.set(tab.id, Date.now());
    if (announce) {
      this.deps.post({ type: 'tab/created', tab: tab.snapshot() });
      this.deps.post({ type: 'tab/activated', tabId: tab.id });
    }
    this.deps.onTabsChanged?.();
    return tab;
  }

  /** Re-creates a tab from history (startup restore or History → open). */
  restoreTab(data: PersistedTab, announce = false): TabSession {
    const existing = this.getTab(data.id);
    if (existing) return existing;
    const tab = new TabSession(data.cwd, data.mode, data.model, this.tabEvents, data);
    this.tabs.push(tab);
    if (announce) {
      this.deps.post({ type: 'tab/created', tab: tab.snapshot() });
    }
    this.deps.onTabsChanged?.();
    return tab;
  }

  activate(tabId: string, announce = false): void {
    if (!this.getTab(tabId) || this.activeTabId === tabId) return;
    this.activeTabId = tabId;
    this.unread.delete(tabId);
    this.lastShown.set(tabId, Date.now());
    if (announce) this.deps.post({ type: 'tab/activated', tabId });
    this.deps.onTabsChanged?.();
  }

  /** Closes a tab (stopping its run). The chat stays in history. */
  closeTab(tabId: string): void {
    const i = this.tabs.findIndex((t) => t.id === tabId);
    if (i < 0) return;
    const tab = this.tabs[i]!;
    const qi = this.queue.indexOf(tab);
    if (qi >= 0) this.queue.splice(qi, 1);
    tab.stop();
    this.changed(tab, true);
    this.tabs.splice(i, 1);
    this.unread.delete(tabId);
    this.lastShown.delete(tabId);
    this.deps.post({ type: 'tab/closed', tabId });
    if (this.activeTabId === tabId) {
      const next = this.tabs[Math.min(i, this.tabs.length - 1)] ?? this.newTab(true);
      this.activeTabId = next.id;
      this.deps.post({ type: 'tab/activated', tabId: next.id });
    }
    this.deps.onTabsChanged?.();
  }

  /**
   * Drops idle background tabs from memory, least recently shown first, keeping at most `max`
   * loaded. Their chats stay in history and reload when opened again. Returns unloaded ids.
   */
  unloadIdle(max: number): string[] {
    const idle = this.tabs
      .filter((t) => t.id !== this.activeTabId && !t.running && !this.queue.includes(t))
      .sort((a, b) => (this.lastShown.get(a.id) ?? 0) - (this.lastShown.get(b.id) ?? 0));
    const out: string[] = [];
    while (this.tabs.length > Math.max(1, max) && idle.length) {
      const tab = idle.shift()!;
      this.changed(tab, true);
      this.tabs.splice(this.tabs.indexOf(tab), 1);
      this.lastShown.delete(tab.id);
      this.deps.post({ type: 'tab/closed', tabId: tab.id });
      out.push(tab.id);
    }
    if (out.length) this.deps.onTabsChanged?.();
    return out;
  }

  renameTab(tabId: string, title: string): void {
    this.getTab(tabId)?.rename(title);
  }

  ensureTab(): TabSession {
    return this.activeTab ?? this.tabs[0] ?? this.newTab();
  }

  getTab(id: string): TabSession | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  // ---------- runs ----------

  send(tabId: string, text: string, mode: Mode, model: string | undefined, chipIds: string[] = [], chipsOverride?: ContextChip[]): void {
    const tab = this.getTab(tabId);
    if (!tab || tab.running) return;
    tab.enqueue(text, mode, model, chipIds, chipsOverride);
    this.queue.push(tab);
    this.pump();
  }

  /** Resend the tab's last user message with the same mode and model. */
  retry(tabId: string): void {
    const tab = this.getTab(tabId);
    const last = tab?.lastUserMessage();
    if (!tab || !last || tab.running) return;
    // Re-attach the same context snapshot.
    this.send(tabId, last.text, last.mode, tab.model, [], last.chips ?? []);
  }

  /** "Run this plan": resume the same session in Agent mode (docs/CLI_NOTES.md §7). */
  executePlan(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab || tab.running) return;
    this.send(tabId, PLAN_EXECUTE_TEXT, 'agent', tab.model);
  }

  /** "Resume" an interrupted run: `continue` on the same session, same mode. */
  resume(tabId: string): void {
    const tab = this.getTab(tabId);
    const last = tab?.lastUserMessage();
    if (!tab || tab.running) return;
    this.send(tabId, RESUME_TEXT, last?.mode ?? tab.mode, tab.model);
  }

  stop(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    const qi = this.queue.indexOf(tab);
    if (qi >= 0) this.queue.splice(qi, 1);
    tab.stop();
  }

  stopAll(): void {
    this.queue.length = 0;
    for (const t of this.tabs) t.stop();
  }

  private pump(): void {
    while (this.runningCount < Math.max(1, this.deps.getMaxConcurrent()) && this.queue.length) {
      const tab = this.queue.shift()!;
      if (!tab.running) continue; // stopped while queued
      const backend = this.deps.getBackend();
      this.runningCount++;
      const settled = () => {
        this.runningCount--;
        this.pump();
      };
      if (typeof backend === 'string') {
        tab.failQueued(backend);
        settled();
        continue;
      }
      const ck = tab.cwd && this.deps.getCheckpoints ? this.deps.getCheckpoints(tab.cwd) : Promise.resolve(undefined);
      ck.catch(() => undefined)
        .then((checkpoints) => tab.start(backend, this.deps.getRunSettings(), { checkpoints, overlap: this }))
        .then(settled, settled);
    }
  }

  // ---------- overlapping Agent runs (PLAN.md §5.1 conflict warning, §5.6 caveat) ----------

  agentRunStarted(tab: TabSession, run: RunRecord): void {
    const mine: ActiveAgentRun = { tab, run, overlaps: new Set() };
    const root = (tab.cwd ?? '').toLowerCase();
    for (const other of this.agentRuns.values()) {
      if (other.tab === tab || (other.tab.cwd ?? '').toLowerCase() !== root) continue;
      mine.overlaps.add(other.run.id);
      other.overlaps.add(run.id);
      tab.addWarning(run, overlapWarning(other.tab.title));
      other.tab.addWarning(other.run, overlapWarning(tab.title));
    }
    this.agentRuns.set(run.id, mine);
  }

  agentRunEnded(_tab: TabSession, run: RunRecord): void {
    const entry = this.agentRuns.get(run.id);
    this.agentRuns.delete(run.id);
    // Keep finished runs reachable for overlap attribution while a partner is still running.
    if (entry && entry.overlaps.size) this.finishedOverlapping.set(run.id, entry);
    for (const [id, e] of this.finishedOverlapping) {
      if (![...e.overlaps].some((o) => this.agentRuns.has(o))) this.finishedOverlapping.delete(id);
    }
  }

  private readonly finishedOverlapping = new Map<string, ActiveAgentRun>();

  foreignPaths(_tab: TabSession, run: RunRecord): Set<string> {
    const out = new Set<string>();
    const entry = this.agentRuns.get(run.id);
    if (!entry) return out;
    for (const otherId of entry.overlaps) {
      const other = this.agentRuns.get(otherId) ?? this.finishedOverlapping.get(otherId);
      const touched = other?.tab.touched.get(otherId);
      touched?.forEach((p) => out.add(p));
    }
    return out;
  }
}

export function overlapWarning(otherTitle: string): string {
  return `Another tab (“${otherTitle}”) is also editing this workspace. Its edits can show up in this run's changes; files it edited are marked and skipped by Revert all. Consider worktree mode for parallel edits.`;
}
