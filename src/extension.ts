import * as vscode from 'vscode';
import { CliService } from './backend/CliService';
import { BeforeContentProvider } from './checkpoints/BeforeContentProvider';
import { CodeActions } from './codeActions';
import { ChangesController } from './checkpoints/ChangesController';
import { workspaceHash } from './checkpoints/CheckpointService';
import { DiffProvider } from './checkpoints/DiffProvider';
import { ActiveEditorWatcher } from './context/ActiveEditorWatcher';
import { registerAddToChat } from './context/commands';
import { fileChip } from './context/ContextCollector';
import { imageChipForPath, MAX_IMAGE_BYTES, saveImage } from './context/Attachments';
import { FileIndex } from './context/FileIndex';
import { SelectionLens } from './context/SelectionLens';
import { PlanUsageService } from './account/planUsage';
import { setCliAuthEnv } from './backend/processUtil';
import { McpView } from './mcp/McpView';
import type { Mode } from './shared/events';
import type { HostMessage, WebviewMessage, ConnectionInfo, ConnectionSetup, PlanUsageState } from './shared/protocol';
import { SessionIndex } from './session/SessionIndex';
import { SessionManager } from './session/SessionManager';
import { StatusBar } from './statusBar';
import { GroupStore } from './storage/GroupStore';
import { HistoryStore } from './storage/HistoryStore';
import { totalTokens, UsageLedger, usageOfEvents } from './storage/UsageLedger';
import { PINNED_SDK_VERSION, SdkService } from './sdk/SdkService';
import { VIEW_IDS, WebviewBridge } from './webview/WebviewBridge';

/** Idle background sessions kept in memory; older ones reload from history when opened. */
const MAX_LOADED_SESSIONS = 8;

/** Extensions can contribute to the secondary sidebar from VS Code 1.106. */
function supportsSecondarySidebar(): boolean {
  const [major = 0, minor = 0] = vscode.version.split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 106);
}

let manager: SessionManager | undefined;
let history: HistoryStore | undefined;
let saveOpenStateNow: (() => void) | undefined;

/** Returned from activate(); used by integration tests. */
export interface CursorAgentApi {
  manager: SessionManager;
  changes: ChangesController;
  history: HistoryStore;
  code: CodeActions;
  sdk: SdkService;
  cliReady(): Promise<unknown>;
}

