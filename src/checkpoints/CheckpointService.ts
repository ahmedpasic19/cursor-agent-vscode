/**
 * Shadow-git checkpoints (PLAN.md §5.6). A separate git dir in extension storage tracks the
 * workspace as its work tree, so it works in non-git folders and never touches the user's .git.
 *
 * Byte exactness: info/attributes forces `-text` and unsets filters, and core.autocrlf=false,
 * so blobs are the exact file bytes (CRLF preserved) and restores write them back verbatim.
 *
 * No vscode imports: unit-tested against real git in temp folders.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type ChangeStatus = 'A' | 'M' | 'D';

export interface FileChange {
  /** Workspace-relative, forward slashes. */
  path: string;
  status: ChangeStatus;
  added: number;
  removed: number;
  binary: boolean;
}

export interface CheckpointOptions {
  /** Workspace root (the work tree). */
  root: string;
  /** Shadow git dir, e.g. globalStorage/<hash>/shadow.git */
  gitDir: string;
  /** Extra exclude patterns (gitignore syntax). */
  exclude?: string[];
  /** Files larger than this are not checkpointed. */
  maxFileBytes?: number;
  /** Timeout for a snapshot (add + commit). */
  snapshotTimeoutMs?: number;
  log?: (line: string) => void;
}

export const DEFAULT_EXCLUDES = ['node_modules/', '.git/', 'dist/', 'build/', 'out/', '.next/', '.turbo/', 'coverage/', '*.vsix'];

export class GitMissingError extends Error {}

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Stable short id for a workspace root (used for the storage folder name). */
export function workspaceHash(root: string): string {
  return createHash('sha1').update(resolve(root).toLowerCase()).digest('hex').slice(0, 16);
}

let gitAvailable: Promise<boolean> | undefined;
export function isGitAvailable(): Promise<boolean> {
  gitAvailable ??= new Promise((res) =>
    execFile('git', ['--version'], { windowsHide: true, timeout: 10_000 }, (err) => res(!err)),
  );
  return gitAvailable;
}

export class CheckpointService {
  private readonly root: string;
  private readonly gitDir: string;
  private readonly maxFileBytes: number;
  private readonly snapshotTimeoutMs: number;
  private readonly log: (line: string) => void;
  private initialized?: Promise<void>;
  /** All git operations run one at a time (shared index). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: CheckpointOptions) {
    this.root = resolve(opts.root);
    this.gitDir = resolve(opts.gitDir);
    this.maxFileBytes = opts.maxFileBytes ?? 5 * 1024 * 1024;
    this.snapshotTimeoutMs = opts.snapshotTimeoutMs ?? 10_000;
    this.log = opts.log ?? (() => {});
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private git(args: string[], opts: { timeoutMs?: number; input?: Buffer } = {}): Promise<GitResult> {
    // Drop inherited GIT_* variables (e.g. GIT_DIR / GIT_INDEX_FILE from a hook) so they can't redirect us.
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
    env.GIT_TERMINAL_PROMPT = '0';
    const hooks = join(this.gitDir, 'no-hooks');
    const full = [
      `--git-dir=${this.gitDir}`,
      `--work-tree=${this.root}`,
      '-c', 'core.autocrlf=false',
      '-c', 'core.safecrlf=false',
      '-c', 'core.longpaths=true',
      '-c', 'core.quotepath=off',
      '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${hooks}`,
      '-c', 'commit.gpgsign=false',
      '-c', 'gc.auto=0',
      '-c', 'user.name=Cursor Agent Checkpoints',
      '-c', 'user.email=checkpoints@cursor-agent.local',
      ...args,
    ];
    return new Promise((res, rej) => {
      const child = execFile(
        'git',
        full,
        { cwd: this.root, env, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: opts.timeoutMs ?? 60_000 },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
          if (e && e.code === 'ENOENT') return rej(new GitMissingError('git is not on PATH'));
          if (e && e.killed) return rej(new Error(`git ${args[0]} timed out`));
          res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: stdout as Buffer, stderr: (stderr as Buffer).toString('utf8') });
        },
      );
      if (opts.input) child.stdin?.end(opts.input);
      else child.stdin?.end();
    });
  }

  private async gitOk(args: string[], timeoutMs?: number): Promise<Buffer> {
    const r = await this.git(args, { timeoutMs });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
    return r.stdout;
  }

  /** Creates the shadow repo on first use. */
  init(): Promise<void> {
    this.initialized ??= (async () => {
      mkdirSync(this.gitDir, { recursive: true });
      if (!existsSync(join(this.gitDir, 'HEAD'))) {
        await this.gitOk(['init', '--quiet']);
        this.log(`[checkpoints] created shadow repo ${this.gitDir}`);
      }
      mkdirSync(join(this.gitDir, 'no-hooks'), { recursive: true });
      mkdirSync(join(this.gitDir, 'info'), { recursive: true });
      // Highest-precedence attributes: never convert line endings or run filters (LFS, ident...).
      writeFileSync(join(this.gitDir, 'info', 'attributes'), '* -text !filter !eol !ident !working-tree-encoding\n');
      this.writeExcludes([]);
      await this.gitOk(['config', 'core.bare', 'false']);
    })();
    return this.initialized;
  }

  private writeExcludes(largeFiles: string[]): void {
    const lines = [
      '# Managed by Cursor Agent checkpoints',
      ...DEFAULT_EXCLUDES,
      ...(this.opts.exclude ?? []),
      ...largeFiles.map((f) => `/${f.replace(/([*?[\]!#\\])/g, '\\$1')}`),
    ];
    writeFileSync(join(this.gitDir, 'info', 'exclude'), lines.join('\n') + '\n');
  }

