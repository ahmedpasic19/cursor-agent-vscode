/**
 * Add / edit an MCP server: a small form in an editor panel that writes mcp.json.
 * Keys the form doesn't manage (e.g. `envFile`, `disabled`) are kept when editing.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { globalMcpPath, listServers, type McpServerConfig, type McpServerEntry, projectMcpPath, removeServer, upsertServer } from './mcpConfig';

export interface FormValues {
  name: string;
  /** "global" or a workspace folder path. */
  scope: string;
  transport: 'stdio' | 'remote';
  command: string;
  /** One argument per line. */
  args: string;
  /** KEY=VALUE per line. */
  env: string;
  url: string;
  /** Name: Value per line. */
  headers: string;
  enable: boolean;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function parsePairs(text: string, sep: '=' | ':'): { map: Record<string, string>; bad?: string } {
  const map: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(sep);
    if (i <= 0) return { map, bad: line };
    map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { map };
}

/** Form values → server config (merged over `base` so unmanaged keys survive). Returns an error text on bad input. */
export function toConfig(v: FormValues, base: McpServerConfig = {}): McpServerConfig | string {
  if (!NAME_RE.test(v.name.trim())) return 'Name: letters, digits, "-", "_" or ".", starting with a letter or digit.';
  const { command: _c, args: _a, env: _e, url: _u, headers: _h, ...rest } = base;
  if (v.transport === 'stdio') {
    if (!v.command.trim()) return 'Command is required for a local server.';
    const env = parsePairs(v.env, '=');
    if (env.bad) return `Environment line needs KEY=VALUE: "${env.bad}"`;
    const args = v.args.split(/\r?\n/).map((a) => a.trim()).filter(Boolean);
    const out: McpServerConfig = { ...rest, command: v.command.trim() };
    if (args.length) out.args = args;
    if (Object.keys(env.map).length) out.env = env.map;
    if (out.type === 'http' || out.type === 'sse') delete out.type;
    return out;
  }
  const url = v.url.trim();
  if (!/^https?:\/\/\S+$/.test(url)) return 'URL must start with http:// or https://';
  const headers = parsePairs(v.headers, ':');
  if (headers.bad) return `Header line needs "Name: Value": "${headers.bad}"`;
  const out: McpServerConfig = { ...rest, url };
  if (Object.keys(headers.map).length) out.headers = headers.map;
  if (out.type === 'stdio') delete out.type;
  return out;
}

