/**
 * MCP and plugin data, without vscode imports (unit-tested):
 * - mcp.json read/write: `~/.cursor/mcp.json` (global) and `<folder>/.cursor/mcp.json` (project);
 *   unknown keys are kept on write.
 * - parsing of `agent mcp list` / `agent mcp list-tools <id>` text output.
 * - scanning installed plugins under `~/.cursor/plugins`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type McpScope = 'global' | 'project';

/** One entry of `mcpServers`. Either a local command (stdio) or a remote URL. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  [key: string]: unknown;
}

export interface McpServerEntry {
  name: string;
  scope: McpScope;
  /** The mcp.json that defines it. */
  file: string;
  /** Workspace folder (project scope only). */
  folder?: string;
  config: McpServerConfig;
}

export function globalMcpPath(home = homedir()): string {
  return join(home, '.cursor', 'mcp.json');
}

export function projectMcpPath(folder: string): string {
  return join(folder, '.cursor', 'mcp.json');
}

/** JSON with // and /* comments and trailing commas tolerated (strings are left alone). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (inStr) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1').replace(/^﻿/, ''));
}

export interface McpFile {
  /** Whole file, so writes keep keys other than mcpServers. */
  root: Record<string, unknown>;
  servers: Record<string, McpServerConfig>;
  error?: string;
}

