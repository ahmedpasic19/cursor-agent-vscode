/**
 * Phase 5 acceptance (first VS Code launch): parallel tabs, revert isolation between tabs,
 * and setting up state that the second launch (restore.ts) must find after a restart.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { CursorAgentApi } from '../../src/extension';
import type { RunRecord } from '../../src/shared/protocol';
import type { TabSession } from '../../src/session/TabSession';
import { assert, test, waitFor } from './helpers';

const fake = (cfg: Record<string, unknown>) => `<<fake ${JSON.stringify(cfg)}>>`;

export async function multiTabTests(api: CursorAgentApi): Promise<void> {
  console.log('Multi-tab / history integration tests (launch 1)');
  const mgr = api.manager;
  const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const read = (p: string) => readFileSync(join(ws, p), 'utf8');
  api.changes.confirm = async () => true;
  delete process.env.FAKE_ACTIONS;
  const idle = (tabs: TabSession[]) => waitFor(() => tabs.every((t) => !t.running), 30000, 'runs to finish');
  const lastRun = (t: TabSession) => [...t.transcript].reverse().find((i): i is RunRecord => i.role === 'run')!;

  await test('two tabs stream at the same time without mixing events', async () => {
    const a = mgr.newTab(true);
    const b = mgr.newTab(true);
    mgr.send(a.id, `${fake({ fixture: 'plan-mode', delay: 10 })} plan`, 'plan', undefined);
    mgr.send(b.id, `${fake({ fixture: 'ask-simple', delay: 10 })} ask`, 'ask', undefined);
    await waitFor(() => a.running && b.running && lastRun(a).events.length > 3 && lastRun(b).events.length > 3, 10000, 'both streaming');
    await idle([a, b]);
    const ra = lastRun(a);
    const rb = lastRun(b);
    assert(ra.status === 'success' && rb.status === 'success', `statuses ${ra.status}/${rb.status}`);
    assert(ra.events.some((e) => e.kind === 'toolCompleted' && e.tool.uiKind === 'plan'), 'plan tab lacks its plan card');
    assert(!rb.events.some((e) => e.kind === 'toolCompleted' && e.tool.uiKind === 'plan'), 'ask tab got a plan event');
    const textA = ra.events.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join('');
    const textB = rb.events.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join('');
    assert(textA.includes('multiply') && !textA.includes('exports a single function'), 'tab A text mixed');
    assert(textB.includes('exports a single function') && !textB.includes('multiply'), 'tab B text mixed');
    assert(a.sessionId !== b.sessionId, 'tabs share a session id');
    mgr.closeTab(a.id);
    mgr.closeTab(b.id);
  });

  await test('Revert all in tab A does not undo tab B’s changes (sequential runs)', async () => {
    writeFileSync(join(ws, 'a.txt'), 'A original\r\n');
    writeFileSync(join(ws, 'b.txt'), 'B original\r\n');
    const A = mgr.newTab(true);
    const B = mgr.newTab(true);
    mgr.send(A.id, fake({ fixture: 'edit-file', file: 'a.txt', delay: 1, actions: [{ op: 'write', path: 'a.txt', content: 'A by agent\n' }] }), 'agent', undefined);
    await idle([A]);
    mgr.send(B.id, fake({ fixture: 'edit-file', file: 'b.txt', delay: 1, actions: [{ op: 'write', path: 'b.txt', content: 'B by agent\n' }] }), 'agent', undefined);
    await idle([B]);
    assert(await api.changes.revertAll(A.id, lastRun(A).id), 'revertAll A failed');
    assert(read('a.txt') === 'A original\r\n', `a.txt: ${read('a.txt')}`);
    assert(read('b.txt') === 'B by agent\n', `b.txt was touched: ${read('b.txt')}`);
    mgr.closeTab(A.id);
    mgr.closeTab(B.id);
  });

  await test('Revert all in tab A skips the file tab B edited during an overlapping run', async () => {
    writeFileSync(join(ws, 'a.txt'), 'A original\r\n');
    writeFileSync(join(ws, 'b.txt'), 'B original\r\n');
    const A = mgr.newTab(true);
    const B = mgr.newTab(true);
    A.rename('Overlap A');
    B.rename('Overlap B');
    mgr.send(A.id, fake({ fixture: 'edit-file', file: 'a.txt', delay: 300, actions: [{ op: 'write', path: 'a.txt', content: 'A by agent\n' }] }), 'agent', undefined);
    await waitFor(() => lastRun(A).events.length > 0, 10000, 'A streaming');
    mgr.send(B.id, fake({ fixture: 'edit-file', file: 'b.txt', delay: 1, actions: [{ op: 'write', path: 'b.txt', content: 'B by agent\n' }] }), 'agent', undefined);
    await idle([A, B]);
    const ra = lastRun(A);
    assert(ra.warnings?.some((w) => w.includes('Overlap B')), `A warnings: ${ra.warnings}`);
    assert(lastRun(B).warnings?.some((w) => w.includes('Overlap A')), 'B has no overlap warning');
    const flags = ra.changes!.files.map((f) => `${f.path}${f.foreign ? '(foreign)' : ''}`).join();
    assert(flags === 'a.txt,b.txt(foreign)', `A files: ${flags}`);
    assert(await api.changes.revertAll(A.id, ra.id), 'revertAll A failed');
    assert(read('a.txt') === 'A original\r\n', 'a.txt not reverted');
    assert(read('b.txt') === 'B by agent\n', `tab B's b.txt was undone: ${read('b.txt')}`);
    mgr.closeTab(A.id);
    mgr.closeTab(B.id);
  });

  // ---- state for the restart check (restore.ts) ----
  await test('prepare tabs for the restart check', async () => {
    for (const t of [...mgr.tabs]) mgr.closeTab(t.id);
    const keep = mgr.tabs[0]!; // closeTab of the last one opened a fresh tab
    writeFileSync(join(ws, 'persist.txt'), 'before\r\n');
    keep.rename('Persist me');
    mgr.send(keep.id, fake({ fixture: 'edit-file', file: 'persist.txt', delay: 1, actions: [{ op: 'write', path: 'persist.txt', content: 'after\n' }] }), 'agent', undefined);
    await idle([keep]);
    assert(lastRun(keep).changes?.files.length === 1, 'persist run has no changes');

    const second = mgr.newTab(true);
    second.rename('Second tab');
    mgr.send(second.id, `${fake({ fixture: 'ask-simple', delay: 1 })} quick question`, 'ask', undefined);
    await idle([second]);

    const hanging = mgr.newTab(true);
    hanging.rename('Still running');
    mgr.send(hanging.id, `${fake({ fixture: 'ask-simple', delay: 200, hang: true })} long task`, 'ask', undefined);
    await waitFor(() => lastRun(hanging).events.length > 0, 10000, 'hanging run streaming');
    mgr.activate(second.id, true);
    // Let the urgent saves land; deactivate() flushes the rest on shutdown.
    await new Promise((r) => setTimeout(r, 800));
    const state = JSON.parse(
      readFileSync(join((api.history as unknown as { stateFile: string }).stateFile), 'utf8'),
    ) as { openTabs: string[]; activeTabId: string };
    assert(state.openTabs.length === 3 && state.activeTabId === second.id, `state: ${JSON.stringify(state)}`);
  });
}
