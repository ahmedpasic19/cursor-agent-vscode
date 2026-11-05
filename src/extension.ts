import * as vscode from 'vscode';
import { CliService } from './backend/CliService';
import { BeforeContentProvider } from './checkpoints/BeforeContentProvider';
import { CodeActions } from './codeActions';
import { ChangesController } from './checkpoints/ChangesController';
import { workspaceHash } from './checkpoints/CheckpointService';
import { DiffProvider } from './checkpoints/DiffProvider';
import { registerAddToChat } from './context/commands';
import { fileChip } from './context/ContextCollector';
import { FileIndex } from './context/FileIndex';
import type { Mode } from './shared/events';
import type { HostMessage, WebviewMessage } from './shared/protocol';
import { SessionManager } from './session/SessionManager';
import { StatusBar } from './statusBar';
import { HistoryStore } from './storage/HistoryStore';
import { PINNED_SDK_VERSION, SdkService } from './sdk/SdkService';
import { WebviewBridge } from './webview/WebviewBridge';

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
  const store = new HistoryStore(vscode.Uri.joinPath(context.globalStorageUri, workspaceHash(workspaceKey)).fsPath, {
    limit: () => cfg().get<number>('historyLimit', 200),
    log,
  });
  history = store;

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
    },
  );

  const bridge = new WebviewBridge(context.extensionUri, (msg) => handle(msg), log);

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
      }
    },
  });
  const useSdk = () => cfg().get<string>('backend', 'cli') === 'sdk';
  const activeStatus = () => (useSdk() ? sdk.status : cli.status);
  const refreshBackend = () => (useSdk() ? sdk.refresh() : cli.refresh());

  const setSdkKey = async () => {
    const key = await vscode.window.showInputBox({
      title: 'Cursor SDK API key',
      prompt: 'Create one in the Cursor dashboard (Integrations → API keys). Stored in VS Code Secret Storage. The SDK backend is billed by usage.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length < 10 ? 'That does not look like an API key.' : undefined),
    });
    if (!key) return;
    await context.secrets.store(SDK_KEY, key.trim());
    void sdk.refresh();
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
    }),
    getMaxConcurrent: () => cfg().get<number>('maxConcurrentRuns', 3),
    getDefaultMode: () => cfg().get<Mode>('defaultMode', 'agent'),
    getDefaultModel: () => cfg().get<string>('defaultModel', '') || undefined,
    getCwd,
    post,
    getCheckpoints: (root) => changes.sourceFor(root),
    onTabChanged: (tab, urgent) => store.schedule(tab, urgent),
    onTabsChanged: () => saveOpenState(),
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
    store.prune(new Set(mgr.tabs.map((t) => t.id)));
  }

  const sendHistory = () => {
    const open = new Set(mgr.tabs.map((t) => t.id));
    bridge.post({ type: 'history/list', items: store.list(open) });
  };

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
        break;
      case 'tab/new':
        mgr.newTab(true);
        break;
      case 'tab/close':
        mgr.closeTab(msg.tabId);
        break;
      case 'tab/activate':
        mgr.activate(msg.tabId);
        break;
      case 'tab/rename':
        mgr.renameTab(msg.tabId, msg.title);
        break;
      case 'run/resume':
        mgr.resume(msg.tabId);
        break;
      case 'history/request':
        sendHistory();
        break;
      case 'history/open': {
        if (mgr.getTab(msg.id)) {
          mgr.activate(msg.id, true);
          break;
        }
        const data = store.load(msg.id);
        if (!data) {
          bridge.post({ type: 'notice', level: 'error', text: 'That chat could not be loaded.' });
          break;
        }
        mgr.restoreTab(data, true);
        mgr.activate(msg.id, true);
        break;
      }
      case 'history/delete':
        void (async () => {
          const ok =
            (await vscode.window.showWarningMessage('Delete this chat from history?', { modal: true, detail: 'This cannot be undone.' }, 'Delete')) ===
            'Delete';
          if (!ok) return;
          if (mgr.getTab(msg.id)) mgr.closeTab(msg.id);
          store.delete(msg.id);
          sendHistory();
        })();
        break;
      case 'message/send':
        mgr.send(msg.tabId, msg.text, msg.mode, msg.model, msg.chipIds);
        break;
      case 'chip/remove':
        mgr.getTab(msg.tabId)?.removeChip(msg.chipId);
        break;
      case 'mention/search': {
        const root = mgr.getTab(msg.tabId)?.cwd ?? getCwd();
        if (!root) {
          bridge.post({ type: 'mention/results', requestId: msg.requestId, items: [] });
          break;
        }
        void fileIndex.search(root, msg.query).then((items) =>
          bridge.post({ type: 'mention/results', requestId: msg.requestId, items }),
        );
        break;
      }
      case 'mention/pick': {
        const tab = mgr.getTab(msg.tabId);
        const root = tab?.cwd ?? getCwd();
        if (!tab || !root) break;
        void fileChip(vscode.Uri.joinPath(vscode.Uri.file(root), msg.path)).then((chip) => {
          if (chip) tab.addChip(chip, maxChipLines());
        });
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
    vscode.window.registerWebviewViewProvider(WebviewBridge.viewId, bridge, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('cursorAgent.newChat', async () => {
      await bridge.reveal();
      mgr.newTab(true);
      bridge.post({ type: 'composer/focus' });
    }),
    vscode.commands.registerCommand('cursorAgent.showHistory', async () => {
      await bridge.reveal();
      bridge.post({ type: 'history/show' });
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
      await context.secrets.delete(SDK_KEY);
      void sdk.refresh();
      void vscode.window.showInformationMessage('Cursor SDK API key removed.');
    }),
    vscode.commands.registerCommand('cursorAgent.installSdk', installSdk),
    fileIndex,
    code,
    { dispose: () => mgr.stopAll() },
  );

  registerAddToChat(context, {
    manager: mgr,
    reveal: () => bridge.reveal(),
    focusComposer: () => bridge.post({ type: 'composer/focus' }),
    notice: (level, text) => bridge.post({ type: 'notice', level, text }),
    maxChipLines,
    log,
  });

  log('Cursor Agent activated');
  const ready = useSdk() ? Promise.all([cli.refresh(), sdk.refresh()]) : cli.refresh();
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
