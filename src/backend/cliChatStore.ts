/**
 * Rewrites the mode a CLI chat is stored in, so a resumed Ask/Plan chat starts in Agent mode
 * (docs/ASK_TO_AGENT_SWITCH.md). The CLI keeps the mode in
 * `~/.cursor/chats/<hash>/<sessionId>/store.db`, table `meta`, key '0': hex-encoded JSON.
 *
 * Uses `node:sqlite`. The extension host's Node may not have it, so if loading it fails we run
 * the same code in a short child process with the CLI's own Node.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Mode } from '../shared/events';
import type { CliInfo } from './cliLocator';

/** UI mode → the `mode` value the CLI stores. */
export const STORED_MODE: Record<Mode, string> = { agent: 'default', ask: 'search', plan: 'plan' };

export type SetModeResult = 'ok' | 'unchanged' | 'notFound' | 'error';

export function defaultChatsDir(): string {
  return join(homedir(), '.cursor', 'chats');
}

/** `<chatsDir>/*\/<sessionId>/store.db`, one directory level deep. */
export function findStoreDb(sessionId: string, chatsDir = defaultChatsDir()): string | undefined {
  if (!sessionId || /[\\/]|\.\./.test(sessionId)) return undefined;
  let dirs: string[];
  try {
    dirs = readdirSync(chatsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const p = join(chatsDir, d, sessionId, 'store.db');
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Sets `mode` in meta key '0' and nothing else. Self-contained (it is also serialized into the
 * child-process script), so it must not reference anything outside its own body.
 */
type DatabaseSyncCtor = new (path: string) => {
  prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown };
  close(): void;
};

function rewriteMeta(
  DatabaseSync: DatabaseSyncCtor,
  dbPath: string,
  mode: string,
): 'ok' | 'unchanged' {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value: unknown } | undefined;
    if (!row || typeof row.value !== 'string' || !/^[0-9a-fA-F]+$/.test(row.value)) {
      throw new Error('meta key 0 is missing or not hex text');
    }
    const meta = JSON.parse(Buffer.from(row.value, 'hex').toString('utf8'));
    if (!meta || typeof meta !== 'object' || typeof meta.mode !== 'string') {
      throw new Error('meta has no string "mode" field');
    }
    if (meta.mode === mode) return 'unchanged';
    meta.mode = mode;
    const hex = Buffer.from(JSON.stringify(meta), 'utf8').toString('hex');
    db.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(hex);
    return 'ok';
  } finally {
    db.close();
  }
}

/** `node:sqlite` in this process, if the host's Node has it. */
function loadSqlite(): DatabaseSyncCtor | undefined {
  try {
    const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const mod = getBuiltin?.('node:sqlite') as { DatabaseSync?: DatabaseSyncCtor } | undefined;
    return mod?.DatabaseSync;
  } catch {
    return undefined;
  }
}

/** A Node binary that can run a script: the CLI's own node.exe, or our host as Node. */
function nodeFor(cli: CliInfo | undefined): { command: string; env: NodeJS.ProcessEnv } {
  if (cli && !cli.shell && /^node(\.exe)?$/i.test(basename(cli.command))) {
    return { command: cli.command, env: process.env };
  }
  return { command: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
}

function runInChild(cli: CliInfo | undefined, dbPath: string, mode: string): Promise<'ok' | 'unchanged'> {
  const script =
    `const { DatabaseSync } = require('node:sqlite');` +
    `const r = (${rewriteMeta.toString()})(DatabaseSync, process.argv[1], process.argv[2]);` +
    `process.stdout.write(r);`;
  const node = nodeFor(cli);
  return new Promise((resolve, reject) => {
    execFile(
      node.command,
      ['--no-warnings', '-e', script, dbPath, mode],
      { env: node.env, windowsHide: true, timeout: 10000 },
      (err, stdout, stderr) => {
        const out = String(stdout).trim();
        if (err) reject(new Error(String(stderr).trim() || err.message));
        else if (out === 'ok' || out === 'unchanged') resolve(out);
        else reject(new Error(`unexpected output: ${out.slice(0, 200)}`));
      },
    );
  });
}

export interface SetModeOptions {
  chatsDir?: string;
  /** Used to find a Node with `node:sqlite` when the host has none. */
  cli?: CliInfo;
  log?: (line: string) => void;
}

/** Sets the stored mode of a CLI chat. Never throws; call only while no run uses the session. */
export async function setChatMode(sessionId: string, mode: Mode, opts: SetModeOptions = {}): Promise<SetModeResult> {
  const log = opts.log ?? (() => {});
  const dbPath = findStoreDb(sessionId, opts.chatsDir);
  if (!dbPath) {
    log(`[chatStore] no store.db for session ${sessionId}`);
    return 'notFound';
  }
  const stored = STORED_MODE[mode];
  try {
    const DatabaseSync = loadSqlite();
    const r = DatabaseSync ? rewriteMeta(DatabaseSync, dbPath, stored) : await runInChild(opts.cli, dbPath, stored);
    log(`[chatStore] ${sessionId} mode → ${stored} (${r}${DatabaseSync ? '' : ', child process'})`);
    return r;
  } catch (e) {
    log(`[chatStore] could not set mode for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    return 'error';
  }
}
