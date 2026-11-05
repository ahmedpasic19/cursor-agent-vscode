/**
 * Workspace file list for @-mentions. Uses `git ls-files` (respects .gitignore) when the folder
 * is a git repo, else vscode.workspace.findFiles (respects files.exclude). Cached per root and
 * invalidated by a file-system watcher.
 */
import { execFile } from 'node:child_process';
import { relative } from 'node:path';
import * as vscode from 'vscode';
import { type Candidate, fuzzyFilter, withFolders } from './fuzzy';

const MAX_FILES = 50_000;
const DEFAULT_EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/coverage/**}';

export class FileIndex implements vscode.Disposable {
  private cache = new Map<string, Promise<Candidate[]>>();
  private readonly watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);

  constructor(private readonly log: (l: string) => void) {
    const invalidate = () => this.cache.clear();
    this.watcher.onDidCreate(invalidate);
    this.watcher.onDidDelete(invalidate);
  }

  async search(root: string, query: string, limit = 50): Promise<Candidate[]> {
    return this.searchAll([{ root }], query, limit);
  }

  /** Searches several workspace folders at once; candidates carry their `root` (and `folder` name). */
  async searchAll(roots: { root: string; folder?: string }[], query: string, limit = 50): Promise<Candidate[]> {
    const lists = await Promise.all(roots.map((r) => this.get(r.root, r.folder)));
    return fuzzyFilter(query.trim(), lists.flat(), limit);
  }

  private get(root: string, folder?: string): Promise<Candidate[]> {
    const key = `${root}|${folder ?? ''}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.load(root, folder);
      this.cache.set(key, p);
    }
    return p;
  }

  private async load(root: string, folder?: string): Promise<Candidate[]> {
    const t0 = Date.now();
    let files = await gitFiles(root);
    let source = 'git';
    if (!files) {
      source = 'findFiles';
      const base = vscode.Uri.file(root);
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(base, '**/*'), DEFAULT_EXCLUDE, MAX_FILES);
      files = uris.map((u) => relative(root, u.fsPath).replace(/\\/g, '/'));
    }
    this.log(`[mentions] indexed ${files.length} files via ${source} in ${Date.now() - t0} ms`);
    return withFolders(files.slice(0, MAX_FILES), { root, folder });
  }

  dispose(): void {
    this.watcher.dispose();
  }
}

function gitFiles(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', 'ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 10_000 },
      (err, stdout) => {
        if (err) return resolve(undefined);
        resolve(stdout.split('\n').map((l) => l.trim()).filter(Boolean));
      },
    );
  });
}