export function fromEntry(e: McpServerEntry | undefined): FormValues {
  const c = e?.config ?? {};
  return {
    name: e?.name ?? '',
    scope: e?.scope === 'project' && e.folder ? e.folder : 'global',
    transport: c.url ? 'remote' : 'stdio',
    command: c.command ?? '',
    args: (c.args ?? []).join('\n'),
    env: Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    url: c.url ?? '',
    headers: Object.entries(c.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
    enable: !e,
  };
}

export class McpServerForm implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private editing?: McpServerEntry;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly folders: () => string[],
    private readonly onSaved: (saved: { name: string; folder?: string; enable: boolean }) => void,
  ) {}

  open(entry?: McpServerEntry): void {
    this.editing = entry;
    const title = entry ? `MCP: ${entry.name}` : 'Add MCP server';
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('cursorAgent.mcpForm', title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    }
    this.panel.title = title;
    this.panel.webview.html = this.html(fromEntry(entry));
    this.panel.reveal();
  }

  private onMessage(m: { type: string; values?: FormValues }): void {
    if (m.type === 'cancel') return this.panel?.dispose();
    if (m.type === 'openDocs') return void vscode.env.openExternal(vscode.Uri.parse('https://docs.cursor.com/context/model-context-protocol'));
    if (m.type !== 'save' || !m.values) return;
    const v = m.values;
    const old = this.editing;
    const cfg = toConfig(v, old?.config);
    if (typeof cfg === 'string') return void this.panel?.webview.postMessage({ type: 'error', text: cfg });
    const name = v.name.trim();
    const folder = v.scope === 'global' ? undefined : v.scope;
    const file = folder ? projectMcpPath(folder) : globalMcpPath();
    const sameFile = old && old.file.toLowerCase() === file.toLowerCase();
    // Duplicate name in the target file (other than the entry being edited)?
    const clash = listServers(this.folders()).servers.find((s) => s.file.toLowerCase() === file.toLowerCase() && s.name === name);
    if (clash && !(sameFile && old?.name === name)) {
      return void this.panel?.webview.postMessage({ type: 'error', text: `A server named "${name}" already exists in that config.` });
    }
    try {
      upsertServer(file, name, cfg, sameFile ? old?.name : undefined);
      if (old && !sameFile) removeServer(old.file, old.name);
    } catch (e) {
      return void this.panel?.webview.postMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }
    this.panel?.dispose();
    void vscode.window.showInformationMessage(`${old ? 'Saved' : 'Added'} MCP server "${name}" in ${folder ? vscode.workspace.asRelativePath(file) : '~/.cursor/mcp.json'}.`);
    this.onSaved({ name, folder, enable: v.enable });
  }

  private html(v: FormValues): string {
    const nonce = randomBytes(16).toString('base64');
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const scopes = [
      { value: 'global', label: 'Global — ~/.cursor/mcp.json (all projects)' },
      ...this.folders().map((f) => ({ value: f, label: `Project — ${f.split(/[\\/]/).pop()}/.cursor/mcp.json` })),
    ];
    const opt = (o: { value: string; label: string }) => `<option value="${esc(o.value)}"${o.value === v.scope ? ' selected' : ''}>${esc(o.label)}</option>`;
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px 24px; max-width: 640px; }
  h1 { font-size: 1.35em; font-weight: 600; margin: 0 0 4px; }
  p.sub { color: var(--vscode-descriptionForeground); margin: 0 0 20px; }
  label { display: block; font-weight: 600; margin: 14px 0 4px; }
  .hint { color: var(--vscode-descriptionForeground); font-weight: normal; font-size: 0.92em; margin-top: 3px; }
  input[type=text], select, textarea { width: 100%; box-sizing: border-box; padding: 5px 7px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); border-radius: 3px; font: inherit; }
  textarea { font-family: var(--vscode-editor-font-family); min-height: 64px; resize: vertical; }
  input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .seg { display: inline-flex; border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, #8884)); border-radius: 4px; overflow: hidden; }
  .seg button { background: transparent; color: var(--vscode-foreground); border: 0; padding: 5px 12px; cursor: pointer; font: inherit; }
  .seg button[aria-pressed=true] { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 16px; }
  .actions { display: flex; gap: 8px; margin-top: 24px; }
  .btn { padding: 6px 14px; border: 0; border-radius: 3px; cursor: pointer; font: inherit; }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .error { color: var(--vscode-errorForeground); margin-top: 14px; min-height: 1.2em; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  [hidden] { display: none !important; }
  code { font-family: var(--vscode-editor-font-family); }
</style></head><body>
<h1>${this.editing ? 'Edit MCP server' : 'Add MCP server'}</h1>
<p class="sub">Saved to mcp.json, the same file the Cursor CLI and editor read. <a id="docs">MCP docs</a></p>

<label for="name">Name</label>
<input type="text" id="name" value="${esc(v.name)}" placeholder="e.g. github" autocomplete="off">

<label for="scope">Where</label>
<select id="scope">${scopes.map(opt).join('')}</select>

<label>Type</label>
<div class="seg" role="group">
  <button type="button" data-t="stdio" aria-pressed="${v.transport === 'stdio'}">Local command</button>
  <button type="button" data-t="remote" aria-pressed="${v.transport === 'remote'}">Remote URL</button>
</div>

<div id="stdio"${v.transport === 'stdio' ? '' : ' hidden'}>
  <label for="command">Command</label>
  <input type="text" id="command" value="${esc(v.command)}" placeholder="npx">
  <label for="args">Arguments <span class="hint">— one per line</span></label>
  <textarea id="args" placeholder="-y&#10;@modelcontextprotocol/server-github">${esc(v.args)}</textarea>
  <label for="env">Environment <span class="hint">— KEY=VALUE per line</span></label>
  <textarea id="env" placeholder="GITHUB_TOKEN=\${env:GITHUB_TOKEN}">${esc(v.env)}</textarea>
  <div class="hint">Keep secrets out of the file with <code>\${env:NAME}</code>; it reads the variable at startup.</div>
</div>

<div id="remote"${v.transport === 'remote' ? '' : ' hidden'}>
  <label for="url">URL</label>
  <input type="text" id="url" value="${esc(v.url)}" placeholder="https://mcp.example.com/mcp">
  <label for="headers">Headers <span class="hint">— Name: Value per line</span></label>
  <textarea id="headers" placeholder="Authorization: Bearer \${env:EXAMPLE_TOKEN}">${esc(v.headers)}</textarea>
  <div class="hint">Servers that use OAuth need no headers: save, then use <b>Log in</b> on the server in the MCP view.</div>
</div>

<div class="row"><input type="checkbox" id="enable"${v.enable ? ' checked' : ''}><label for="enable" style="margin:0;font-weight:normal">Enable and approve it now (<code>agent mcp enable</code>)</label></div>

<div class="error" id="err" role="alert"></div>
<div class="actions"><button class="btn primary" id="save">${this.editing ? 'Save' : 'Add server'}</button><button class="btn secondary" id="cancel">Cancel</button></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let transport = ${JSON.stringify(v.transport)};
  const $ = (id) => document.getElementById(id);
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    transport = b.dataset.t;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('stdio').hidden = transport !== 'stdio';
    $('remote').hidden = transport !== 'remote';
  }));
  const values = () => ({ name: $('name').value, scope: $('scope').value, transport, command: $('command').value, args: $('args').value, env: $('env').value, url: $('url').value, headers: $('headers').value, enable: $('enable').checked });
  $('save').addEventListener('click', () => { $('err').textContent = ''; vscode.postMessage({ type: 'save', values: values() }); });
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('docs').addEventListener('click', () => vscode.postMessage({ type: 'openDocs' }));
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('save').click(); });
  window.addEventListener('message', (e) => { if (e.data.type === 'error') $('err').textContent = e.data.text; });
  $('name').focus();
</script></body></html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
