/**
 * Discovers Cursor skills (SKILL.md) and custom slash commands (*.md in commands/) from workspace,
 * $HOME, plugin caches, and optional extra dirs. Merge order: Project > User > plugin > Cursor built-in.
 */
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentCommand } from '../shared/protocol';
import { mergeAgentCommandsByFirstWin } from './skillMerge';
import { parseCommandFrontMatter, parseSkillFrontMatter, readFileBodyAfterFrontMatter } from './skillFrontMatter';

const MAX_ENTRIES = 300;
const HOME_SCAN_TTL_MS = 60_000;

export interface ResolvedSlashCommand {
  kind: 'skill' | 'command';
  name: string;
  file: string;
  /** Pre-read body for commands; skills use file path only in prompt line. */
  body?: string;
}

export interface SkillIndexScanOptions {
  enabled: boolean;
  extraDirs: string[];
  /** Workspace folder paths. */
  workspaceRoots: string[];
  homeDir: string;
  pluginDirs: string[];
}

interface HomeScanParts {
  homeUser: AgentCommand[];
  homePlugins: AgentCommand[];
  cursorBuiltins: AgentCommand[];
}

interface WorkspaceScanParts {
  projectUser: AgentCommand[];
  projectPlugins: AgentCommand[];
}

function emptyHomeParts(): HomeScanParts {
  return { homeUser: [], homePlugins: [], cursorBuiltins: [] };
}

export class SkillIndex implements vscode.Disposable {
  private mergedCache: AgentCommand[] | undefined;
  private mergedKey = '';
  private homeBundle: { at: number; cmds: HomeScanParts } = { at: 0, cmds: emptyHomeParts() };
  private readonly workspaceWatcher: vscode.FileSystemWatcher;

  constructor(
    private readonly log: (l: string) => void,
    private readonly onInvalidate?: () => void,
  ) {
    this.workspaceWatcher = vscode.workspace.createFileSystemWatcher(
      '**/{.cursor,.claude}/{skills,commands,plugins}/**',
      false,
      false,
      false,
    );
    const invalidate = () => {
      this.mergedCache = undefined;
      this.mergedKey = '';
      this.onInvalidate?.();
    };
    this.workspaceWatcher.onDidCreate(invalidate);
    this.workspaceWatcher.onDidChange(invalidate);
    this.workspaceWatcher.onDidDelete(invalidate);
  }

  dispose(): void {
    this.workspaceWatcher.dispose();
  }

  invalidate(): void {
    this.mergedCache = undefined;
    this.mergedKey = '';
    this.homeBundle = { at: 0, cmds: emptyHomeParts() };
    this.onInvalidate?.();
  }

  async list(opts: SkillIndexScanOptions): Promise<AgentCommand[]> {
    if (!opts.enabled) return [];
    const key = cacheKey(opts);
    const now = Date.now();
    const homeStale = now - this.homeBundle.at > HOME_SCAN_TTL_MS;
    if (this.mergedCache && this.mergedKey === key && !homeStale) return this.mergedCache;

    const t0 = Date.now();
    if (homeStale) {
      this.homeBundle.cmds = await scanHomeSide(opts.homeDir, opts.extraDirs, this.log);
      this.homeBundle.at = now;
    }

    const project = await scanWorkspaceSide(opts.workspaceRoots, opts.extraDirs, this.log);
    const fromPluginDirs: AgentCommand[] = [];
    for (const p of opts.pluginDirs) {
      const abs = path.resolve(p);
      try {
        if ((await stat(abs)).isDirectory()) await scanPluginTree(abs, fromPluginDirs, path.basename(abs));
      } catch {
        /* skip */
      }
    }

    const h = this.homeBundle.cmds;
    const merged = mergeAgentCommandsByFirstWin([
      ...project.projectUser,
      ...project.projectPlugins,
      ...fromPluginDirs,
      ...h.homeUser,
      ...h.homePlugins,
      ...h.cursorBuiltins,
    ]);
    const capped = merged.slice(0, MAX_ENTRIES);
    this.mergedCache = capped;
    this.mergedKey = key;
    this.log(`[skills] scanned ${capped.length} in ${Date.now() - t0}ms`);
    return capped;
  }