  private largeFiles = new Set<string>();

  /** Exclude files over the size cap (new or grown since last time). */
  private async excludeLargeFiles(): Promise<void> {
    const out = await this.gitOk(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
    const entries = out.toString('utf8').split('\0').filter(Boolean);
    const newlyLarge: string[] = [];
    for (const e of entries) {
      const path = e.slice(3);
      if (this.largeFiles.has(path)) continue;
      try {
        const s = await stat(join(this.root, path));
        if (s.isFile() && s.size > this.maxFileBytes) newlyLarge.push(path);
      } catch {
        /* deleted */
      }
    }
    if (!newlyLarge.length) return;
    newlyLarge.forEach((p) => this.largeFiles.add(p));
    this.writeExcludes([...this.largeFiles]);
    // Untrack any that were tracked before they grew.
    await this.git(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...newlyLarge]);
    this.log(`[checkpoints] excluded ${newlyLarge.length} file(s) over ${this.maxFileBytes} bytes`);
  }

  /**
   * Commit the current work tree. Returns the commit SHA, or throws (timeout / git missing).
   * `label` should identify the tab and run, e.g. `pre:<tabId>:<runId>`.
   */
  snapshot(label: string): Promise<string> {
    return this.serial(async () => {
      await this.init();
      const t0 = Date.now();
      const deadline = this.snapshotTimeoutMs;
      await this.excludeLargeFiles();
      await this.gitOk(['add', '-A', '--', '.'], deadline);
      await this.gitOk(['commit', '--quiet', '--allow-empty', '--no-verify', '-m', label], deadline);
      const sha = (await this.gitOk(['rev-parse', 'HEAD'])).toString('utf8').trim();
      this.log(`[checkpoints] ${label} → ${sha.slice(0, 10)} (${Date.now() - t0} ms)`);
      return sha;
    });
  }

  /** Files that differ between two commits, with line counts. */
  diff(fromSha: string, toSha: string): Promise<FileChange[]> {
    return this.serial(async () => {
      const ns = (await this.gitOk(['diff', '--name-status', '-z', '--no-renames', fromSha, toSha])).toString('utf8').split('\0');
      const num = (await this.gitOk(['diff', '--numstat', '-z', '--no-renames', fromSha, toSha])).toString('utf8').split('\0');
      const counts = new Map<string, { a: number; r: number; bin: boolean }>();
      for (const rec of num) {
        const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
        if (!m) continue;
        counts.set(m[3]!, { a: m[1] === '-' ? 0 : Number(m[1]), r: m[2] === '-' ? 0 : Number(m[2]), bin: m[1] === '-' });
      }
      const out: FileChange[] = [];
      for (let i = 0; i + 1 < ns.length; i += 2) {
        const st = ns[i]!;
        const path = ns[i + 1]!;
        if (!st || !path) continue;
        const status: ChangeStatus = st.startsWith('A') ? 'A' : st.startsWith('D') ? 'D' : 'M';
        const c = counts.get(path) ?? { a: 0, r: 0, bin: false };
        out.push({ path, status, added: c.a, removed: c.r, binary: c.bin });
      }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    });
  }

  /** File bytes at a commit, or undefined if it didn't exist there. */
  readBlob(sha: string, path: string): Promise<Buffer | undefined> {
    return this.serial(async () => {
      const r = await this.git(['cat-file', 'blob', `${sha}:${path}`]);
      return r.code === 0 ? r.stdout : undefined;
    });
  }

  /** Blob id of a file at a commit (undefined if absent). */
  private async blobId(sha: string, path: string): Promise<string | undefined> {
    const r = await this.git(['rev-parse', '--verify', '--quiet', `${sha}:${path}`]);
    return r.code === 0 ? r.stdout.toString('utf8').trim() : undefined;
  }

  /** Blob id the current work-tree file would have (undefined if absent). */
  private async workBlobId(path: string): Promise<string | undefined> {
    const abs = join(this.root, path);
    if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
    // Hash the raw bytes (no filters/EOL conversion) exactly as `add` stored them.
    const r = await this.git(['hash-object', '--no-filters', '--', abs]);
    return r.code === 0 ? r.stdout.toString('utf8').trim() : undefined;
  }

  /**
   * True if the work-tree file no longer matches its state at `sha` (e.g. another run or the
   * user changed it after this run finished).
   */
  changedSince(sha: string, path: string): Promise<boolean> {
    return this.serial(async () => (await this.blobId(sha, path)) !== (await this.workBlobId(path)));
  }

  /** Restore one file to its exact bytes at `sha`; deletes it if it didn't exist there. */
  restoreFile(sha: string, path: string): Promise<void> {
    return this.serial(async () => {
      const abs = join(this.root, path);
      if (!abs.startsWith(this.root)) throw new Error(`path escapes workspace: ${path}`);
      const r = await this.git(['cat-file', 'blob', `${sha}:${path}`]);
      if (r.code === 0) {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, r.stdout);
      } else {
        await rm(abs, { force: true });
      }
      this.log(`[checkpoints] restored ${path} from ${sha.slice(0, 10)}${r.code === 0 ? '' : ' (deleted)'}`);
    });
  }

  /** Current bytes of a work-tree file (for tests / diff fallbacks). */
  async readWorkFile(path: string): Promise<Buffer | undefined> {
    try {
      return await readFile(join(this.root, path));
    } catch {
      return undefined;
    }
  }
}
