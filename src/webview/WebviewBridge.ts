import * as vscode from 'vscode';
import { type HostMessage, type WebviewMessage, WebviewMessageSchema } from '../shared/protocol';

/** Webview bundles in dist/webview: `index` (chat) and `sessions` (Session Manager). */
export type WebviewEntry = 'index' | 'sessions';

/** View ids. The chat lives in the secondary sidebar, or in the activity-bar container on VS Code < 1.106. */
export const VIEW_IDS = {
  chat: 'cursorAgent.chat',
  chatFallback: 'cursorAgent.chatSidebar',
  sessions: 'cursorAgent.sessions',
} as const;

/** WebviewView host: strict CSP, typed messaging, buffering until the view is ready. */
export class WebviewBridge implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private ready = false;
  private pending: HostMessage[] = [];

  constructor(
    /** Ids this provider is registered for; reveal() focuses the first one that resolved, else the first. */
    readonly viewIds: readonly string[],
    private readonly entry: WebviewEntry,
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (msg: WebviewMessage) => void,
    private readonly log: (line: string) => void,
  ) {}

  private resolvedId?: string;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.resolvedId = view.viewType;
    this.ready = false;
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = this.html(view.webview, root);
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const parsed = WebviewMessageSchema.safeParse(raw);
      if (!parsed.success) {
        this.log(`[webview] invalid message: ${JSON.stringify(raw).slice(0, 300)}`);
        return;
      }
      if (parsed.data.type === 'ready') {
        this.ready = true;
        this.pending = []; // the ready handler sends a full state snapshot
      }
      this.onMessage(parsed.data);
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  post(msg: HostMessage): void {
    if (!this.view || !this.ready) {
      // Incremental messages are superseded by the state/full sent on `ready`.
      if (msg.type === 'composer/focus' || msg.type === 'notice' || msg.type === 'sessions/focusSearch') this.pending.push(msg);
      return;
    }
    void this.view.webview.postMessage(msg);
  }

  /** Send messages queued while the view was loading (after state/full). */
  flushPending(): void {
    const p = this.pending;
    this.pending = [];
    for (const m of p) this.post(m);
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${this.resolvedId ?? this.viewIds[0]}.focus`);
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const nonce = makeNonce();
    const js = webview.asWebviewUri(vscode.Uri.joinPath(root, `${this.entry}.js`));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(root, `${this.entry}.css`));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Cursor Agent</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
