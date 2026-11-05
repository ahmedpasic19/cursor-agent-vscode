/**
 * Finds the cursor-agent CLI. Order: configured path → %LOCALAPPDATA%\cursor-agent\versions → PATH.
 * On Windows we prefer the real `node.exe index.js` pair over the `.cmd` shim, which goes
 * through PowerShell (docs/CLI_NOTES.md §1).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, extname, join } from 'node:path';

export interface CliInfo {
  command: string;
  /** Args placed before ours, e.g. the index.js path when command is node.exe. */
  prefixArgs: string[];
  /** Needs a shell (a .cmd/.bat shim on Windows). */
  shell: boolean;
  env?: Record<string, string>;
  source: 'setting' | 'versions' | 'path';
  /** Human-readable description for logs and the UI. */
  display: string;
}

const VERSION_DIR = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/;

function versionKey(name: string): number[] {
  const m = VERSION_DIR.exec(name);
  if (!m) return [];
  return m.slice(1, 7).map((x) => Number(x ?? 0));
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Newest `versions/<v>/node.exe + index.js` under an install dir, if any. */
export function fromInstallDir(installDir: string): CliInfo | undefined {
  const versions = join(installDir, 'versions');
  if (!isDir(versions)) return undefined;
  const dirs = readdirSync(versions, { withFileTypes: true })
    .filter((d) => d.isDirectory() && VERSION_DIR.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => compareKeys(versionKey(b), versionKey(a)));
  for (const d of dirs) {
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    const node = join(versions, d, nodeName);
    const index = join(versions, d, 'index.js');
    if (existsSync(node) && existsSync(index)) {
      return {
        command: node,
        prefixArgs: [index],
        shell: false,
        env: { CURSOR_INVOKED_AS: 'cursor-agent' },
        source: 'versions',
        display: `${node} ${index}`,
      };
    }
  }
  return undefined;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Interpret an explicit path (from the `cursorAgent.cliPath` setting). */
export function fromExplicitPath(p: string): CliInfo | undefined {
  if (isDir(p)) return fromInstallDir(p);
  if (!isFile(p)) return undefined;
  const ext = extname(p).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    // Run a JS entry (e.g. the fake CLI in tests) with the host's own Node/Electron.
    return {
      command: process.execPath,
      prefixArgs: [p],
      shell: false,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      source: 'setting',
      display: `${process.execPath} ${p}`,
    };
  }
  if (/^node(\.exe)?$/i.test(basename(p))) {
    const index = join(dirname(p), 'index.js');
    if (existsSync(index)) {
      return { command: p, prefixArgs: [index], shell: false, source: 'setting', display: `${p} ${index}` };
    }
  }
  if (ext === '.cmd' || ext === '.bat') {
    // Prefer the real binary next to an installer shim.
    const real = fromInstallDir(dirname(p));
    if (real) return { ...real, source: 'setting' };
    return { command: p, prefixArgs: [], shell: true, source: 'setting', display: p };
  }
  return { command: p, prefixArgs: [], shell: false, source: 'setting', display: p };
}

export function locateCli(configuredPath: string | undefined, env: NodeJS.ProcessEnv = process.env): CliInfo | undefined {
  if (configuredPath?.trim()) return fromExplicitPath(configuredPath.trim());

  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const found = fromInstallDir(join(env.LOCALAPPDATA, 'cursor-agent'));
    if (found) return found;
  }

  const names =
    process.platform === 'win32'
      ? ['cursor-agent.cmd', 'cursor-agent.exe', 'agent.cmd', 'agent.exe']
      : ['cursor-agent', 'agent'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = join(dir, n);
      if (isFile(p)) {
        const info = fromExplicitPath(p);
        if (info) return { ...info, source: info.source === 'setting' ? 'path' : info.source };
      }
    }
  }
  // Common non-Windows install location.
  if (process.platform !== 'win32' && env.HOME) {
    const p = join(env.HOME, '.local', 'bin', 'cursor-agent');
    if (isFile(p)) return { command: p, prefixArgs: [], shell: false, source: 'path', display: p };
  }
  return undefined;
}

/** Quote one argument for cmd.exe (only used for .cmd shims with shell: true). */
export function quoteCmdArg(arg: string): string {
  if (arg && !/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
