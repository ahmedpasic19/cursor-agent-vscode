/**
 * Changes card actions: open diff, revert/keep per file, revert/keep all, restore to before a
 * message (PLAN.md §5.6). Reverts are scoped to the files the run changed, and warn before
 * overwriting files that changed after the run (another tab, or the user).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ChangedFile, RunRecord } from '../shared/protocol';
import type { SessionManager } from '../session/SessionManager';
import type { TabSession } from '../session/TabSession';
import { CheckpointService, isGitAvailable, workspaceHash } from './CheckpointService';
import { DiffProvider } from './DiffProvider';

export type Confirm = (message: string, detail: string, action: string) => Promise<boolean>;

const modalConfirm: Confirm = async (message, detail, action) =>
  (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;

export class ChangesController {
  private readonly services = new Map<string, CheckpointService>();
  /** Replaceable for tests (modal dialogs can't be clicked there). */
  confirm: Confirm = modalConfirm;

  constructor(
    private readonly storageDir: vscode.Uri,
    private readonly manager: SessionManager,
    private readonly cfg: () => vscode.WorkspaceConfiguration,
    private readonly log: (line: string) => void,
    private readonly notify: (tab: TabSession, run: RunRecord) => void,
  ) {}

  /** Checkpoint service for a root, or why checkpoints are off. */
  async sourceFor(root: string): Promise<CheckpointService | { unavailable: string } | undefined> {
    if (!this.cfg().get<boolean>('checkpoints.enabled', true)) return undefined;
    if (!(await isGitAvailable())) {
      return { unavailable: 'git is not on PATH, so this run has no checkpoint and no undo. Install Git to enable checkpoints.' };
    }
    return this.service(root);
  }

  service(root: string): CheckpointService {
    const key = root.toLowerCase();
    let s = this.services.get(key);
    if (!s) {
      const dir = vscode.Uri.joinPath(this.storageDir, workspaceHash(root), 'shadow.git');
      s = new CheckpointService({
        root,
        gitDir: dir.fsPath,
        exclude: this.cfg().get<string[]>('checkpoints.exclude', []),
        log: this.log,
      });
      this.services.set(key, s);
    }
    return s;
  }

  private lookup(tabId: string, runId: string) {
    const tab = this.manager.getTab(tabId);
    const run = tab?.findRun(runId);
    const ch = run?.changes;
    if (!tab?.cwd || !run || !ch || ch.status !== 'ready' || !ch.preSha || !ch.postSha) return undefined;
    return { tab, run, changes: ch, svc: this.service(tab.cwd), root: tab.cwd, pre: ch.preSha, post: ch.postSha };
  }

  async openDiff(tabId: string, runId: string, path: string): Promise<void> {
    const x = this.lookup(tabId, runId);
    if (!x) return;
    const file = x.changes.files.find((f) => f.path === path);
    const left = DiffProvider.uri(x.root, file?.status === 'A' ? 'empty' : x.pre, path);
    const abs = join(x.root, path);
    const right = existsSync(abs) ? vscode.Uri.file(abs) : DiffProvider.uri(x.root, 'empty', path);
    const name = path.split('/').pop();
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (before agent run ↔ now)`, { preview: true });
  }

  private setState(tab: TabSession, run: RunRecord, paths: string[], state: ChangedFile['state']): void {
    if (!run.changes) return;
    run.changes = {
      ...run.changes,
      files: run.changes.files.map((f) => (paths.includes(f.path) ? { ...f, state } : f)),
    };
    this.notify(tab, run);
  }

  /** Files whose current content differs from `post` (changed after the run). */
  private async conflicts(svc: CheckpointService, post: string, paths: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const p of paths) if (await svc.changedSince(post, p)) out.push(p);
    return out;
  }

  async revertFile(tabId: string, runId: string, path: string): Promise<boolean> {
    const x = this.lookup(tabId, runId);
    if (!x) return false;
    if ((await this.conflicts(x.svc, x.post, [path])).length) {
      const ok = await this.confirm(
        `${path} changed after this run.`,
        'It was edited later (by you or another tab). Reverting restores the version from before this run and discards those later edits.',
        'Revert anyway',
      );
      if (!ok) return false;
    }
    await x.svc.restoreFile(x.pre, path);
    this.setState(x.tab, x.run, [path], 'reverted');
    return true;
  }

  keepFile(tabId: string, runId: string, path: string): void {
    const x = this.lookup(tabId, runId);
    if (x) this.setState(x.tab, x.run, [path], 'kept');
  }

  keepAll(tabId: string, runId: string): void {
    const x = this.lookup(tabId, runId);
    if (!x) return;
    this.setState(x.tab, x.run, x.changes.files.filter((f) => f.state === 'pending').map((f) => f.path), 'kept');
  }

  async revertAll(tabId: string, runId: string): Promise<boolean> {
    const x = this.lookup(tabId, runId);
    if (!x) return false;
    const paths = x.changes.files.filter((f) => f.state !== 'reverted').map((f) => f.path);
    if (!paths.length) return false;
    const conflicts = await this.conflicts(x.svc, x.post, paths);
    const detail = [
      `Restores ${paths.length} file${paths.length === 1 ? '' : 's'} to how they were before this run. Only files this run changed are touched.`,
      conflicts.length
        ? `\nThese changed after the run and their later edits will be lost:\n${conflicts.map((c) => `• ${c}`).join('\n')}`
        : '',
    ].join('');
    const ok = await this.confirm(`Revert all changes from this run?`, detail, 'Revert all');
    if (!ok) return false;
    for (const p of paths) await x.svc.restoreFile(x.pre, p);
    this.setState(x.tab, x.run, paths, 'reverted');
    return true;
  }

  /**
   * Restore code to before a user message: every file changed by that message's run and all
   * later runs in the tab goes back to the first run's pre-checkpoint.
   */
  async restoreToMessage(tabId: string, userMessageId: string): Promise<boolean> {
    const tab = this.manager.getTab(tabId);
    if (!tab?.cwd || tab.running) return false;
    const idx = tab.transcript.findIndex((i) => i.id === userMessageId);
    if (idx < 0) return false;
    const runs = tab.transcript
      .slice(idx)
      .filter((i): i is RunRecord => i.role === 'run' && i.changes?.status === 'ready' && !!i.changes.preSha && !!i.changes.postSha);
    if (!runs.length) return false;
    const target = runs[0]!.changes!.preSha!;
    // The last run that touched a file is the one whose post state must still match.
    const lastPost = new Map<string, string>();
    for (const r of runs) for (const f of r.changes!.files) lastPost.set(f.path, r.changes!.postSha!);
    const paths = [...lastPost.keys()];
    if (!paths.length) {
      void vscode.window.showInformationMessage('No file changes to restore after this message.');
      return false;
    }
    const svc = this.service(tab.cwd);
    const conflicts: string[] = [];
    for (const [p, post] of lastPost) if (await svc.changedSince(post, p)) conflicts.push(p);
    const ok = await this.confirm(
      'Restore code to before this message?',
      `Restores ${paths.length} file${paths.length === 1 ? '' : 's'} changed by ${runs.length} run${runs.length === 1 ? '' : 's'} from this point on.` +
        (conflicts.length ? `\n\nThese changed afterwards and those edits will be lost:\n${conflicts.map((c) => `• ${c}`).join('\n')}` : ''),
      'Restore',
    );
    if (!ok) return false;
    for (const p of paths) await svc.restoreFile(target, p);
    for (const r of runs) this.setState(tab, r, r.changes!.files.map((f) => f.path), 'reverted');
    return true;
  }
}

