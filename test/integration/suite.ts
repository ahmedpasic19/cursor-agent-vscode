/**
 * Runs inside a real VS Code (see runTest.mjs). Drives the Add to Chat commands and checks
 * the prompt the (fake) CLI receives on stdin — PLAN.md Phase 3 acceptance.
 */
import { readFileSync, existsSync } from 'node:fs';
import * as vscode from 'vscode';
import type { CursorAgentApi } from '../../src/extension';
import type { ContextChip } from '../../src/shared/protocol';

import { checkpointTests } from './checkpoints';
import { assert, results, sleep, test, waitFor } from './helpers';

function label(c: ContextChip): string {
  if (c.kind === 'selection') return `${c.path}:${c.startLine}-${c.endLine}`;
  if (c.kind === 'file') return `${c.isFolder ? 'folder' : 'file'}:${c.path}`;
  if (c.kind === 'terminal') return `terminal`;
  return `diagnostics:${c.path ?? '*'}`;
}

async function select(rel: string, startLine: number, endLine: number) {
  const root = vscode.workspace.workspaceFolders![0]!.uri;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, rel));
  const editor = await vscode.window.showTextDocument(doc);
  // 1-based inclusive lines, full-line selection.
  editor.selection = new vscode.Selection(startLine - 1, 0, endLine - 1, doc.lineAt(endLine - 1).text.length);
  return editor;
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<CursorAgentApi>('local.cursor-agent-vscode');
  assert(ext, 'extension not found');
  const api = await ext.activate();
  await api.cliReady();
  const mgr = api.manager;
  const tab = mgr.ensureTab();
  const labels = () => tab.chips.map(label);

  console.log('Add to Chat integration tests');

  await test('Ctrl+L command adds a selection chip with a snapshot (CRLF normalized)', async () => {
    await select('src/api.ts', 10, 24);
    await vscode.commands.executeCommand('cursorAgent.addSelectionToChat');
    assert(labels().join() === 'src/api.ts:10-24', `chips: ${labels()}`);
    const c = tab.chips[0] as Extract<ContextChip, { kind: 'selection' }>;
    assert(c.text?.startsWith('export const line10 = 10;'), `text: ${c.text?.slice(0, 40)}`);
    assert(!c.text!.includes('\r'), 'snapshot still has CR');
    assert(c.text!.split('\n').length === 15, `lines: ${c.text!.split('\n').length}`);
    assert(c.language === 'typescript', `language ${c.language}`);
  });

  await test('overlapping range merges; identical range is not added twice', async () => {
    await select('src/api.ts', 20, 30);
    await vscode.commands.executeCommand('cursorAgent.addSelectionToChat');
    assert(labels().join() === 'src/api.ts:10-30', `after overlap: ${labels()}`);
    await vscode.commands.executeCommand('cursorAgent.addSelectionToChat');
    assert(labels().join() === 'src/api.ts:10-30', `after duplicate: ${labels()}`);
  });

  await test('three chips from two files', async () => {
    await select('src/api.ts', 35, 38);
    await vscode.commands.executeCommand('cursorAgent.addSelectionToChat');
    await select('src/app.ts', 1, 3);
    await vscode.commands.executeCommand('cursorAgent.addSelectionToChat');
    assert(labels().join() === 'src/api.ts:10-30,src/api.ts:35-38,src/app.ts:1-3', `chips: ${labels()}`);
  });

  await test('editing the file marks the selection chip "changed" (snapshot kept)', async () => {
    const root = vscode.workspace.workspaceFolders![0]!.uri;
    const uri = vscode.Uri.joinPath(root, 'src/api.ts');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(35, 0, 35, 999), 'export const line36 = "EDITED";');
    await vscode.workspace.applyEdit(edit);
    const c = await waitFor(
      () => tab.chips.find((x) => x.kind === 'selection' && x.startLine === 35 && x.changed),
      3000,
      'changed flag',
    );
    assert(c.kind === 'selection' && c.text?.includes('line36 = 36') && !c.text.includes('EDITED'), 'snapshot replaced');
  });

  await test('terminal chip from the active terminal (no selection → last output / buffer)', async () => {
    const term = vscode.window.createTerminal({ name: 'it-term' });
    term.show();
    await sleep(2500); // shell start-up
    term.sendText('echo hello-terminal-chip');
    let chip: ContextChip | undefined;
    const t0 = Date.now();
    while (!chip && Date.now() - t0 < 20000) {
      await sleep(1500);
      term.show();
      await vscode.commands.executeCommand('cursorAgent.addTerminalSelectionToChat');
      chip = tab.chips.find((c) => c.kind === 'terminal' && c.text.includes('hello-terminal-chip'));
      if (!chip) {
        // Remove partial captures (e.g. before the echo ran) and retry.
        for (const c of tab.chips.filter((c) => c.kind === 'terminal')) tab.removeChip(c.id);
      }
    }
    assert(chip, `no terminal chip with the echo; chips: ${labels()}`);
  });

  let recordPath = process.env.FAKE_RECORD!;
  await test('sending consumes the chips and the CLI receives the serialized context on stdin', async () => {
    const ids = tab.chips.map((c) => c.id);
    assert(ids.length === 4, `expected 4 chips, have ${labels()}`);
    mgr.send(tab.id, 'Explain how these fit together.', 'ask', undefined, ids);
    assert(tab.chips.length === 0, 'chips not consumed');
    await waitFor(() => !tab.running && tab.transcript.length === 2, 20000, 'run to finish');
    const run = tab.transcript[1];
    assert(run?.role === 'run' && run.status === 'success', `run status ${run?.role === 'run' ? run.status : '?'}`);
    const user = tab.transcript[0];
    assert(user?.role === 'user' && user.chips?.length === 4, 'user message lacks chip snapshot');
    assert(existsSync(recordPath), 'fake CLI did not record stdin');
    const { stdin, args } = JSON.parse(readFileSync(recordPath, 'utf8')) as { stdin: string; args: string[] };
    console.log('----- prompt received on stdin -----\n' + stdin + '\n------------------------------------');
    assert(!args.some((a) => a.includes('Explain how')), 'prompt leaked into argv');
    const sels = [...stdin.matchAll(/<selection path="([^"]+)" lines="([^"]+)" language="typescript">/g)].map((m) => `${m[1]}:${m[2]}`);
    assert(sels.join() === 'src/api.ts:10-30,src/api.ts:35-38,src/app.ts:1-3', `selections in prompt: ${sels}`);
    assert(/<terminal_output name="[^"]*">\n[\s\S]*hello-terminal-chip[\s\S]*\n<\/terminal_output>/.test(stdin), 'terminal block missing');
    assert(stdin.includes('export const line36 = 36;') && !stdin.includes('EDITED'), 'changed chip did not send its snapshot');
    assert(stdin.trimEnd().endsWith('<user_message>\nExplain how these fit together.\n</user_message>'), 'user message block missing');
    assert(!stdin.includes('\r'), 'CR in prompt');
  });

  await test('file, folder and explorer multi-select chips', async () => {
    const root = vscode.workspace.workspaceFolders![0]!.uri;
    const a = vscode.Uri.joinPath(root, 'src/app.ts');
    const folder = vscode.Uri.joinPath(root, 'src');
    await vscode.commands.executeCommand('cursorAgent.addFileToChat', a, [a, folder]);
    await vscode.commands.executeCommand('cursorAgent.addFileToChat', a); // duplicate
    assert(labels().join() === 'file:src/app.ts,folder:src', `chips: ${labels()}`);
  });

  await test('problems chip for a file', async () => {
    const root = vscode.workspace.workspaceFolders![0]!.uri;
    const uri = vscode.Uri.joinPath(root, 'src/app.ts');
    const coll = vscode.languages.createDiagnosticCollection('it');
    const d = new vscode.Diagnostic(new vscode.Range(1, 0, 1, 5), "Property 'x' does not exist", vscode.DiagnosticSeverity.Error);
    d.source = 'ts';
    d.code = 2339;
    coll.set(uri, [d]);
    await vscode.commands.executeCommand('cursorAgent.addProblemsToChat', uri);
    const chip = tab.chips.find((c) => c.kind === 'diagnostics');
    assert(chip?.kind === 'diagnostics' && chip.items[0]?.line === "L2: error ts2339: Property 'x' does not exist", `diag: ${JSON.stringify(chip)}`);
    coll.dispose();
  });

  await test('over-limit selection becomes a range-only chip with a warning', async () => {
    await vscode.workspace.getConfiguration('cursorAgent').update('context.maxChipLines', 5, vscode.ConfigurationTarget.Global);
    try {
      await select('src/api.ts', 1, 9);
      await vscode.commands.executeCommand('cursorAgent.addSelectionToChat');
      const c = tab.chips.find((x) => x.kind === 'selection' && x.startLine === 1);
      assert(c?.kind === 'selection' && c.text === undefined && c.endLine === 9, `chip: ${JSON.stringify(c)}`);
    } finally {
      await vscode.workspace.getConfiguration('cursorAgent').update('context.maxChipLines', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  await checkpointTests(api, `${process.env.FAKE_RECORD}.actions.json`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) throw new Error(failed.map((f) => `${f.name}: ${f.error}`).join('\n\n'));
  recordPath = '';
}
