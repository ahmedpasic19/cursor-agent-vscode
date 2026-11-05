/**
 * Phase 4 acceptance in a real VS Code: an Agent run (fake CLI applying file actions) edits two
 * files and "runs a command" that creates a third; the Changes card lists all three, the diff
 * opens, Revert file / Revert all restore exact bytes (CRLF), and the user's .git is untouched.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { CursorAgentApi } from '../../src/extension';
import type { RunRecord } from '../../src/shared/protocol';
import { assert, test, waitFor } from './helpers';

function treeHash(dir: string): string {
  const h = createHash('sha1');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

export async function checkpointTests(api: CursorAgentApi, actionsFile: string): Promise<void> {
  console.log('Checkpoint / Changes card integration tests');
  const mgr = api.manager;
  const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const read = (p: string) => readFileSync(join(ws, p));
  // GIT_OPTIONAL_LOCKS=0: our own `git status` must not refresh the user's index stat cache,
  // or the byte-for-byte .git comparison would flag the test itself.
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: ws, stdio: 'pipe', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).toString();

  // Phase 3 left an unsaved edit in api.ts; discard it so disk and editor agree.
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // The Phase 3 tests didn't touch disk, so the user's repo is clean here.
  const gitStatusBefore = git('status', '--porcelain');
  const userGitBefore = treeHash(join(ws, '.git'));
  const apiBefore = read('src/api.ts');
  const appBefore = read('src/app.ts');
  assert(apiBefore.includes(Buffer.from('\r\n')), 'fixture api.ts should be CRLF');

  // Every confirm dialog answers "yes" unless a test says otherwise.
  const confirms: string[] = [];
  let answer = true;
  api.changes.confirm = async (message) => {
    confirms.push(message);
    return answer;
  };

  const tab = mgr.newTab();
  const runAgent = async (text: string, actions: unknown[]): Promise<RunRecord> => {
    writeFileSync(actionsFile, JSON.stringify(actions));
    process.env.FAKE_ACTIONS = actionsFile;
    process.env.FAKE_FIXTURE = 'agent-shell';
    const n = tab.transcript.length;
    mgr.send(tab.id, text, 'agent', undefined);
    const run = await waitFor(() => {
      const r = tab.transcript[n + 1];
      return !tab.running && r?.role === 'run' && r.changes?.status === 'ready' ? r : undefined;
    }, 30000, 'agent run with changes');
    return run;
  };

  let run1!: RunRecord;
  await test('Changes card lists both edited files and the file a command created', async () => {
    run1 = await runAgent('Edit two files and run a command', [
      { op: 'write', path: 'src/api.ts', content: 'export const rewritten = true;\n' },
      { op: 'write', path: 'src/app.ts', content: "import { rewritten } from './api';\nconsole.log(rewritten);\n" },
      { op: 'write', path: 'src/generated.txt', content: 'created by a shell command\n' },
    ]);
    const files = run1.changes!.files.map((f) => `${f.status} ${f.path}`);
    assert(files.join() === 'M src/api.ts,M src/app.ts,A src/generated.txt', `files: ${files}`);
    const api = run1.changes!.files[0]!;
    assert(api.added === 1 && api.removed === 40, `api counts +${api.added} -${api.removed}`);
  });

  await test('clicking a file opens a diff against the checkpoint', async () => {
    await api.changes.openDiff(tab.id, run1.id, 'src/api.ts');
    const input = await waitFor(() => {
      const i = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return i instanceof vscode.TabInputTextDiff ? i : undefined;
    }, 5000, 'diff editor');
    assert(input.original.scheme === 'cursor-checkpoint', `left scheme ${input.original.scheme}`);
    assert(input.modified.fsPath.toLowerCase() === join(ws, 'src', 'api.ts').toLowerCase(), `right ${input.modified.fsPath}`);
    const left = await vscode.workspace.openTextDocument(input.original);
    assert(left.getText().includes('export const line10 = 10;'), 'left side is not the pre-run content');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  await test('Revert file restores the exact original bytes (CRLF)', async () => {
    const ok = await api.changes.revertFile(tab.id, run1.id, 'src/api.ts');
    assert(ok, 'revertFile returned false');
    assert(read('src/api.ts').equals(apiBefore), 'api.ts bytes differ after revert');
    assert(run1.changes!.files.find((f) => f.path === 'src/api.ts')!.state === 'reverted', 'state not reverted');
  });

  await test('Revert all restores the rest and deletes the created file; .git untouched', async () => {
    const ok = await api.changes.revertAll(tab.id, run1.id);
    assert(ok, 'revertAll returned false');
    assert(read('src/app.ts').equals(appBefore), 'app.ts bytes differ');
    assert(!existsSync(join(ws, 'src', 'generated.txt')), 'generated.txt still exists');
    assert(run1.changes!.files.every((f) => f.state === 'reverted'), 'not all reverted');
    assert(git('status', '--porcelain') === gitStatusBefore, `user repo status changed:\n${git('status', '--porcelain')}`);
    assert(treeHash(join(ws, '.git')) === userGitBefore, "user's .git changed");
  });

  await test('reverting a file that changed after the run asks first', async () => {
    const run2 = await runAgent('Edit app.ts', [{ op: 'write', path: 'src/app.ts', content: 'run 2\n' }]);
    writeFileSync(join(ws, 'src', 'app.ts'), 'edited later by another tab\n');
    confirms.length = 0;
    answer = false;
    assert(!(await api.changes.revertFile(tab.id, run2.id, 'src/app.ts')), 'reverted despite "no"');
    assert(confirms[0]?.includes('changed after this run'), `confirm: ${confirms[0]}`);
    assert(read('src/app.ts').toString() === 'edited later by another tab\n', 'file touched after "no"');
    answer = true;
    assert(await api.changes.revertFile(tab.id, run2.id, 'src/app.ts'), 'not reverted after "yes"');
    assert(read('src/app.ts').equals(appBefore), 'app.ts not restored');
  });

  await test('Restore code to before a message undoes that run and later ones', async () => {
    const r3 = await runAgent('first', [{ op: 'write', path: 'src/api.ts', content: 'three\n' }]);
    await runAgent('second', [
      { op: 'write', path: 'src/api.ts', content: 'four\n' },
      { op: 'write', path: 'src/extra.ts', content: 'x' },
    ]);
    const userMsg = tab.transcript[tab.transcript.indexOf(r3) - 1]!;
    assert(await api.changes.restoreToMessage(tab.id, userMsg.id), 'restore returned false');
    assert(read('src/api.ts').equals(apiBefore), 'api.ts not back to before the message');
    assert(!existsSync(join(ws, 'src', 'extra.ts')), 'extra.ts still exists');
    assert(git('status', '--porcelain') === gitStatusBefore, 'user repo not clean after restore');
  });

  await test('Ask runs take no checkpoint', async () => {
    process.env.FAKE_FIXTURE = 'ask-simple';
    writeFileSync(actionsFile, '[]');
    const n = tab.transcript.length;
    mgr.send(tab.id, 'question', 'ask', undefined);
    const r = await waitFor(() => (!tab.running && tab.transcript[n + 1]?.role === 'run' ? tab.transcript[n + 1] : undefined), 20000, 'ask run');
    assert(r.role === 'run' && r.changes === undefined, 'ask run has changes');
  });

  await test("user's .git is byte-identical after all checkpoint operations", async () => {
    assert(treeHash(join(ws, '.git')) === userGitBefore, "user's .git changed during checkpoint tests");
  });
}