  async resolveLeadingSlash(text: string, opts: SkillIndexScanOptions): Promise<{ displayText: string; resolved?: ResolvedSlashCommand }> {
    const trimmed = text.trimStart();
    const m = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (!m) return { displayText: text };
    const name = m[1]!;
    const list = await this.list(opts);
    const cmd = list.find((c) => c.name === name);
    if (!cmd) return { displayText: text };

    if (cmd.kind === 'skill') {
      return {
        displayText: text,
        resolved: { kind: 'skill', name: cmd.name, file: cmd.file },
      };
    }

    const body = (await readFileBodyAfterFrontMatter(cmd.file)) ?? '';
    return {
      displayText: text,
      resolved: { kind: 'command', name: cmd.name, file: cmd.file, body },
    };
  }
}

function cacheKey(opts: SkillIndexScanOptions): string {
  return JSON.stringify({
    e: opts.enabled,
    x: opts.extraDirs,
    w: opts.workspaceRoots,
    p: opts.pluginDirs,
  });
}

async function scanWorkspaceSide(roots: string[], extraDirs: string[], log: (l: string) => void): Promise<WorkspaceScanParts> {
  const projectUser: AgentCommand[] = [];
  const projectPlugins: AgentCommand[] = [];
  for (const root of roots) {
    const base = path.resolve(root);
    await scanUserLikeSkillTrees(base, projectUser, 'Project');
    await scanCursorPlugins(path.join(base, '.cursor', 'plugins'), projectPlugins, true);
    await scanClaudePluginsDir(path.join(base, '.claude', 'plugins'), projectPlugins);
  }
  for (const ed of extraDirs) {
    const abs = path.isAbsolute(ed) ? ed : roots[0] ? path.join(roots[0], ed) : ed;
    try {
      if ((await stat(abs)).isDirectory()) await scanSkillDir(abs, projectUser, 'Extra');
    } catch {
      log(`[skills] extraDir not found: ${ed}`);
    }
  }
  return { projectUser, projectPlugins };
}

/** HOME side: user layout, plugins, skills-cursor — kept in separate arrays for merge order vs workspace/pluginDirs. */
async function scanHomeSide(homeDir: string, extraDirs: string[], log: (l: string) => void): Promise<HomeScanParts> {
  const homeUser: AgentCommand[] = [];
  const homePlugins: AgentCommand[] = [];
  const home = path.resolve(homeDir);
  await scanUserLikeSkillTrees(home, homeUser, 'User');
  await scanCursorPlugins(path.join(home, '.cursor', 'plugins'), homePlugins, false);
  await scanClaudePluginsDir(path.join(home, '.claude', 'plugins'), homePlugins);
  for (const ed of extraDirs) {
    const abs = path.isAbsolute(ed) ? ed : path.join(home, ed);
    try {
      if ((await stat(abs)).isDirectory()) await scanSkillDir(abs, homeUser, 'Extra');
    } catch {
      log(`[skills] extraDir not found: ${ed}`);
    }
  }
  const cursorBuiltins: AgentCommand[] = [];
  await scanSkillDir(path.join(home, '.cursor', 'skills-cursor'), cursorBuiltins, 'Cursor');
  return { homeUser, homePlugins, cursorBuiltins };
}

/** Standard per-user skill locations (not skills-cursor); same layout under workspace or HOME. */
async function scanUserLikeSkillTrees(base: string, out: AgentCommand[], source: string): Promise<void> {
  await scanSkillDir(path.join(base, '.cursor', 'skills'), out, source);
  await scanSkillDir(path.join(base, '.claude', 'skills'), out, source);
  await scanSkillDir(path.join(base, '.codex', 'skills'), out, source);
  await scanSkillDir(path.join(base, '.grok', 'skills'), out, source);
  await scanSkillDir(path.join(base, '.agents', 'skills'), out, source);
  await scanCommandsDir(path.join(base, '.cursor', 'commands'), out, source);
  await scanCommandsDir(path.join(base, '.claude', 'commands'), out, source === 'Project' ? 'Project' : 'User');
}

