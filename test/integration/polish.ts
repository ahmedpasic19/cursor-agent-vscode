/** Phase 6 in a real VS Code: code block Insert / Apply, and the worktree toggle. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { CursorAgentApi } from '../../src/extension';
import type { RunRecord } from '../../src/shared/protocol';
import { assert, test, waitFor } from './helpers';

export async function polishTests(api: CursorAgentApi): Promise<void> {
  console.log('Polish integration tests (code blocks, worktree)');
  const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const mgr = api.manager;

  await test('Insert puts code at the cursor of the last active editor', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(ws, 'src', 'app.ts')));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    assert(await api.code.insert('// inserted by chat\n'), 'insert returned false');
    assert(doc.getText().startsWith('// inserted by chat\n'), `doc starts: ${doc.getText().slice(0, 30)}`);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  await test('Apply shows a diff, then writes the file keeping its CRLF line endings', async () => {
    const file = join(ws, 'src', 'api.ts');
    const original = readFileSync(file);
    assert(original.includes(Buffer.from('\r\n')), 'fixture should be CRLF');
    let diffSeen = false;
    api.code.confirmApply = async () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      diffSeen = input instanceof vscode.TabInputTextDiff;
      return true;
    };
    assert(await api.code.apply(ws, 'src/api.ts', 'export const applied = 1;\nexport const two = 2;'), 'apply returned false');
    assert(diffSeen, 'no diff preview before applying');
    const now = readFileSync(file, 'utf8');
    assert(now === 'export const applied = 1;\r\nexport const two = 2;\r\n', `file now: ${JSON.stringify(now)}`);
    writeFileSync(file, original);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  await test('Apply creates a new file; declining leaves files untouched', async () => {
    api.code.confirmApply = async () => true;
    assert(await api.code.apply(ws, 'src/new/created.ts', 'export const created = true;'), 'apply new returned false');
    assert(readFileSync(join(ws, 'src', 'new', 'created.ts'), 'utf8') === 'export const created = true;\n', 'new file content');
    api.code.confirmApply = async () => false;
    assert(!(await api.code.apply(ws, 'src/declined.ts', 'x')), 'declined apply returned true');
    assert(!existsSync(join(ws, 'src', 'declined.ts')), 'declined file was created');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  await test('Worktree toggle passes --worktree <tab name> and records the worktree path', async () => {
    const tab = mgr.newTab(true);
    tab.setWorktree(true);
    process.env.FAKE_FIXTURE = 'worktree-ask';
    mgr.send(tab.id, 'what is in a.txt?', 'ask', undefined);
    await waitFor(() => !tab.running && tab.transcript.length === 2, 20000, 'worktree run');
    const { args } = JSON.parse(readFileSync(process.env.FAKE_RECORD!, 'utf8')) as { args: string[] };
    const i = args.indexOf('--worktree');
    assert(i >= 0 && args[i + 1] === tab.worktreeName, `args: ${args.join(' ')}`);
    assert(tab.worktreePath?.includes('.cursor'), `worktreePath: ${tab.worktreePath}`);
    const run = tab.transcript[1] as RunRecord;
    assert(run.status === 'success' && !run.events.some((e) => e.kind === 'unknown'), 'worktree line rendered as unknown');

    // Agent runs in a worktree don't checkpoint the user's tree.
    process.env.FAKE_FIXTURE = 'ask-simple';
    mgr.send(tab.id, 'edit something', 'agent', undefined);
    await waitFor(() => !tab.running && tab.transcript.length === 4, 20000, 'worktree agent run');
    const agentRun = tab.transcript[3] as RunRecord;
    assert(agentRun.changes?.status === 'unavailable' && /worktree/.test(agentRun.changes.message ?? ''), `changes: ${JSON.stringify(agentRun.changes)}`);
    mgr.closeTab(tab.id);
  });
}