export function activate(context: vscode.ExtensionContext): CursorAgentApi {
  const output = vscode.window.createOutputChannel('Cursor Agent');
  context.subscriptions.push(output);
  const log = (line: string) => output.appendLine(`${new Date().toISOString().slice(11, 23)} ${line}`);

  const cfg = () => vscode.workspace.getConfiguration('cursorAgent');
  const statusBar = new StatusBar();
  const before = new BeforeContentProvider();
  const fileIndex = new FileIndex(log);
  const maxChipLines = () => cfg().get<number>('context.maxChipLines', 2000);

  // History lives per workspace (the .code-workspace file, else the first folder).
  const workspaceKey =
    vscode.workspace.workspaceFile?.scheme === 'file'
      ? vscode.workspace.workspaceFile.fsPath
      : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no-workspace');
  const workspaceDir = vscode.Uri.joinPath(context.globalStorageUri, workspaceHash(workspaceKey)).fsPath;
  const store = new HistoryStore(workspaceDir, {
    limit: () => cfg().get<number>('historyLimit', 200),
    log,
  });
  history = store;
  const groups = new GroupStore(workspaceDir, log);
  const ledger = new UsageLedger(vscode.Uri.joinPath(context.globalStorageUri, 'usage.jsonl').fsPath, log);
  const index = new SessionIndex();

  // Sessions/account pushes are coalesced; these run before the manager exists (startup restore).
  let sessionsTimer: NodeJS.Timeout | undefined;
  let accountTimer: NodeJS.Timeout | undefined;
  const scheduleSessions = () => {
    sessionsTimer ??= setTimeout(() => pushSessions(), 250);
  };
  const scheduleAccount = () => {
    accountTimer ??= setTimeout(() => void pushAccount(), 100);
  };

  const cli = new CliService(
    () => cfg().get<string>('cliPath', ''),
    log,
    {
      get: (v) => context.globalState.get<string[]>(`caps:${v}`),
      set: (v, flags) => void context.globalState.update(`caps:${v}`, flags),
    },
    (status) => {
      if (useSdk()) return;
      statusBar.setCli(status);
      bridge.post({ type: 'cli/status', cli: { ...status, backend: 'cli' } });
      scheduleAccount();
    },
  );

  // Chat on the right (secondary sidebar), sessions + account on the left (activity bar).
  const secondary = supportsSecondarySidebar();
  void vscode.commands.executeCommand('setContext', 'cursorAgent:noSecondarySidebar', !secondary);
  const bridge = new WebviewBridge(
    secondary ? [VIEW_IDS.chat, VIEW_IDS.chatFallback] : [VIEW_IDS.chatFallback, VIEW_IDS.chat],
    'index',
    context.extensionUri,
    (msg) => handle(msg),
    log,
  );
  const sessionsBridge = new WebviewBridge([VIEW_IDS.sessions], 'sessions', context.extensionUri, (msg) => handleSessions(msg), log);

  // What the user is looking at (active file + selection), mirrored above the composer.
  const activeEditor = new ActiveEditorWatcher(
    (active) => bridge.post({ type: 'editor/active', active }),
    () => cfg().get<boolean>('showActiveEditor', true),
  );

  // ---- SDK backend (Phase 7): optional, selected by cursorAgent.backend ----
  const SDK_KEY = 'cursorAgent.sdkApiKey';
  const sdkDir = vscode.Uri.joinPath(context.globalStorageUri, 'sdk').fsPath;
  const sdk = new SdkService({
    sdkDir,
    workerPath: vscode.Uri.joinPath(context.extensionUri, 'dist', 'sdk-worker.cjs').fsPath,
    nodePath: () => cfg().get<string>('sdk.nodePath', '') || 'node',
    defaultModel: () => cfg().get<string>('defaultModel', '') || 'auto',
    getApiKey: async () => (await context.secrets.get(SDK_KEY)) || process.env.CURSOR_API_KEY || undefined,
    log,
    onStatus: (s) => {
      if (useSdk()) {
        statusBar.setCli(s);
        bridge.post({ type: 'cli/status', cli: s });
        scheduleAccount();
      }
    },
  });
  const useSdk = () => cfg().get<string>('backend', 'cli') === 'sdk';
  const activeStatus = () => (useSdk() ? sdk.status : cli.status);
  const refreshBackend = () => (useSdk() ? sdk.refresh() : cli.refresh());

  const setSdkKey = async () => {
    const key = await vscode.window.showInputBox({
      title: 'Cursor API key',
      prompt: 'Create one in the Cursor dashboard (Integrations → API keys). Stored in VS Code Secret Storage. Used by "CLI + API key" and the SDK backend (billed by usage).',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length < 10 ? 'That does not look like an API key.' : undefined),
    });
    if (!key) return;
    await context.secrets.store(SDK_KEY, key.trim());
    await applyCliAuth();
    void refreshBackend();
    planUsage.invalidate();
    scheduleAccount();
  };

  // ---- Connection setup: CLI + login, CLI + API key, SDK + API key ----
  const storedKey = async () => (await context.secrets.get(SDK_KEY)) || undefined;
  const connectionSetup = (): ConnectionSetup => (useSdk() ? 'sdk' : cfg().get<boolean>('cli.useApiKey', false) ? 'cliKey' : 'cliLogin');
  /** CLI + API key: every CLI process gets CURSOR_API_KEY from Secret Storage. */
  const applyCliAuth = async () => {
    const key = connectionSetup() === 'cliKey' ? await storedKey() : undefined;
    setCliAuthEnv(key ? { CURSOR_API_KEY: key } : {});
  };
  const connectionInfo = async (): Promise<ConnectionInfo> => {
    const saved = await storedKey();
    const env = process.env.CURSOR_API_KEY;
    const key = saved ?? env;
    return { setup: connectionSetup(), hasKey: !!key, keyHint: key ? key.slice(-4) : undefined, keyFromEnv: !saved && !!env };
  };
  const setConnection = async (setup: ConnectionSetup) => {
    const g = vscode.ConfigurationTarget.Global;
    await cfg().update('cli.useApiKey', setup === 'cliKey', g);
    await cfg().update('backend', setup === 'sdk' ? 'sdk' : 'cli', g);
    await applyCliAuth();
    if (setup !== 'cliLogin' && !(await connectionInfo()).hasKey) await setSdkKey();
    if (setup !== 'sdk') void cli.refresh();
    scheduleAccount();
  };
  const clearKey = async () => {
    await context.secrets.delete(SDK_KEY);
    await applyCliAuth();
    void refreshBackend();
    planUsage.invalidate();
    scheduleAccount();
  };

  // ---- Cursor plan usage (Included / Auto / API / On-Demand) ----
  const planUsage = new PlanUsageService(storedKey, log);
  let planState: PlanUsageState | undefined;
  const refreshPlan = (force = false) => {
    void planUsage.get(force).then((res) => {
      const next: PlanUsageState = res.ok ? { status: 'ok', usage: res.usage } : { status: res.reason, message: res.message };
      if (JSON.stringify(next) === JSON.stringify(planState)) return;
      planState = next;
      scheduleAccount();
    });
  };

  const installSdk = async () => {
    const task = new vscode.Task(
      { type: 'cursorAgent', task: 'install-sdk' },
      vscode.TaskScope.Global,
      `Install @cursor/sdk ${PINNED_SDK_VERSION}`,
      'Cursor Agent',
      new vscode.ProcessExecution(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
        'install',
        '--prefix',
        sdkDir,
        `@cursor/sdk@${PINNED_SDK_VERSION}`,
        '--no-audit',
        '--no-fund',
      ]),
    );
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(sdkDir));
    const exec = await vscode.tasks.executeTask(task);
    const sub = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution !== exec) return;
      sub.dispose();
      if (e.exitCode === 0) void vscode.window.showInformationMessage(`@cursor/sdk ${PINNED_SDK_VERSION} installed.`);
      else void vscode.window.showErrorMessage(`Installing @cursor/sdk failed (exit code ${e.exitCode}). See the task terminal.`);
      void sdk.refresh();
    });
  };

  const post = (m: HostMessage) => {
    bridge.post(m);
    if (m.type === 'tab/updated') statusBar.setRunning(mgr.runningTabs);
  };

  const mgr: SessionManager = new SessionManager({
    getBackend: () => (useSdk() ? sdk.backend() : cli.backend()),
    getRunSettings: () => ({
      partialOutput: cfg().get<boolean>('streamPartialOutput', true),
      extraArgs: cfg().get<string[]>('extraArgs', []),
      postResultGraceMs: cfg().get<number>('postResultGraceMs', 3000),
      timeoutMs: cfg().get<number>('runTimeoutMinutes', 30) * 60_000,
      worktreeSupported: cli.status.features?.worktree ?? false,
      workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      approveMcps: cfg().get<boolean>('approveMcps', false),
      pluginDirs: cfg().get<string[]>('pluginDirs', []).filter(Boolean),
    }),
    getMaxConcurrent: () => cfg().get<number>('maxConcurrentRuns', 3),
    getDefaultMode: () => cfg().get<Mode>('defaultMode', 'agent'),
    getDefaultModel: () => cfg().get<string>('defaultModel', '') || undefined,
    getCwd,
    post,
    getCheckpoints: (root) => changes.sourceFor(root),
    onTabChanged: (tab, urgent) => {
      store.schedule(tab, urgent);
      scheduleSessions();
    },
    onTabsChanged: () => {
      saveOpenState();
      scheduleSessions();
      scheduleAccount();
    },
    onRunFinished: (tab, run) => {
      if (ledger.record(usageOfEvents(run.events), { chatId: tab.id, model: run.model ?? tab.model })) scheduleAccount();
    },
  });
  manager = mgr;

  const saveOpenState = () => store.saveOpenState({ openTabs: mgr.tabs.map((t) => t.id), activeTabId: mgr.activeTabId });
  saveOpenStateNow = saveOpenState;

  // Restore the tabs that were open last time (PLAN.md §5.7).
  {
    const state = store.loadOpenState();
    for (const id of state.openTabs) {
      const data = store.load(id);
      if (data) mgr.restoreTab(data);
    }
    if (mgr.tabs.length) {
      mgr.activeTabId = mgr.getTab(state.activeTabId ?? '')?.id ?? mgr.tabs[0]!.id;
      log(`[history] restored ${mgr.tabs.length} tab(s)`);
    }
    groups.forget(store.prune(new Set(mgr.tabs.map((t) => t.id))));
    index.seed(store.list(new Set(mgr.tabs.map((t) => t.id))));
    mgr.unloadIdle(MAX_LOADED_SESSIONS);
  }

  // ---- Session Manager and Account & Usage (left view) ----
  const pushSessions = () => {
    if (sessionsTimer) clearTimeout(sessionsTimer);
    sessionsTimer = undefined;
    for (const t of mgr.tabs) index.update(t);
    const live = new Map(mgr.tabs.map((t) => [t.id, t]));
    const state = {
      type: 'sessions/state' as const,
      rows: index.rows(live, mgr.unread, (id) => groups.groupOf(id)),
      groups: groups.groups,
      activeId: mgr.activeTabId,
    };
    sessionsBridge.post(state);
    // The chat header's history dropdown lists the same rows.
    bridge.post(state);
  };

  const pushAccount = async () => {
    if (accountTimer) clearTimeout(accountTimer);
    accountTimer = undefined;
    const status = activeStatus();
    const sdkMode = useSdk();
    const about = sdkMode ? undefined : await cli.about();
    const connection = await connectionInfo();
    refreshPlan();
    const active = mgr.activeTab;
    sessionsBridge.post({
      type: 'account/state',
      account: {
        backend: sdkMode ? 'sdk' : 'cli',
        state: status.state,
        email: status.email ?? about?.email,
        tier: about?.tier,
        model: about?.model ?? (cfg().get<string>('defaultModel', '') || undefined),
        version: status.version,
        latest:
          about?.latestStatus === 'up_to_date'
            ? 'up to date'
            : about?.latestVersion && about.latestVersion !== status.version
              ? `update available: ${about.latestVersion}`
              : undefined,
        message: status.message,
      },
      usage: {
        session: active ? ledger.chatTotals(active.id) : undefined,
        today: ledger.today(),
        week: ledger.week(),
        dailyBudget: Math.max(0, cfg().get<number>('usage.dailyTokenBudget', 0)),
      },
      plan: planState ?? { status: 'loading' },
      connection,
    });
  };

  const revealChat = async () => {
    await bridge.reveal();
    bridge.post({ type: 'composer/focus' });
  };

  const openSession = (id: string): boolean => {
    if (!mgr.getTab(id)) {
      const data = store.load(id);
      if (!data) return false;
      mgr.restoreTab(data, true);
    }
    mgr.activate(id, true);
    mgr.unloadIdle(MAX_LOADED_SESSIONS);
    scheduleSessions();
    return true;
  };

  const deleteSession = async (id: string) => {
    const title = mgr.getTab(id)?.title ?? store.load(id)?.title;
    const ok =
      (await vscode.window.showWarningMessage(
        `Delete “${title ?? 'this chat'}”?`,
        { modal: true, detail: 'The chat and its history are removed. Files the agent changed stay as they are. This cannot be undone.' },
        'Delete',
      )) === 'Delete';
    if (!ok) return;
    if (mgr.getTab(id)) mgr.closeTab(id);
    store.delete(id);
    index.remove(id);
    groups.forget([id]);
    pushSessions();
  };

  const newGroup = async () => {
    const name = await vscode.window.showInputBox({
      title: 'New group',
      prompt: 'Name for the session group',
      validateInput: (v) => (v.trim() ? undefined : 'Enter a name.'),
    });
    if (!name?.trim()) return;
    groups.create(name);
    pushSessions();
  };

  const fmt = (n: number) => n.toLocaleString('en-US');
  const showAccountDetails = async () => {
    const status = activeStatus();
    const about = useSdk() ? undefined : await cli.about(true);
    const newer = about?.latestVersion && about.latestVersion !== status.version ? ` (latest ${about.latestVersion})` : '';
    const items: vscode.QuickPickItem[] = [
      { label: 'Account', kind: vscode.QuickPickItemKind.Separator },
      { label: 'Backend', description: useSdk() ? 'SDK (API key, billed by usage)' : 'CLI (Cursor subscription)' },
      { label: 'Email', description: status.email ?? about?.email ?? '—' },
      { label: 'Plan', description: about?.tier ?? '—' },
      { label: 'Default model', description: about?.model ?? '—' },
      { label: 'CLI version', description: `${status.version ?? '—'}${newer}` },
      { label: 'Tokens used through this extension, last 7 days', kind: vscode.QuickPickItemKind.Separator },
    ];
    const models = ledger.byModel();
    if (!models.length) items.push({ label: 'No runs with token usage yet' });
    for (const m of models) {
      const t = m.totals;
      items.push({
        label: m.model,
        description: `${fmt(totalTokens(t))} tokens · ${t.runs} run${t.runs === 1 ? '' : 's'}`,
        detail: `input ${fmt(t.input)} · output ${fmt(t.output)} · cache read ${fmt(t.cacheRead)} · cache write ${fmt(t.cacheWrite)}`,
      });
    }
    const dashboard = '$(link-external) Open Cursor dashboard';
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: dashboard, detail: 'Plan limits and billing are shown there.' },
    );
    const pick = await vscode.window.showQuickPick(items, { title: 'Cursor account & usage', matchOnDescription: true });
    if (pick?.label === dashboard) void vscode.env.openExternal(vscode.Uri.parse('https://cursor.com/dashboard'));
  };

  const logout = async () => {
    const ok =
      (await vscode.window.showWarningMessage('Log out of the Cursor CLI?', { modal: true, detail: 'Runs stop working until you log in again.' }, 'Log out')) ===
      'Log out';
    if (!ok) return;
    const err = await cli.logout();
    if (err) void vscode.window.showErrorMessage(`Cursor Agent: logout failed — ${err}`);
  };

  /** Clock button, /history and "Cursor: Show Sessions": the dropdown in the chat panel. */
  const showSessions = async () => {
    await bridge.reveal();
    pushSessions();
    bridge.post({ type: 'history/open' });
  };

  function handleSessions(msg: WebviewMessage): void {
    switch (msg.type) {
      case 'ready':
        pushSessions();
        void pushAccount();
        sessionsBridge.flushPending();
        break;
      case 'session/open':
        if (!openSession(msg.id)) {
          sessionsBridge.post({ type: 'notice', level: 'error', text: 'That chat could not be loaded.' });
          index.remove(msg.id);
          pushSessions();
          break;
        }
        void revealChat();
        break;
      case 'tab/new':
        mgr.newTab(true);
        scheduleSessions();
        void revealChat();
        break;
      case 'tab/rename': {
        const loaded = mgr.getTab(msg.tabId);
        if (loaded) loaded.rename(msg.title);
        else {
          const data = store.load(msg.tabId);
          if (data) {
            mgr.restoreTab(data).rename(msg.title);
            mgr.unloadIdle(MAX_LOADED_SESSIONS);
          }
        }
        scheduleSessions();
        break;
      }
      case 'session/delete':
        void deleteSession(msg.id);
        break;
      case 'session/move':
        groups.move(msg.id, msg.groupId);
        pushSessions();
        break;
      case 'group/create':
        groups.create(msg.name);
        pushSessions();
        break;
      case 'group/rename':
        groups.rename(msg.id, msg.name);
        pushSessions();
        break;
      case 'group/delete':
        groups.delete(msg.id);
        pushSessions();
        break;
      case 'group/toggle':
        groups.setCollapsed(msg.id, msg.collapsed);
        pushSessions();
        break;
      case 'account/details':
        void showAccountDetails();
        break;
      case 'auth/logout':
        void logout();
        break;
      case 'connection/setup':
        void setConnection(msg.setup);
        break;
      case 'apiKey/clear':
        void clearKey();
        break;
      case 'link/open': {
        // Only Cursor's own pages: the URL comes from the webview.
        const uri = vscode.Uri.parse(msg.url);
        if (uri.scheme === 'https' && (uri.authority === 'cursor.com' || uri.authority.endsWith('.cursor.com'))) void vscode.env.openExternal(uri);
        break;
      }
      case 'auth/login':
      case 'cli/refresh':
      case 'settings/open':
      case 'backend/switch':
      case 'sdk/install':
      case 'sdk/setKey':
      case 'log/show':
        handle(msg);
        break;
    }
  }

  const changes: ChangesController = new ChangesController(context.globalStorageUri, mgr, cfg, log, (tab, run) => {
    if (run.changes) post({ type: 'changes/updated', tabId: tab.id, runId: run.id, changes: run.changes });
  });
  const code = new CodeActions(before, (level, text) => bridge.post({ type: 'notice', level, text }));
  const reportError = (what: string) => (e: unknown) => {
    log(`[changes] ${what} failed: ${e instanceof Error ? e.stack : String(e)}`);
    void vscode.window.showErrorMessage(`Cursor Agent: ${what} failed — ${e instanceof Error ? e.message : String(e)}`);
  };

  const sendFullState = () => {
    mgr.ensureTab();
    bridge.post({
      type: 'state/full',
      tabs: mgr.tabs.map((t) => t.snapshot()),
      activeTabId: mgr.activeTabId,
      cli: activeStatus(),
      settings: { defaultMode: cfg().get<Mode>('defaultMode', 'agent') },
    });
    bridge.flushPending();
    void sendModels();
  };

  const sendModels = async (force = false) => {
    const fromCli = useSdk() ? await sdk.models(force) : await cli.models(force);
    if (fromCli.length) {
      bridge.post({ type: 'models/list', models: fromCli, source: 'cli' });
    } else {
      const ids = cfg().get<string[]>('models', []);
      bridge.post({ type: 'models/list', models: ids.map((id) => ({ id, label: id })), source: 'setting' });
    }
  };

  let loginTerminal: vscode.Terminal | undefined;
  const login = () => {
    if (loginTerminal && loginTerminal.exitStatus === undefined) {
      loginTerminal.show();
      return;
    }
    const launch = cli.terminalLaunch(['login']);
    if (launch) {
      loginTerminal = vscode.window.createTerminal({ name: 'Cursor Agent login', ...launch });
    } else {
      loginTerminal = vscode.window.createTerminal({ name: 'Cursor Agent login' });
      loginTerminal.sendText('cursor-agent login');
    }
    loginTerminal.show();
  };

  function handle(msg: WebviewMessage): void {
    switch (msg.type) {
      case 'ready':
        sendFullState();
        pushSessions();
        // The panel reloaded: it has no active-editor state yet.
        activeEditor.invalidate();
        activeEditor.push();
        break;
      case 'session/open':
        if (!openSession(msg.id)) {
          bridge.post({ type: 'notice', level: 'error', text: 'That chat could not be loaded.' });
          index.remove(msg.id);
          pushSessions();
          break;
        }
        bridge.post({ type: 'composer/focus' });
        break;
      case 'context/add': {
        const command =
          msg.what === 'selection'
            ? 'cursorAgent.addSelectionToChat'
            : msg.what === 'activeFile'
              ? 'cursorAgent.addFileToChat'
              : 'cursorAgent.addProblemsToChat';
        void vscode.commands.executeCommand(command);
        break;
      }
      case 'tab/new':
        mgr.newTab(true);
        break;
      case 'tab/rename':
        mgr.renameTab(msg.tabId, msg.title);
        break;
      case 'sessions/show':
        bridge.post({ type: 'history/open' });
        break;
      case 'sessions/reveal':
        void sessionsBridge.reveal().then(() => sessionsBridge.post({ type: 'sessions/focusSearch' }));
        break;
      case 'run/resume':
        mgr.resume(msg.tabId);
        break;
      case 'message/send':
        mgr.send(msg.tabId, msg.text, msg.mode, msg.model, msg.chipIds);
        break;
      case 'chip/remove':
        mgr.getTab(msg.tabId)?.removeChip(msg.chipId);
        break;
      case 'mention/search': {
        // Several folders open: search all of them (the agent gets the others via --add-dir).
        const folders = vscode.workspace.workspaceFolders ?? [];
        const root = mgr.getTab(msg.tabId)?.cwd ?? getCwd();
        const roots = folders.length > 1 ? folders.map((f) => ({ root: f.uri.fsPath, folder: f.name })) : root ? [{ root }] : [];
        if (!roots.length) {
          bridge.post({ type: 'mention/results', requestId: msg.requestId, items: [] });
          break;
        }
        void fileIndex.searchAll(roots, msg.query).then((items) =>
          bridge.post({ type: 'mention/results', requestId: msg.requestId, items }),
        );
        break;
      }
      case 'mention/pick': {
        const tab = mgr.getTab(msg.tabId);
        const root = msg.root ?? tab?.cwd ?? getCwd();
        if (!tab || !root) break;
        void fileChip(vscode.Uri.joinPath(vscode.Uri.file(root), msg.path)).then((chip) => {
          if (chip) tab.addChip(chip, maxChipLines());
        });
        break;
      }
      case 'image/add': {
        const tab = mgr.getTab(msg.tabId);
        if (!tab) break;
        try {
          tab.addChip(saveImage(workspaceDir, tab.id, msg), maxChipLines());
        } catch (e) {
          bridge.post({ type: 'notice', level: 'error', text: e instanceof Error ? e.message : String(e) });
        }
        break;
      }
      case 'image/addUris': {
        const tab = mgr.getTab(msg.tabId);
        if (!tab) break;
        void (async () => {
          for (const u of msg.uris) {
            try {
              const uri = vscode.Uri.parse(u, true);
              if (uri.scheme !== 'file') continue;
              const stat = await vscode.workspace.fs.stat(uri);
              const chip = imageChipForPath(uri.fsPath, stat.size);
              if (!chip) continue;
              if (stat.size > MAX_IMAGE_BYTES) throw new Error(`${chip.name} is over the 10 MB limit.`);
              tab.addChip(chip, maxChipLines());
            } catch (e) {
              bridge.post({ type: 'notice', level: 'error', text: e instanceof Error ? e.message : String(e) });
            }
          }
        })();
        break;
      }
      case 'tab/clear':
        mgr.getTab(msg.tabId)?.clear();
        break;
      case 'tab/setModel': {
        const tab = mgr.getTab(msg.tabId);
        if (tab) {
          tab.model = msg.model || undefined;
          post({ type: 'tab/updated', tab: (({ transcript: _t, chips: _c, ...m }) => m)(tab.snapshot()) });
        }
        break;
      }
      case 'models/refresh':
        void sendModels(true);
        break;
      case 'changes/openDiff':
        changes.openDiff(msg.tabId, msg.runId, msg.path).catch(reportError('Open diff'));
        break;
      case 'changes/revertFile':
        changes.revertFile(msg.tabId, msg.runId, msg.path).catch(reportError('Revert'));
        break;
      case 'changes/keepFile':
        changes.keepFile(msg.tabId, msg.runId, msg.path);
        break;
      case 'changes/revertAll':
        changes.revertAll(msg.tabId, msg.runId).catch(reportError('Revert all'));
        break;
      case 'changes/keepAll':
        changes.keepAll(msg.tabId, msg.runId);
        break;
      case 'checkpoint/restore':
        changes.restoreToMessage(msg.tabId, msg.userMessageId).catch(reportError('Restore'));
        break;
      case 'run/stop':
        mgr.stop(msg.tabId);
        break;
      case 'run/retry':
        mgr.retry(msg.tabId);
        break;
      case 'plan/execute':
        mgr.executePlan(msg.tabId);
        break;
      case 'file/open':
        void openFile(msg.path, msg.line, msg.endLine);
        break;
      case 'tool/openDiff':
        void openBeforeDiff(before, msg.path, msg.before ?? '');
        break;
      case 'auth/login':
        login();
        break;
      case 'cli/refresh':
        void refreshBackend().then(() => sendModels(true));
        break;
      case 'sdk/install':
        void installSdk();
        break;
      case 'sdk/setKey':
        void setSdkKey();
        break;
      case 'backend/switch':
        void cfg().update('backend', msg.backend, vscode.ConfigurationTarget.Global);
        break;
      case 'settings/open':
        void vscode.commands.executeCommand('workbench.action.openSettings', msg.query ?? 'cursorAgent');
        break;
      case 'log/show':
        output.show(true);
        break;
      case 'code/copy':
        code.copy(msg.code).then(() => bridge.post({ type: 'notice', level: 'info', text: 'Copied to clipboard.' }), reportError('Copy'));
        break;
      case 'code/insert':
        code.insert(msg.code).catch(reportError('Insert'));
        break;
      case 'code/apply':
        code.apply(mgr.getTab(msg.tabId)?.cwd ?? getCwd(), msg.path, msg.code).catch(reportError('Apply'));
        break;
      case 'tab/setWorktree':
        mgr.getTab(msg.tabId)?.setWorktree(msg.enabled);
        break;
      case 'worktree/open':
        void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(msg.path), { forceNewWindow: true });
        break;
    }
  }

  context.subscriptions.push(
    statusBar,
    vscode.workspace.registerTextDocumentContentProvider(BeforeContentProvider.scheme, before),
    vscode.workspace.registerTextDocumentContentProvider(DiffProvider.scheme, new DiffProvider((root) => changes.service(root))),
    ...[VIEW_IDS.chat, VIEW_IDS.chatFallback].map((id) =>
      vscode.window.registerWebviewViewProvider(id, bridge, { webviewOptions: { retainContextWhenHidden: true } }),
    ),
    vscode.window.registerWebviewViewProvider(VIEW_IDS.sessions, sessionsBridge, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('cursorAgent.newChat', async () => {
      await bridge.reveal();
      mgr.newTab(true);
      bridge.post({ type: 'composer/focus' });
    }),
    vscode.commands.registerCommand('cursorAgent.showHistory', showSessions),
    vscode.commands.registerCommand('cursorAgent.focusSessions', () => sessionsBridge.reveal()),
    vscode.commands.registerCommand('cursorAgent.openSettings', async () => {
      await sessionsBridge.reveal();
      sessionsBridge.post({ type: 'settings/focus' });
    }),
    vscode.commands.registerCommand('cursorAgent.newGroup', newGroup),
    vscode.commands.registerCommand('cursorAgent.refreshAccount', () => {
      refreshPlan(true);
      void refreshBackend()
        .then(() => (useSdk() ? undefined : cli.about(true)))
        .then(() => pushAccount());
    }),
    vscode.commands.registerCommand('cursorAgent.focusChat', async () => {
      await bridge.reveal();
      bridge.post({ type: 'composer/focus' });
    }),
    vscode.commands.registerCommand('cursorAgent.stop', () => {
      if (mgr.activeTabId) mgr.stop(mgr.activeTabId);
    }),
    vscode.commands.registerCommand('cursorAgent.showLog', () => output.show(true)),
    vscode.commands.registerCommand('cursorAgent.login', login),
    vscode.window.onDidCloseTerminal((t) => {
      if (t === loginTerminal) {
        loginTerminal = undefined;
        void cli.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cursorAgent.cliPath')) void cli.refresh();
      if (e.affectsConfiguration('cursorAgent.usage.dailyTokenBudget')) scheduleAccount();
      if (e.affectsConfiguration('cursorAgent.showActiveEditor')) activeEditor.push();
      if (e.affectsConfiguration('cursorAgent.cli.useApiKey')) {
        void applyCliAuth().then(() => cli.refresh());
        scheduleAccount();
      }
      if (e.affectsConfiguration('cursorAgent.backend') || e.affectsConfiguration('cursorAgent.sdk.nodePath')) {
        log(`[backend] switched to ${useSdk() ? 'sdk' : 'cli'}`);
        void refreshBackend().then((s) => {
          statusBar.setCli(s);
          bridge.post({ type: 'cli/status', cli: s });
          void sendModels(true);
        });
      }
    }),
    vscode.commands.registerCommand('cursorAgent.setSdkApiKey', setSdkKey),
    vscode.commands.registerCommand('cursorAgent.clearSdkApiKey', async () => {
      await clearKey();
      void vscode.window.showInformationMessage('Cursor API key removed.');
    }),
    vscode.commands.registerCommand('cursorAgent.installSdk', installSdk),
    fileIndex,
    activeEditor,
    code,
    { dispose: () => mgr.stopAll() },
    {
      dispose: () => {
        if (sessionsTimer) clearTimeout(sessionsTimer);
        if (accountTimer) clearTimeout(accountTimer);
      },
    },
  );

  registerAddToChat(context, {
    manager: mgr,
    reveal: () => bridge.reveal(),
    focusComposer: () => bridge.post({ type: 'composer/focus' }),
    notice: (level, text) => bridge.post({ type: 'notice', level, text }),
    maxChipLines,
    log,
  });
  const mcpView = new McpView(context, cli, log);
  mcpView.register();
  context.subscriptions.push(mcpView);
  const lens = new SelectionLens(() => cfg().get<boolean>('selectionCodeLens', true), process.platform === 'darwin' ? 'Cmd+I' : 'Ctrl+I');
  context.subscriptions.push(lens, vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lens), vscode.languages.registerCodeLensProvider({ scheme: 'untitled' }, lens));

  log('Cursor Agent activated');
  const ready = applyCliAuth().then((): Promise<unknown> => (useSdk() ? Promise.all([cli.refresh(), sdk.refresh()]) : cli.refresh()));
  return { manager: mgr, changes, history: store, code, sdk, cliReady: () => ready };
}