async function scanCursorPlugins(pluginsRoot: string, out: AgentCommand[], isWorkspace: boolean): Promise<void> {
  const cache = path.join(pluginsRoot, 'cache');
  try {
    const markets = (await readdir(cache, { withFileTypes: true })) as Dirent[];
    for (const m of markets) {
      if (!m.isDirectory()) continue;
      const mpath = path.join(cache, m.name);
      const plugins = (await readdir(mpath, { withFileTypes: true })) as Dirent[];
      for (const p of plugins) {
        if (!p.isDirectory()) continue;
        const pluginName = p.name;
        const pbase = path.join(mpath, pluginName);
        const refs = (await readdir(pbase, { withFileTypes: true })) as Dirent[];
        for (const r of refs) {
          if (!r.isDirectory()) continue;
          const skillsDir = path.join(pbase, r.name, 'skills');
          await scanPluginSkillsFolder(skillsDir, out, pluginName, isWorkspace ? 'Project' : pluginName);
          if (out.length >= MAX_ENTRIES) return;
        }
      }
    }
  } catch {
    /* no cache */
  }
  const local = path.join(pluginsRoot, 'local');
  try {
    const locals = (await readdir(local, { withFileTypes: true })) as Dirent[];
    for (const d of locals) {
      if (!d.isDirectory()) continue;
      const skillsDir = path.join(local, d.name, 'skills');
      await scanPluginSkillsFolder(skillsDir, out, d.name, isWorkspace ? 'Project' : d.name);
      if (out.length >= MAX_ENTRIES) return;
    }
  } catch {
    /* no local */
  }
}

async function scanClaudePluginsDir(pluginsRoot: string, out: AgentCommand[]): Promise<void> {
  let top: Dirent[];
  try {
    top = (await readdir(pluginsRoot, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const e of top) {
    if (!e.isDirectory()) continue;
    await scanPluginTree(path.join(pluginsRoot, e.name), out, e.name);
    if (out.length >= MAX_ENTRIES) return;
  }
}

async function scanSkillDir(dir: string, out: AgentCommand[], source: string): Promise<void> {
  if (out.length >= MAX_ENTRIES) return;
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_ENTRIES) break;
    if (!e.isDirectory()) continue;
    const skillFile = path.join(dir, e.name, 'SKILL.md');
    try {
      if (!(await stat(skillFile)).isFile()) continue;
    } catch {
      continue;
    }
    const fm = await parseSkillFrontMatter(skillFile);
    if (fm === undefined) continue;
    const name = fm.name?.trim() || e.name;
    if (!/^[\w:-]+$/.test(name)) continue;
    out.push({
      kind: 'skill',
      name,
      file: skillFile,
      source,
      description: fm.description,
      ...(fm.userOnly ? { userOnly: true } : {}),
    });
  }
}

async function scanCommandsDir(dir: string, out: AgentCommand[], source: string): Promise<void> {
  if (out.length >= MAX_ENTRIES) return;
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_ENTRIES) break;
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const file = path.join(dir, e.name);
    const fm = await parseCommandFrontMatter(file);
    if (fm === undefined) continue;
    const name = e.name.replace(/\.md$/i, '');
    if (!/^[\w:-]+$/.test(name)) continue;
    out.push({
      kind: 'command',
      name,
      file,
      source,
      ...(fm.description ? { description: fm.description } : {}),
    });
  }
}

async function scanPluginSkillsFolder(skillsDir: string, out: AgentCommand[], pluginSlug: string, source: string): Promise<void> {
  if (out.length >= MAX_ENTRIES) return;
  let entries: Dirent[];
  try {
    entries = (await readdir(skillsDir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_ENTRIES) break;
    if (!e.isDirectory()) continue;
    const skillFile = path.join(skillsDir, e.name, 'SKILL.md');
    try {
      if (!(await stat(skillFile)).isFile()) continue;
    } catch {
      continue;
    }
    const fm = await parseSkillFrontMatter(skillFile);
    if (fm === undefined) continue;
    const skillName = fm.name?.trim() || e.name;
    const name = `${pluginSlug}:${skillName}`.replace(/\s+/g, '-');
    if (!/^[\w:-]+$/.test(name)) continue;
    out.push({
      kind: 'skill',
      name,
      file: skillFile,
      source,
      description: fm.description,
      ...(fm.userOnly ? { userOnly: true } : {}),
    });
  }
}

async function scanPluginTree(pluginRoot: string, out: AgentCommand[], label: string): Promise<void> {
  if (out.length >= MAX_ENTRIES) return;
  let entries: Dirent[];
  try {
    entries = (await readdir(pluginRoot, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  const hasSkills = entries.some((e) => e.isDirectory() && e.name === 'skills');
  if (hasSkills) {
    await scanPluginSkillsFolder(path.join(pluginRoot, 'skills'), out, label, label);
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    await scanPluginTree(path.join(pluginRoot, e.name), out, label);
    if (out.length >= MAX_ENTRIES) return;
  }
}
