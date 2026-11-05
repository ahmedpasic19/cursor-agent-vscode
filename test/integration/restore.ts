/**
 * Phase 5 acceptance (second VS Code launch, same profile): tabs, transcripts, the active tab,
 * interrupted runs and checkpoints survive a restart.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { CursorAgentApi } from '../../src/extension';
import type { RunRecord } from '../../src/shared/protocol';
import { assert, results, test, waitFor } from './helpers';

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<CursorAgentApi>('local.cursor-agent-vscode');
  assert(ext, 'extension not found');
  const api = await ext.activate();
  await api.cliReady();
  const mgr = api.manager;
  const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  api.changes.confirm = async () => true;
  console.log('Restart restore integration tests (launch 2)');
  const byTitle = (t: string) => mgr.tabs.find((x) => x.title === t);
  const lastRun = (t: { transcript: unknown[] }) => [...(t.transcript as RunRecord[])].reverse().find((i) => i.role === 'run')!;

  await test('restarting VS Code restores the open tabs and the active tab', async () => {
    assert(mgr.tabs.map((t) => t.title).join() === 'Persist me,Second tab,Still running', `tabs: ${mgr.tabs.map((t) => t.title)}`);
    assert(mgr.activeTab?.title === 'Second tab', `active: ${mgr.activeTab?.title}`);
  });

  await test('transcripts are restored (messages, events, session ids)', async () => {
    const second = byTitle('Second tab')!;
    assert(second.transcript.length === 2, `second transcript length ${second.transcript.length}`);
    const r = lastRun(second);
    assert(r.status === 'success', `status ${r.status}`);
    const text = r.events.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join('');
    assert(text.includes('exports a single function'), 'assistant text missing');
    assert(!!second.sessionId, 'session id missing');
  });

  await test('a run that was active at shutdown is marked Interrupted and can be resumed', async () => {
    const t = byTitle('Still running')!;
    const r = lastRun(t);
    assert(r.status === 'interrupted', `status ${r.status}`);
    assert(!t.running, 'tab still marked running');
    mgr.resume(t.id);
    await waitFor(() => !t.running && lastRun(t) !== r, 20000, 'resume run');
    const user = t.transcript[t.transcript.length - 2] as { role: string; text: string };
    assert(user.role === 'user' && user.text === 'continue', `resume sent ${user.text}`);
    assert(lastRun(t).status === 'success', `resume status ${lastRun(t).status}`);
  });

  await test('checkpoints survive the restart: Revert all on a restored run restores the file', async () => {
    const t = byTitle('Persist me')!;
    const r = lastRun(t);
    assert(r.changes?.status === 'ready' && r.changes.files[0]?.path === 'persist.txt', 'changes not restored');
    assert(readFileSync(join(ws, 'persist.txt'), 'utf8') === 'after\n', 'unexpected persist.txt');
    assert(await api.changes.revertAll(t.id, r.id), 'revertAll failed');
    assert(readFileSync(join(ws, 'persist.txt'), 'utf8') === 'before\r\n', 'persist.txt not restored byte-exactly');
  });

  await test('history lists closed chats from launch 1 and can reopen one', async () => {
    const items = api.history.list(new Set(mgr.tabs.map((t) => t.id)));
    const overlap = items.find((i) => i.title === 'Overlap A');
    assert(overlap && !overlap.open, `history: ${items.map((i) => i.title)}`);
    const data = api.history.load(overlap.id)!;
    const tab = mgr.restoreTab(data, true);
    mgr.activate(tab.id, true);
    assert(lastRun(tab).warnings?.length, 'reopened chat lost its warnings');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) throw new Error(failed.map((f) => `${f.name}: ${f.error}`).join('\n\n'));
}
