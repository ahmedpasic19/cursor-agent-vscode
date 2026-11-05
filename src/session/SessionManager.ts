import type { AgentBackend } from '../backend/AgentBackend';
import type { Mode } from '../shared/events';
import type { HostMessage } from '../shared/protocol';
import { type RunSettings, TabSession, type TabEvents } from './TabSession';

/** Sent by "Run this plan"; promptBuilder adds the switch-to-agent prefix for plan sessions. */
export const PLAN_EXECUTE_TEXT = 'Implement the plan above.';

export interface ManagerDeps {
  /** Returns a backend for the current CLI, or an error message if the CLI is unavailable. */
  getBackend(): AgentBackend | string;
  getRunSettings(): RunSettings;
  getMaxConcurrent(): number;
  getDefaultMode(): Mode;
  getDefaultModel(): string | undefined;
  /** Working directory for a new tab. */
  getCwd(): string | undefined;
  post(msg: HostMessage): void;
}

/** Owns all tabs, routes webview intents, and enforces the concurrent-run limit. */
export class SessionManager {
  readonly tabs: TabSession[] = [];
  activeTabId?: string;
  private readonly queue: TabSession[] = [];
  private runningCount = 0;

  private readonly tabEvents: TabEvents = {
    onRunStarted: (tab, user, run) => this.deps.post({ type: 'run/started', tabId: tab.id, user, run: { ...run, events: [] } }),
    onRunEvent: (tab, run, event) => this.deps.post({ type: 'run/event', tabId: tab.id, runId: run.id, event }),
    onRunFinished: (tab, run, outcome) =>
      this.deps.post({ type: 'run/finished', tabId: tab.id, runId: run.id, status: run.status, outcome }),
    onTabUpdated: (tab) => {
      const { transcript: _t, ...meta } = tab.snapshot();
      this.deps.post({ type: 'tab/updated', tab: meta });
    },
  };

  constructor(private readonly deps: ManagerDeps) {}

  get activeTab(): TabSession | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
  }

  get runningTabs(): number {
    return this.tabs.filter((t) => t.running).length;
  }

  newTab(): TabSession {
    const tab = new TabSession(this.deps.getCwd(), this.deps.getDefaultMode(), this.deps.getDefaultModel(), this.tabEvents);
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    return tab;
  }

  /** Phase 1 is single-tab: "New chat" replaces the current tab (stopping its run). */
  replaceWithNewTab(): TabSession {
    for (const t of this.tabs.splice(0)) t.stop();
    this.queue.length = 0;
    return this.newTab();
  }

  ensureTab(): TabSession {
    return this.activeTab ?? this.newTab();
  }

  getTab(id: string): TabSession | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  send(tabId: string, text: string, mode: Mode, model: string | undefined): void {
    const tab = this.getTab(tabId);
    if (!tab || tab.running) return;
    tab.enqueue(text, mode, model);
    this.queue.push(tab);
    this.pump();
  }

  /** Resend the tab's last user message with the same mode and model. */
  retry(tabId: string): void {
    const tab = this.getTab(tabId);
    const last = tab?.lastUserMessage();
    if (!tab || !last || tab.running) return;
    this.send(tabId, last.text, last.mode, tab.model);
  }

  /** "Run this plan": resume the same session in Agent mode (docs/CLI_NOTES.md §7). */
  executePlan(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab || tab.running) return;
    this.send(tabId, PLAN_EXECUTE_TEXT, 'agent', tab.model);
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
      tab.start(backend, this.deps.getRunSettings()).then(settled, settled);
    }
  }
}
