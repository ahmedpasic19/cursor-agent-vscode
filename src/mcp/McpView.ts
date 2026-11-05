/**
 * "MCP & Plugins" tree view in the Cursor sidebar: configured MCP servers with live status
 * (`agent mcp list`), their tools (`agent mcp list-tools`), enable / disable / log in, add / edit /
 * remove (writes mcp.json), plugin marketplaces, installed plugins and local plugin folders.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import type { CliService } from '../backend/CliService';
import {
  globalMcpPath,
  type InstalledPlugin,
  lineOfServer,
  listServers,
  type Marketplace,
  type McpServerEntry,
  type McpStatus,
  type McpTool,
  parseMarketplaces,
  parseMcpList,
  parseMcpTools,
  pluginDirInfo,
  projectMcpPath,
  removeServer,
  scanPlugins,
} from './mcpConfig';
import { McpServerForm } from './McpServerForm';

type Node =
  | { kind: 'section'; id: 'servers' | 'plugins' | 'options' }
  | { kind: 'server'; entry: McpServerEntry; status?: McpStatus }
  | { kind: 'tool'; server: string; tool: McpTool }
  | { kind: 'message'; text: string; icon?: string; tooltip?: string; command?: vscode.Command }
  | { kind: 'group'; id: 'marketplaces' | 'installed' | 'pluginDirs' }
  | { kind: 'marketplace'; m: Marketplace }
  | { kind: 'plugin'; p: InstalledPlugin }
  | { kind: 'pluginDir'; dir: string }
  | { kind: 'option'; id: 'approveMcps' };

const STATE_ICON: Record<string, [string, string?]> = {
  ready: ['pass-filled', 'testing.iconPassed'],
  disabled: ['circle-slash', 'disabledForeground'],
  needsAuth: ['key', 'editorWarning.foreground'],
  needsApproval: ['shield', 'editorWarning.foreground'],
  error: ['error', 'errorForeground'],
  loading: ['loading~spin'],
  unknown: ['circle-outline'],
};

export class McpView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private statuses = new Map<string, McpStatus>();
  private statusError: string | undefined;
  private loading = false;
  private tools = new Map<string, McpTool[] | string>();
  private marketplaces: Marketplace[] | string | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private view?: vscode.TreeView<Node>;
  private readonly form: McpServerForm;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cli: CliService,
    private readonly log: (l: string) => void,
  ) {
    this.form = new McpServerForm(context, () => this.folders(), async ({ name, folder, enable }) => {
      if (enable) {
        const r = await this.cli.exec(['mcp', 'enable', name], folder ?? this.cwdFor());
        if (!r.ok) void vscode.window.showWarningMessage(`Saved, but enabling ${name} failed: ${r.message}`);
      }
      await this.refresh();
    });
    const watch = (pattern: vscode.GlobPattern) => {
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      const on = () => this.scheduleRefresh();
      w.onDidChange(on);
      w.onDidCreate(on);
      w.onDidDelete(on);
      this.disposables.push(w);
    };
    watch(new vscode.RelativePattern(vscode.Uri.file(dirname(globalMcpPath())), 'mcp.json'));
    watch('**/.cursor/mcp.json');
    this.disposables.push(
      this.changed,
      this.form,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('cursorAgent.pluginDirs') || e.affectsConfiguration('cursorAgent.approveMcps')) this.changed.fire(undefined);
      }),
    );
  }

  register(): void {
    this.view = vscode.window.createTreeView('cursorAgent.mcp', { treeDataProvider: this, showCollapseAll: true });
    this.view.onDidChangeVisibility((e) => {
      if (e.visible && !this.statuses.size && !this.loading) void this.refresh();
    });
    const cmd = (id: string, fn: (...a: any[]) => unknown) => this.disposables.push(vscode.commands.registerCommand(id, fn));
    cmd('cursorAgent.mcp.refresh', () => this.refresh());
    cmd('cursorAgent.mcp.add', () => this.form.open());
    cmd('cursorAgent.mcp.edit', (n: Node) => n?.kind === 'server' && this.form.open(n.entry));
    cmd('cursorAgent.mcp.remove', (n: Node) => n?.kind === 'server' && this.remove(n.entry));
    cmd('cursorAgent.mcp.enable', (n: Node) => n?.kind === 'server' && this.toggle(n.entry, true));
    cmd('cursorAgent.mcp.disable', (n: Node) => n?.kind === 'server' && this.toggle(n.entry, false));
    cmd('cursorAgent.mcp.login', (n: Node) => n?.kind === 'server' && this.login(n.entry));
    cmd('cursorAgent.mcp.openConfig', (n?: Node) => this.openConfig(n?.kind === 'server' ? n.entry : undefined));
    cmd('cursorAgent.mcp.openGlobalConfig', () => this.openFile(globalMcpPath()));
    cmd('cursorAgent.mcp.toggleApprove', async () => {
      const c = vscode.workspace.getConfiguration('cursorAgent');
      await c.update('approveMcps', !c.get<boolean>('approveMcps', false), vscode.ConfigurationTarget.Global);
    });
    cmd('cursorAgent.plugins.addMarketplace', () => this.addMarketplace());
    cmd('cursorAgent.plugins.removeMarketplace', (n: Node) => n?.kind === 'marketplace' && this.marketplaceCmd('remove', n.m));
    cmd('cursorAgent.plugins.updateMarketplace', (n: Node) => n?.kind === 'marketplace' && this.marketplaceCmd('update', n.m));
    cmd('cursorAgent.plugins.addDir', () => this.addPluginDir());
    cmd('cursorAgent.plugins.removeDir', (n: Node) => n?.kind === 'pluginDir' && this.removePluginDir(n.dir));
    cmd('cursorAgent.plugins.reveal', (n: Node) => {
      const dir = n?.kind === 'plugin' ? n.p.dir : n?.kind === 'pluginDir' ? n.dir : undefined;
      if (dir) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
    });
    this.disposables.push(this.view);
  }

  private folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  }

  /** Folder `mcp` commands run in: project servers resolve relative to the cwd. */
  private cwdFor(entry?: McpServerEntry): string {
    return entry?.folder ?? this.folders()[0] ?? tmpdir();
  }

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 400);
  }

  /** Re-reads configs and asks the CLI for status (per folder with a project config, plus one global run). */
  async refresh(): Promise<void> {
    this.loading = true;
    this.tools.clear();
    this.marketplaces = undefined;
    this.changed.fire(undefined);
    const folders = this.folders();
    const runIn = [folders[0], ...folders.slice(1).filter((f) => existsSync(projectMcpPath(f)))].filter((f): f is string => !!f);
    if (!runIn.length) runIn.push(tmpdir());
    const next = new Map<string, McpStatus>();
    let error: string | undefined;
    await Promise.all(
      runIn.map(async (cwd) => {
        const r = await this.cli.exec(['mcp', 'list'], cwd, 90_000);
        if (!r.ok) error = r.message;
        for (const [name, st] of parseMcpList(r.stdout)) next.set(`${cwd}|${name}`, st);
      }),
    );
    // Global servers show the same status in every folder; index by bare name too.
    for (const [k, v] of [...next]) {
      const name = k.slice(k.indexOf('|') + 1);
      if (!next.has(`*|${name}`)) next.set(`*|${name}`, v);
    }
    this.statuses = next;
    this.statusError = error;
    this.loading = false;
    this.changed.fire(undefined);
  }

  private statusOf(e: McpServerEntry): McpStatus | undefined {
    return (e.folder ? this.statuses.get(`${e.folder}|${e.name}`) : undefined) ?? this.statuses.get(`*|${e.name}`);
  }

  // ---------- actions ----------

  private async toggle(entry: McpServerEntry, enable: boolean): Promise<void> {
    const r = await vscode.window.withProgress({ location: { viewId: 'cursorAgent.mcp' } }, () =>
      this.cli.exec(['mcp', enable ? 'enable' : 'disable', entry.name], this.cwdFor(entry)),
    );
    if (!r.ok) void vscode.window.showErrorMessage(`Could not ${enable ? 'enable' : 'disable'} ${entry.name}: ${r.message}`);
    await this.refresh();
  }

  private login(entry: McpServerEntry): void {
    const args = ['mcp', 'login', entry.name];
    const launch = this.cli.terminalLaunch(args);
    const t = launch
      ? vscode.window.createTerminal({ name: `MCP login: ${entry.name}`, cwd: this.cwdFor(entry), ...launch })
      : vscode.window.createTerminal({ name: `MCP login: ${entry.name}`, cwd: this.cwdFor(entry) });
    if (!launch) t.sendText(`cursor-agent mcp login ${JSON.stringify(entry.name)}`);
    t.show();
    const sub = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== t) return;
      sub.dispose();
      void this.refresh();
    });
    this.disposables.push(sub);
  }

  private async remove(entry: McpServerEntry): Promise<void> {
    const where = entry.scope === 'global' ? '~/.cursor/mcp.json' : vscode.workspace.asRelativePath(entry.file);
    const ok = await vscode.window.showWarningMessage(`Remove MCP server "${entry.name}" from ${where}?`, { modal: true }, 'Remove');
    if (ok !== 'Remove') return;
    try {
      removeServer(entry.file, entry.name);
      this.log(`[mcp] removed ${entry.name} from ${entry.file}`);
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
    await this.refresh();
  }

  private async openConfig(entry?: McpServerEntry): Promise<void> {
    if (!entry) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Global', description: '~/.cursor/mcp.json', file: globalMcpPath() },
          ...this.folders().map((f) => ({ label: `Project: ${f.split(/[\\/]/).pop()}`, description: '.cursor/mcp.json', file: projectMcpPath(f) })),
        ],
        { title: 'Open MCP config' },
      );
      if (pick) await this.openFile(pick.file);
      return;
    }
    await this.openFile(entry.file, lineOfServer(entry.file, entry.name));
  }

  private async openFile(file: string, line?: number): Promise<void> {
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{\n  "mcpServers": {}\n}\n', 'utf8');
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
  }

  private async loadMarketplaces(): Promise<void> {
    const r = await this.cli.exec(['plugin', 'marketplace', 'list', '--format', 'json'], this.cwdFor());
    this.marketplaces = r.ok ? parseMarketplaces(r.stdout) : (r.message ?? 'Could not list marketplaces');
    this.changed.fire(undefined);
  }

  private async addMarketplace(): Promise<void> {
    const url = await vscode.window.showInputBox({
      title: 'Add plugin marketplace',
      prompt: 'Git repository URL of the marketplace',
      placeHolder: 'https://github.com/org/cursor-plugins.git',
      validateInput: (v) => (/^(https?:\/\/|git@|ssh:\/\/)\S+$/.test(v.trim()) ? undefined : 'Enter a git URL (https://… or git@…)'),
    });
    if (!url) return;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Adding marketplace…' }, () =>
      this.cli.exec(['plugin', 'marketplace', 'add', url.trim()], this.cwdFor(), 180_000),
    );
    if (!r.ok) void vscode.window.showErrorMessage(`Could not add marketplace: ${r.message}`);
    await this.loadMarketplaces();
  }

  private async marketplaceCmd(op: 'remove' | 'update', m: Marketplace): Promise<void> {
    if (op === 'remove') {
      const ok = await vscode.window.showWarningMessage(`Remove plugin marketplace "${m.displayName ?? m.name}"?`, { modal: true }, 'Remove');
      if (ok !== 'Remove') return;
    }
    const r = await vscode.window.withProgress({ location: { viewId: 'cursorAgent.mcp' } }, () =>
      this.cli.exec(['plugin', 'marketplace', op, m.name], this.cwdFor(), 180_000),
    );
    if (!r.ok) void vscode.window.showErrorMessage(`Could not ${op} ${m.name}: ${r.message}`);
    else if (op === 'update') void vscode.window.showInformationMessage(`Re-indexed ${m.displayName ?? m.name}.`);
    await this.loadMarketplaces();
  }

  private async addPluginDir(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, title: 'Local plugin folder(s)' });
    if (!picked?.length) return;
    const c = vscode.workspace.getConfiguration('cursorAgent');
    const cur = c.get<string[]>('pluginDirs', []);
    const next = [...cur, ...picked.map((u) => u.fsPath).filter((p) => !cur.includes(p))];
    await c.update('pluginDirs', next, vscode.ConfigurationTarget.Global);
  }

  private async removePluginDir(dir: string): Promise<void> {
    const c = vscode.workspace.getConfiguration('cursorAgent');
    await c.update('pluginDirs', c.get<string[]>('pluginDirs', []).filter((d) => d !== dir), vscode.ConfigurationTarget.Global);
  }

  // ---------- tree ----------

  getChildren(n?: Node): Node[] | Promise<Node[]> {
    if (!n) return [{ kind: 'section', id: 'servers' }, { kind: 'section', id: 'plugins' }, { kind: 'section', id: 'options' }];
    switch (n.kind) {
      case 'section':
        if (n.id === 'servers') return this.serverNodes();
        if (n.id === 'plugins') return [{ kind: 'group', id: 'installed' }, { kind: 'group', id: 'marketplaces' }, { kind: 'group', id: 'pluginDirs' }];
        return [{ kind: 'option', id: 'approveMcps' }];
      case 'server':
        return this.toolNodes(n.entry);
      case 'group':
        return this.groupNodes(n.id);
      default:
        return [];
    }
  }

  private serverNodes(): Node[] {
    const { servers, errors } = listServers(this.folders());
    const out: Node[] = servers.map((entry) => ({ kind: 'server', entry, status: this.statusOf(entry) }));
    for (const e of errors) {
      out.push({ kind: 'message', text: `Invalid JSON: ${vscode.workspace.asRelativePath(e.file)}`, icon: 'error', tooltip: e.error, command: { title: 'Open', command: 'vscode.open', arguments: [vscode.Uri.file(e.file)] } });
    }
    if (this.statusError && !this.loading) out.push({ kind: 'message', text: 'Status unavailable', icon: 'warning', tooltip: this.statusError });
    // Names the CLI reports that aren't in any mcp.json (e.g. from plugins).
    const known = new Set(servers.map((s) => s.name));
    for (const [k, st] of this.statuses) {
      const name = k.slice(k.indexOf('|') + 1);
      if (!k.startsWith('*|') || known.has(name)) continue;
      out.push({ kind: 'message', text: `${name}`, icon: STATE_ICON[st.state]?.[0], tooltip: `${name}: ${st.text}\nProvided by a plugin or another config (not in mcp.json).` });
    }
    out.push({ kind: 'message', text: 'Add MCP server…', icon: 'add', command: { title: 'Add', command: 'cursorAgent.mcp.add' } });
    return out;
  }

  private async toolNodes(entry: McpServerEntry): Promise<Node[]> {
    const st = this.statusOf(entry);
    if (st && st.state !== 'ready') return [{ kind: 'message', text: st.state === 'disabled' ? 'Disabled' : st.text, icon: 'info' }];
    let tools = this.tools.get(entry.name);
    if (!tools) {
      const r = await this.cli.exec(['mcp', 'list-tools', entry.name], this.cwdFor(entry), 90_000);
      tools = r.ok ? parseMcpTools(r.stdout) : (r.message ?? 'Could not list tools');
      this.tools.set(entry.name, tools);
    }
    if (typeof tools === 'string') return [{ kind: 'message', text: tools, icon: 'warning' }];
    if (!tools.length) return [{ kind: 'message', text: 'No tools', icon: 'info' }];
    return tools.map((tool) => ({ kind: 'tool', server: entry.name, tool }));
  }

  private async groupNodes(id: 'marketplaces' | 'installed' | 'pluginDirs'): Promise<Node[]> {
    if (id === 'installed') {
      const ps = scanPlugins();
      return ps.length ? ps.map((p) => ({ kind: 'plugin', p })) : [{ kind: 'message', text: 'No plugins installed', icon: 'info' }];
    }
    if (id === 'pluginDirs') {
      const dirs = vscode.workspace.getConfiguration('cursorAgent').get<string[]>('pluginDirs', []);
      return [
        ...dirs.map((dir): Node => ({ kind: 'pluginDir', dir })),
        { kind: 'message', text: 'Add plugin folder…', icon: 'add', command: { title: 'Add', command: 'cursorAgent.plugins.addDir' } },
      ];
    }
    if (this.marketplaces === undefined) await this.loadMarketplaces();
    const ms = this.marketplaces;
    const add: Node = { kind: 'message', text: 'Add marketplace…', icon: 'add', command: { title: 'Add', command: 'cursorAgent.plugins.addMarketplace' } };
    if (typeof ms === 'string') return [{ kind: 'message', text: ms, icon: 'warning' }, add];
    return [...(ms ?? []).map((m): Node => ({ kind: 'marketplace', m })), add];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (n.kind) {
      case 'section': {
        const label = { servers: 'MCP Servers', plugins: 'Plugins', options: 'Run options' }[n.id];
        const it = new vscode.TreeItem(label, C.Expanded);
        it.contextValue = `section.${n.id}`;
        if (n.id === 'servers') {
          const states = [...this.statuses].filter(([k]) => k.startsWith('*|')).map(([, s]) => s.state);
          it.description = this.loading ? 'checking…' : states.length ? `${states.filter((s) => s === 'ready').length}/${states.length} ready` : '';
        }
        return it;
      }
      case 'server': {
        const { entry } = n;
        const st = this.loading ? { state: 'loading' as const, text: 'checking…' } : n.status;
        const it = new vscode.TreeItem(entry.name, C.Collapsed);
        const kind = entry.config.url ? 'remote' : 'local';
        it.description = `${st?.text ?? 'not loaded'} · ${entry.scope === 'global' ? 'global' : `project${this.folders().length > 1 && entry.folder ? ` (${entry.folder.split(/[\\/]/).pop()})` : ''}`}`;
        const [icon, color] = STATE_ICON[st?.state ?? 'unknown'] ?? STATE_ICON.unknown!;
        it.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
        const target = entry.config.url ?? [entry.config.command, ...(entry.config.args ?? [])].filter(Boolean).join(' ');
        it.tooltip = new vscode.MarkdownString(
          `**${entry.name}** (${kind})\n\n\`${target || '(no command)'}\`\n\nStatus: ${st?.text ?? 'unknown'}\n\nDefined in \`${entry.file}\``,
        );
        const disabled = st?.state === 'disabled';
        it.contextValue = `mcpServer${disabled ? '.disabled' : '.enabled'}${st?.state === 'needsAuth' || entry.config.url ? '.auth' : ''}`;
        return it;
      }
      case 'tool': {
        const it = new vscode.TreeItem(n.tool.name, C.None);
        it.description = n.tool.args.join(', ');
        it.iconPath = new vscode.ThemeIcon('tools');
        it.tooltip = `${n.server} › ${n.tool.name}(${n.tool.args.join(', ')})`;
        return it;
      }
      case 'message': {
        const it = new vscode.TreeItem(n.text, C.None);
        if (n.icon) it.iconPath = new vscode.ThemeIcon(n.icon);
        it.tooltip = n.tooltip;
        it.command = n.command;
        return it;
      }
      case 'group': {
        const label = { marketplaces: 'Marketplaces', installed: 'Installed', pluginDirs: 'Local plugin folders' }[n.id];
        const it = new vscode.TreeItem(label, n.id === 'installed' ? C.Expanded : C.Collapsed);
        it.contextValue = `group.${n.id}`;
        if (n.id === 'pluginDirs') it.tooltip = 'Passed to every run with --plugin-dir (cursorAgent.pluginDirs).';
        if (n.id === 'installed') it.tooltip = 'Plugins on disk under ~/.cursor/plugins (from marketplaces or local).';
        return it;
      }
      case 'marketplace': {
        const it = new vscode.TreeItem(n.m.displayName ?? n.m.name, C.None);
        it.description = [n.m.scope, n.m.gitUrl].filter(Boolean).join(' · ');
        it.tooltip = n.m.description;
        it.iconPath = new vscode.ThemeIcon('package');
        it.contextValue = 'marketplace';
        return it;
      }
      case 'plugin': {
        const it = new vscode.TreeItem(n.p.name, C.None);
        it.description = [n.p.version, n.p.source].filter(Boolean).join(' · ');
        it.tooltip = `${n.p.description ?? ''}\n\n${n.p.dir}`.trim();
        it.iconPath = new vscode.ThemeIcon('extensions');
        it.contextValue = 'plugin';
        return it;
      }
      case 'pluginDir': {
        const info = pluginDirInfo(n.dir);
        const it = new vscode.TreeItem(info.name, C.None);
        it.description = info.exists ? (info.version ?? '') : 'folder missing';
        it.tooltip = `${n.dir}\n${info.description ?? ''}`.trim();
        it.iconPath = new vscode.ThemeIcon(info.exists ? 'folder' : 'warning');
        it.contextValue = 'pluginDir';
        return it;
      }
      case 'option': {
        const on = vscode.workspace.getConfiguration('cursorAgent').get<boolean>('approveMcps', false);
        const it = new vscode.TreeItem('Auto-approve MCP servers', C.None);
        it.description = on ? 'on' : 'off';
        it.iconPath = new vscode.ThemeIcon(on ? 'pass-filled' : 'circle-large-outline');
        it.tooltip = 'Pass --approve-mcps to every run, so servers load without an approval prompt (headless runs cannot answer one).';
        it.command = { title: 'Toggle', command: 'cursorAgent.mcp.toggleApprove' };
        return it;
      }
    }
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
  }
}
