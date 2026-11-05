import * as vscode from 'vscode';
import { CliService } from './backend/CliService';
import { BeforeContentProvider } from './checkpoints/BeforeContentProvider';
import { ChangesController } from './checkpoints/ChangesController';
import { DiffProvider } from './checkpoints/DiffProvider';
import { registerAddToChat } from './context/commands';
import { fileChip } from './context/ContextCollector';
import { FileIndex } from './context/FileIndex';
import type { Mode } from './shared/events';
import type { HostMessage, WebviewMessage } from './shared/protocol';
import { SessionManager } from './session/SessionManager';
import { StatusBar } from './statusBar';
import { WebviewBridge } from './webview/WebviewBridge';

let manager: SessionManager | undefined;

/** Returned from activate(); used by integration tests. */
export interface CursorAgentApi {
  manager: SessionManager;
  changes: ChangesController;
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

  const cli = new CliService(
    () => cfg().get<string>('cliPath', ''),
    log,
    {
      get: (v) => context.globalState.get<string[]>(`caps:${v}`),
      set: (v, flags) => void context.globalState.update(`caps:${v}`, flags),
    },
    (status) => {
      statusBar.setCli(status);
      bridge.post({ type: 'cli/status', cli: status });
    },
  );

  const bridge = new WebviewBridge(context.extensionUri, (msg) => handle(msg), log);

  const post = (m: HostMessage) => {
    bridge.post(m);
    if (m.type === 'tab/updated') statusBar.setRunning(mgr.runningTabs);
  };

  const mgr: SessionManager = new SessionManager({
    getBackend: () => cli.backend(),
    getRunSettings: () => ({
      partialOutput: cfg().get<boolean>('streamPartialOutput', true),
      extraArgs: cfg().get<string[]>('extraArgs', []),
      postResultGraceMs: cfg().get<number>('postResultGraceMs', 3000),
      timeoutMs: cfg().get<number>('runTimeoutMinutes', 30) * 60_000,
    }),
    getMaxConcurrent: () => cfg().get<number>('maxConcurrentRuns', 3),
    getDefaultMode: () => cfg().get<Mode>('defaultMode', 'agent'),
    getDefaultModel: () => cfg().get<string>('defaultModel', '') || undefined,
    getCwd,
    post,
    getCheckpoints: (root) => changes.sourceFor(root),
  });
  manager = mgr;

  const changes: ChangesController = new ChangesController(context.globalStorageUri, mgr, cfg, log, (tab, run) => {
    if (run.changes) post({ type: 'changes/updated', tabId: tab.id, runId: run.id, changes: run.changes });
  });
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
      cli: cli.status,
      settings: { defaultMode: cfg().get<Mode>('defaultMode', 'agent') },
    });
    bridge.flushPending();
    void sendModels();
  };

  const sendModels = async (force = false) => {
    const fromCli = await cli.models(force);
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
        mgr.replaceWithNewTab();
        sendFullState();
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
        void cli.refresh();
        break;
      case 'settings/open':
        void vscode.commands.executeCommand('workbench.action.openSettings', msg.query ?? 'cursorAgent');
        break;
      case 'log/show':
        output.show(true);
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
      mgr.replaceWithNewTab();
      await bridge.reveal();
      sendFullState();
      bridge.post({ type: 'composer/focus' });
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
    }),
    fileIndex,
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
  const ready = cli.refresh();
  return { manager: mgr, changes, cliReady: () => ready };
}

export function deactivate(): void {
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
