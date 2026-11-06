import { create } from 'zustand';
import type { Mode } from '../../../src/shared/events';
import type {
  ActiveEditor,
  AgentCommand,
  CliStatus,
  ContextChip,
  HostMessage,
  MentionItem,
  ModelOption,
  RunRecord,
  SessionRow,
  TabSnapshot,
  TranscriptItem,
} from '../../../src/shared/protocol';
import { applyEvent, buildRunView, type RunView } from '../../../src/shared/transcript';

export type TabMeta = Omit<TabSnapshot, 'transcript' | 'chips'>;

export interface TabState {
  meta: TabMeta;
  chips: ContextChip[];
  transcript: TranscriptItem[];
  /** Incrementally maintained render model per run id. */
  views: Record<string, RunView>;
}

interface Store {
  tabs: Record<string, TabState>;
  tabOrder: string[];
  activeTabId?: string;
  cli: CliStatus;
  defaultMode: Mode;
  /** Bumped on every streamed event so subscribers re-render. */
  tick: number;
  focusRequest: number;
  models: ModelOption[];
  modelsSource?: 'cli' | 'setting';
  commands: AgentCommand[];
  mention: { requestId: number; items: MentionItem[] };
  /** File + selection the user is looking at in the editor; undefined = no text editor focused. */
  activeEditor?: ActiveEditor;
  notice?: { id: number; level: 'info' | 'warning' | 'error'; text: string };
  /** Tabs with activity the user hasn't seen (finished or streamed while inactive). */
  unread: Record<string, boolean>;
  /** Past sessions for the header history dropdown (same rows as the Session Manager). */
  sessionRows: SessionRow[];
  sessionsAt: number;
  /** Bumped to open the history dropdown / help popover. */
  historyRequest: number;
  helpRequest: number;
  openHistory(): void;
  openHelp(): void;
  activate(tabId: string): void;
  handle(msg: HostMessage): void;
  dismissNotice(): void;
  /** Local-only notice (e.g. from a slash command). */
  showNotice(level: 'info' | 'warning' | 'error', text: string): void;
}

function tabFromSnapshot(s: TabSnapshot): TabState {
  const { transcript, chips, ...meta } = s;
  const views: Record<string, RunView> = {};
  for (const item of transcript) if (item.role === 'run') views[item.id] = buildRunView(item.events);
  return { meta, chips, transcript: [...transcript], views };
}

