import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CheckpointService, workspaceHash } from '../src/checkpoints/CheckpointService';

let ws: string;
let store: string;

function svc(extra: Partial<ConstructorParameters<typeof CheckpointService>[0]> = {}) {
  return new CheckpointService({ root: ws, gitDir: join(store, 'shadow.git'), ...extra });
}

const CRLF = 'line one\r\nline two\r\nline three\r\n';
const BINARY = Buffer.from([0, 1, 2, 255, 254, 13, 10, 13, 0, 10]);

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ckpt-test-'));
  ws = join(base, 'ws');
  store = join(base, 'store');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'a.ts'), CRLF);
  writeFileSync(join(ws, 'src', 'b.ts'), 'export const b = 1;\n');
  writeFileSync(join(ws, 'logo.bin'), BINARY);
});

/** Hash of every file under a directory (to prove the user's .git is untouched). */
function treeHash(dir: string): string {
  const h = createHash('sha1');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else h.update(p).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

describe('CheckpointService', () => {
  it('works in a non-git folder: lists added, modified and deleted files with counts', async () => {
    const c = svc();
    const pre = await c.snapshot('pre:t:r');
    writeFileSync(join(ws, 'src', 'a.ts'), 'line one\r\nline 2\r\nline three\r\nline four\r\n');
    rmSync(join(ws, 'src', 'b.ts'));
    writeFileSync(join(ws, 'new.txt'), 'created by a shell command\n');
    const post = await c.snapshot('post:t:r');
    expect(await c.diff(pre, post)).toEqual([
      { path: 'new.txt', status: 'A', added: 1, removed: 0, binary: false },
      { path: 'src/a.ts', status: 'M', added: 2, removed: 1, binary: false },
      { path: 'src/b.ts', status: 'D', added: 0, removed: 1, binary: false },
    ]);
  });

  it('restores exact bytes, including CRLF and binary content', async () => {
    const c = svc();
    const pre = await c.snapshot('pre');
    writeFileSync(join(ws, 'src', 'a.ts'), 'totally\nrewritten\n');
    writeFileSync(join(ws, 'logo.bin'), Buffer.from('not binary anymore'));
    writeFileSync(join(ws, 'added.ts'), 'x');
    const post = await c.snapshot('post');
    const changes = await c.diff(pre, post);
    expect(changes.find((f) => f.path === 'logo.bin')?.binary).toBe(true);
    for (const f of changes) await c.restoreFile(pre, f.path);
    expect(readFileSync(join(ws, 'src', 'a.ts'))).toEqual(Buffer.from(CRLF));
    expect(readFileSync(join(ws, 'logo.bin'))).toEqual(BINARY);
    expect(existsSync(join(ws, 'added.ts'))).toBe(false);
  });

  it('restores a deleted file into a deleted folder', async () => {
    const c = svc();
    const pre = await c.snapshot('pre');
    rmSync(join(ws, 'src'), { recursive: true });
    await c.snapshot('post');
    await c.restoreFile(pre, 'src/a.ts');
    expect(readFileSync(join(ws, 'src', 'a.ts'))).toEqual(Buffer.from(CRLF));
  });

  it("never touches the user's own .git, and ignores autocrlf/eol attributes", async () => {
    // GIT_OPTIONAL_LOCKS=0 keeps this test's own `git status` from refreshing the index stat
    // cache, which would otherwise (racily) change .git/index and make the check flaky.
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: ws, stdio: 'pipe', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).toString();
    git('init', '-q');
    git('config', 'user.email', 'u@example.com');
    git('config', 'user.name', 'User');
    git('config', 'core.autocrlf', 'true'); // would convert CRLF if it leaked into the shadow repo
    writeFileSync(join(ws, '.gitattributes'), '* text=auto eol=lf\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'user commit');
    // Re-write CRLF after the user's commit normalized nothing on disk.
    writeFileSync(join(ws, 'src', 'a.ts'), CRLF);
    const before = treeHash(join(ws, '.git'));
    const statusBefore = git('status', '--porcelain');

    const c = svc();
    const pre = await c.snapshot('pre');
    writeFileSync(join(ws, 'src', 'a.ts'), 'changed\n');
    const post = await c.snapshot('post');
    await c.diff(pre, post);
    await c.restoreFile(pre, 'src/a.ts');

    expect(readFileSync(join(ws, 'src', 'a.ts'))).toEqual(Buffer.from(CRLF));
    expect(treeHash(join(ws, '.git'))).toBe(before);
    expect(git('status', '--porcelain')).toBe(statusBefore);
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1);
  });

  it('honors the workspace .gitignore and default excludes', async () => {
    writeFileSync(join(ws, '.gitignore'), 'secret.env\n');
    mkdirSync(join(ws, 'node_modules', 'x'), { recursive: true });
    const c = svc();
    const pre = await c.snapshot('pre');
    writeFileSync(join(ws, 'secret.env'), 'TOKEN=1');
    writeFileSync(join(ws, 'node_modules', 'x', 'index.js'), 'x');
    writeFileSync(join(ws, 'src', 'b.ts'), 'export const b = 2;\n');
    const post = await c.snapshot('post');
    expect((await c.diff(pre, post)).map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('skips files over the size cap', async () => {
    const c = svc({ maxFileBytes: 1000 });
    const pre = await c.snapshot('pre');
    writeFileSync(join(ws, 'big.dat'), Buffer.alloc(5000, 1));
    writeFileSync(join(ws, 'small.txt'), 'ok');
    const post = await c.snapshot('post');
    expect((await c.diff(pre, post)).map((f) => f.path)).toEqual(['small.txt']);
  });

  it('detects files changed after a run finished (parallel-run safety)', async () => {
    const c = svc();
    const pre = await c.snapshot('pre');
    writeFileSync(join(ws, 'src', 'b.ts'), 'run A\n');
    const post = await c.snapshot('post');
    expect(await c.changedSince(post, 'src/b.ts')).toBe(false);
    writeFileSync(join(ws, 'src', 'b.ts'), 'tab B edited this later\n');
    expect(await c.changedSince(post, 'src/b.ts')).toBe(true);
    // A file deleted after the run counts as changed too.
    rmSync(join(ws, 'src', 'a.ts'));
    expect(await c.changedSince(post, 'src/a.ts')).toBe(true);
    void pre;
  });

  it('serializes concurrent snapshots from parallel runs', async () => {
    const c = svc();
    const shas = await Promise.all([c.snapshot('one'), c.snapshot('two'), c.snapshot('three')]);
    expect(new Set(shas).size).toBe(3);
  });

  it('reads blobs for the diff view', async () => {
    const c = svc();
    const pre = await c.snapshot('pre');
    expect((await c.readBlob(pre, 'src/a.ts'))?.toString()).toBe(CRLF);
    expect(await c.readBlob(pre, 'nope.ts')).toBeUndefined();
  });

  it('workspaceHash is stable and case-insensitive', () => {
    expect(workspaceHash('C:\\Proj\\X')).toBe(workspaceHash('c:\\proj\\x'));
    expect(workspaceHash('C:\\Proj\\X')).toHaveLength(16);
  });
});