export function deactivate(): void {
  // Save first, so runs still in progress are recorded as running → "Interrupted" on restore.
  saveOpenStateNow?.();
  history?.flushSync();
  manager?.stopAll();
}

/** Workspace folder of the active editor, else the first folder. */
function getCwd(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const folder = (uri && vscode.workspace.getWorkspaceFolder(uri)) ?? vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

function resolveUri(path: string): vscode.Uri {
  const root = getCwd();
  return /^([a-zA-Z]:[\\/]|\/)/.test(path) || !root ? vscode.Uri.file(path) : vscode.Uri.joinPath(vscode.Uri.file(root), path);
}

async function openFile(path: string, line?: number, endLine?: number): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(resolveUri(path));
    const start = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    const end = endLine && endLine > (line ?? 1) ? new vscode.Position(endLine - 1, Number.MAX_SAFE_INTEGER) : start;
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(start, end), preview: true });
  } catch {
    void vscode.window.showWarningMessage(`Could not open ${path}`);
  }
}

async function openBeforeDiff(provider: BeforeContentProvider, path: string, beforeText: string): Promise<void> {
  const fileUri = resolveUri(path);
  const left = provider.register(fileUri.fsPath, beforeText);
  const name = fileUri.fsPath.split(/[\\/]/).pop();
  await vscode.commands.executeCommand('vscode.diff', left, fileUri, `${name} (before edit ↔ now)`, { preview: true });
}