export const useStore = create<Store>((set, get) => ({
  tabs: {},
  tabOrder: [],
  cli: { state: 'checking' },
  defaultMode: 'agent',
  tick: 0,
  focusRequest: 0,
  models: [],
  commands: [],
  mention: { requestId: -1, items: [] },
  unread: {},
  sessionRows: [],
  sessionsAt: 0,
  historyRequest: 0,
  helpRequest: 0,

  openHistory() {
    set({ historyRequest: get().historyRequest + 1 });
  },

  openHelp() {
    set({ helpRequest: get().helpRequest + 1 });
  },

  activate(tabId) {
    const { unread } = get();
    const { [tabId]: _seen, ...rest } = unread;
    set({ activeTabId: tabId, unread: rest });
  },

  dismissNotice() {
    set({ notice: undefined });
  },

  showNotice(level, text) {
    set({ notice: { id: Date.now(), level, text } });
  },

  handle(msg) {
    const s = get();
    switch (msg.type) {
      case 'state/full': {
        const tabs: Record<string, TabState> = {};
        for (const t of msg.tabs) tabs[t.id] = tabFromSnapshot(t);
        set({
          tabs,
          tabOrder: msg.tabs.map((t) => t.id),
          activeTabId: msg.activeTabId,
          cli: msg.cli,
          defaultMode: msg.settings.defaultMode,
          tick: s.tick + 1,
        });
        break;
      }
      case 'cli/status':
        set({ cli: msg.cli });
        break;
      case 'tab/updated': {
        const tab = s.tabs[msg.tab.id];
        if (!tab) return;
        set({ tabs: { ...s.tabs, [msg.tab.id]: { ...tab, meta: msg.tab } } });
        break;
      }
      case 'run/started': {
        const tab = s.tabs[msg.tabId];
        if (!tab) return;
        const run: RunRecord = { ...msg.run, events: [] };
        set({
          tabs: {
            ...s.tabs,
            [msg.tabId]: {
              ...tab,
              transcript: [...tab.transcript, msg.user, run],
              views: { ...tab.views, [run.id]: buildRunView([]) },
            },
          },
        });
        break;
      }
      case 'run/event': {
        if (msg.tabId !== s.activeTabId && !s.unread[msg.tabId]) set({ unread: { ...s.unread, [msg.tabId]: true } });
        const tab = s.tabs[msg.tabId];
        const run = tab?.transcript.find((i): i is RunRecord => i.role === 'run' && i.id === msg.runId);
        const view = tab?.views[msg.runId];
        if (!tab || !run || !view) return;
        run.events.push(msg.event);
        if (run.status === 'queued') run.status = 'running';
        applyEvent(view, msg.event);
        // Views are mutated in place; the tick forces subscribers to re-render.
        set({ tick: s.tick + 1 });
        break;
      }
      case 'run/finished': {
        const tab = s.tabs[msg.tabId];
        if (!tab) return;
        const transcript = tab.transcript.map((i) =>
          i.role === 'run' && i.id === msg.runId ? { ...i, status: msg.status, outcome: msg.outcome, endedAt: Date.now() } : i,
        );
        set({
          tabs: { ...s.tabs, [msg.tabId]: { ...tab, transcript } },
          tick: s.tick + 1,
          unread: msg.tabId !== s.activeTabId ? { ...s.unread, [msg.tabId]: true } : s.unread,
        });
        break;
      }
      case 'tab/created':
        set({
          tabs: { ...s.tabs, [msg.tab.id]: tabFromSnapshot(msg.tab) },
          tabOrder: s.tabOrder.includes(msg.tab.id) ? s.tabOrder : [...s.tabOrder, msg.tab.id],
          tick: s.tick + 1,
        });
        break;
      case 'tab/closed': {
        const { [msg.tabId]: _gone, ...tabs } = s.tabs;
        const { [msg.tabId]: _u, ...unread } = s.unread;
        set({ tabs, unread, tabOrder: s.tabOrder.filter((id) => id !== msg.tabId) });
        break;
      }
      case 'tab/activated':
        get().activate(msg.tabId);
        break;
      case 'run/warnings': {
        const tab = s.tabs[msg.tabId];
        if (!tab) return;
        const transcript = tab.transcript.map((i) => (i.role === 'run' && i.id === msg.runId ? { ...i, warnings: msg.warnings } : i));
        set({ tabs: { ...s.tabs, [msg.tabId]: { ...tab, transcript } }, tick: s.tick + 1 });
        break;
      }
      case 'composer/focus':
        set({ focusRequest: s.focusRequest + 1 });
        break;
      case 'tab/reset':
        set({ tabs: { ...s.tabs, [msg.tab.id]: tabFromSnapshot(msg.tab) }, tick: s.tick + 1 });
        break;
      case 'chips/updated': {
        const tab = s.tabs[msg.tabId];
        if (!tab) return;
        set({ tabs: { ...s.tabs, [msg.tabId]: { ...tab, chips: msg.chips } } });
        break;
      }
      case 'editor/active':
        set({ activeEditor: msg.active });
        break;
      case 'mention/results':
        // Ignore stale responses.
        if (msg.requestId >= s.mention.requestId) set({ mention: { requestId: msg.requestId, items: msg.items } });
        break;
      case 'models/list':
        set({ models: msg.models, modelsSource: msg.source });
        break;
      case 'commands/list':
        set({ commands: msg.commands });
        break;
      case 'changes/updated': {
        const tab = s.tabs[msg.tabId];
        if (!tab) return;
        const transcript = tab.transcript.map((i) => (i.role === 'run' && i.id === msg.runId ? { ...i, changes: msg.changes } : i));
        set({ tabs: { ...s.tabs, [msg.tabId]: { ...tab, transcript } }, tick: s.tick + 1 });
        break;
      }
      case 'notice':
        set({ notice: { id: Date.now(), level: msg.level, text: msg.text } });
        break;
      case 'sessions/state':
        set({ sessionRows: msg.rows, sessionsAt: Date.now() });
        break;
      case 'history/open':
        set({ historyRequest: s.historyRequest + 1 });
        break;
    }
  },
}));
