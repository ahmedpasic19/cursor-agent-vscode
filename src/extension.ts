import * as vscode from 'vscode';
import { CliService } from './backend/CliService';
import type { Mode } from './shared/events';
import type { WebviewMessage } from './shared/protocol';
import { SessionManager } from './session/SessionManager';
import { WebviewBridge } from './webview/WebviewBridge';

let manager: SessionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Cursor Agent');
  context.subscriptions.push(output);
  const log = (line: string) => output.appendLine(`${new Date().toISOString().slice(11, 23)} ${line}`);

  const cfg = () => vscode.workspace.getConfiguration('cursorAgent');

  const cli = new CliService(
    () => cfg().get<string>('cliPath', ''),
    log,
    {
      get: (v) => context.globalState.get<string[]>(`caps:${v}`),
      set: (v, flags) => void context.globalState.update(`caps:${v}`, flags),
    },
    (status) => bridge.post({ type: 'cli/status', cli: status }),
  );

  const bridge = new WebviewBridge(context.extensionUri, (msg) => handle(msg), log);

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
    post: (m) => bridge.post(m),
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
      case 'file/open':
        void openFile(msg.path, msg.line);
        break;
      case 'log/show':
        output.show(true);
        break;
    }
  }

  context.subscriptions.push(
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

async function openFile(path: string, line?: number): Promise<void> {
  const root = getCwd();
  const uri = /^([a-zA-Z]:[\\/]|\/)/.test(path) || !root ? vscode.Uri.file(path) : vscode.Uri.joinPath(vscode.Uri.file(root), path);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
  } catch {
    void vscode.window.showWarningMessage(`Could not open ${path}`);
  }
}