export function readMcpFile(file: string): McpFile {
  if (!existsSync(file)) return { root: {}, servers: {} };
  try {
    const root = parseJsonc(readFileSync(file, 'utf8'));
    if (!root || typeof root !== 'object' || Array.isArray(root)) return { root: {}, servers: {}, error: 'Not a JSON object' };
    const r = root as Record<string, unknown>;
    const servers = r.mcpServers && typeof r.mcpServers === 'object' ? (r.mcpServers as Record<string, McpServerConfig>) : {};
    return { root: r, servers };
  } catch (e) {
    return { root: {}, servers: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

/** All configured servers: global first, then each folder's project file. */
export function listServers(folders: string[], home = homedir()): { servers: McpServerEntry[]; errors: { file: string; error: string }[] } {
  const servers: McpServerEntry[] = [];
  const errors: { file: string; error: string }[] = [];
  const add = (file: string, scope: McpScope, folder?: string) => {
    const f = readMcpFile(file);
    if (f.error) errors.push({ file, error: f.error });
    for (const [name, config] of Object.entries(f.servers)) servers.push({ name, scope, file, folder, config: config ?? {} });
  };
  add(globalMcpPath(home), 'global');
  for (const folder of folders) add(projectMcpPath(folder), 'project', folder);
  return { servers, errors };
}

/** Insert or replace one server (renaming when `oldName` differs), keeping everything else. */
export function upsertServer(file: string, name: string, config: McpServerConfig, oldName?: string): void {
  const f = readMcpFile(file);
  if (f.error) throw new Error(`${file} is not valid JSON (${f.error}); fix it first.`);
  const servers: Record<string, McpServerConfig> = {};
  let placed = false;
  // Keep the original order; a renamed server stays where it was.
  for (const [k, v] of Object.entries(f.servers)) {
    if (k === (oldName ?? name)) {
      servers[name] = config;
      placed = true;
    } else if (k !== name) servers[k] = v;
  }
  if (!placed) servers[name] = config;
  writeJson(file, { ...f.root, mcpServers: servers });
}

export function removeServer(file: string, name: string): boolean {
  const f = readMcpFile(file);
  if (f.error) throw new Error(`${file} is not valid JSON (${f.error}); fix it first.`);
  if (!(name in f.servers)) return false;
  const servers = { ...f.servers };
  delete servers[name];
  writeJson(file, { ...f.root, mcpServers: servers });
  return true;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** 1-based line of `"name":` inside the file, for "Open config". */
export function lineOfServer(file: string, name: string): number | undefined {
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    const needle = JSON.stringify(name) + ':';
    const i = lines.findIndex((l) => l.replace(/\s+/g, '').startsWith(needle.replace(/\s+/g, '')));
    return i >= 0 ? i + 1 : undefined;
  } catch {
    return undefined;
  }
}

// ---------- CLI output ----------

export type McpState = 'ready' | 'disabled' | 'needsAuth' | 'needsApproval' | 'error' | 'loading' | 'unknown';

export interface McpStatus {
  state: McpState;
  /** Raw status text from the CLI, e.g. "ready" or "error: spawn npx ENOENT". */
  text: string;
}

export function classifyStatus(text: string): McpState {
  const t = text.toLowerCase();
  if (/^ready\b|connected/.test(t)) return 'ready';
  if (/disabled/.test(t)) return 'disabled';
  if (/auth|login|sign in|unauthori[sz]ed|401/.test(t)) return 'needsAuth';
  if (/approv/.test(t)) return 'needsApproval';
  if (/loading|starting|connecting|pending/.test(t)) return 'loading';
  if (/error|fail|not found|enoent|exit|timed? ?out|crash/.test(t)) return 'error';
  return 'unknown';
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** `name: status` lines. Lines without a colon (headers, blank) are skipped. */
export function parseMcpList(stdout: string): Map<string, McpStatus> {
  const out = new Map<string, McpStatus>();
  for (const raw of stdout.replace(ANSI, '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^([^\s:][^:]*?):\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, name, text] = m;
    if (/^(usage|error|warning|note)$/i.test(name!)) continue;
    out.set(name!, { state: classifyStatus(text!), text: text! });
  }
  return out;
}

export interface McpTool {
  name: string;
  /** Argument names, as printed in parentheses. */
  args: string[];
}

/** `Tools for X (n):` then `- tool (a, b)` lines. */
export function parseMcpTools(stdout: string): McpTool[] {
  const tools: McpTool[] = [];
  for (const raw of stdout.replace(ANSI, '').split(/\r?\n/)) {
    const m = /^\s*[-*•]\s+([^\s(]+)\s*(?:\(([^)]*)\))?/.exec(raw);
    if (!m) continue;
    const args = (m[2] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    tools.push({ name: m[1]!, args });
  }
  return tools;
}

// ---------- plugins ----------

export interface Marketplace {
  name: string;
  displayName?: string;
  description?: string;
  gitUrl?: string;
  scope?: string;
}

export function parseMarketplaces(stdout: string): Marketplace[] {
  try {
    const v = JSON.parse(stdout.slice(stdout.indexOf('[')));
    return Array.isArray(v) ? v.filter((m) => m && typeof m.name === 'string') : [];
  } catch {
    return [];
  }
}

export interface InstalledPlugin {
  name: string;
  version?: string;
  description?: string;
  /** Marketplace it came from, or "local". */
  source: string;
  dir: string;
}

const MANIFESTS = ['.cursor-plugin/plugin.json', '.plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json'];

function readManifest(dir: string): { name?: string; version?: string; description?: string } | undefined {
  for (const m of MANIFESTS) {
    const f = join(dir, m);
    if (!existsSync(f)) continue;
    try {
      return parseJsonc(readFileSync(f, 'utf8')) as { name?: string; version?: string; description?: string };
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}

const subdirs = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.') && statSync(join(dir, n)).isDirectory());
  } catch {
    return [];
  }
};

/**
 * Plugins on disk: `~/.cursor/plugins/cache/<marketplace>/<plugin>/<revision>/` and
 * `~/.cursor/plugins/local/<plugin>/`. For cached plugins the newest revision folder wins.
 */
export function scanPlugins(home = homedir()): InstalledPlugin[] {
  const base = join(home, '.cursor', 'plugins');
  const out: InstalledPlugin[] = [];
  for (const market of subdirs(join(base, 'cache'))) {
    for (const plugin of subdirs(join(base, 'cache', market))) {
      const pdir = join(base, 'cache', market, plugin);
      const revs = subdirs(pdir)
        .map((r) => ({ r, t: statSync(join(pdir, r)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      const dir = revs.length && !readManifest(pdir) ? join(pdir, revs[0]!.r) : pdir;
      const m = readManifest(dir);
      out.push({ name: m?.name ?? plugin, version: m?.version, description: m?.description, source: market, dir });
    }
  }
  for (const plugin of subdirs(join(base, 'local'))) {
    const dir = join(base, 'local', plugin);
    const m = readManifest(dir);
    out.push({ name: m?.name ?? plugin, version: m?.version, description: m?.description, source: 'local', dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Manifest name of a `--plugin-dir` folder (falls back to the folder name). */
export function pluginDirInfo(dir: string): { name: string; version?: string; description?: string; exists: boolean } {
  const exists = existsSync(dir);
  const m = exists ? readManifest(dir) : undefined;
  return { name: m?.name ?? (dir.split(/[\\/]/).filter(Boolean).pop() ?? dir), version: m?.version, description: m?.description, exists };
}
