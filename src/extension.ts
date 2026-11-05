import * as vscode from 'vscode';
import { CliService } from './backend/CliService';
import { BeforeContentProvider } from './checkpoints/BeforeContentProvider';
import type { Mode } from './shared/events';
import type { HostMessage, WebviewMessage } from './shared/protocol';
import { SessionManager } from './session/SessionManager';
import { StatusBar } from './statusBar';
import { WebviewBridge } from './webview/WebviewBridge';

let manager: SessionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Cursor Agent');
  context.subscriptions.push(output);
  const log = (line: string) => output.appendLine(`${new Date().toISOString().slice(11, 23)} ${line}`);

  const cfg = () => vscode.workspace.getConfiguration('cursorAgent');
  const statusBar = new StatusBar();
  const before = new BeforeContentProvider();

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

  const mgr = new SessionManager({
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
  });
  manager = mgr;

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
        mgr.send(msg.tabId, msg.text, msg.mode, msg.model);
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
    { dispose: () => mgr.stopAll() },
  );

  log('Cursor Agent activated');
  void cli.refresh();
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
