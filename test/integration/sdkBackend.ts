/** Phase 7 in a real VS Code: switching cursorAgent.backend to the SDK and running through it (fake SDK). */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { CursorAgentApi } from '../../src/extension';
import type { RunRecord } from '../../src/shared/protocol';
import { assert, test, waitFor } from './helpers';

export async function sdkBackendTests(api: CursorAgentApi): Promise<void> {
  console.log('SDK backend integration tests (fake @cursor/sdk)');
  const config = vscode.workspace.getConfiguration('cursorAgent');
  const mgr = api.manager;

  await test('switching to the SDK backend without an install reports "not installed"', async () => {
    await config.update('backend', 'sdk', vscode.ConfigurationTarget.Global);
    const st = await waitFor(() => (api.sdk.status.state !== 'checking' ? api.sdk.status : undefined), 15000, 'sdk status');
    assert(st.state === 'sdkNotInstalled', `state ${st.state}: ${st.message}`);
    // The CLI backend is no longer used for runs.
    const tab = mgr.newTab(true);
    mgr.send(tab.id, 'hello', 'ask', undefined);
    await waitFor(() => !tab.running && tab.transcript.length === 2, 10000, 'failed run');
    const run = tab.transcript[1] as RunRecord;
    assert(run.status === 'error' && /not installed/.test(run.outcome?.message ?? ''), `run: ${run.status} ${run.outcome?.message}`);
    mgr.closeTab(tab.id);
  });

  await test('with the SDK installed and a key, runs go through the SDK worker', async () => {
    // "Install" the fake SDK where the extension looks for it; key via CURSOR_API_KEY.
    const pkg = join(api.sdk.sdkDir, 'node_modules', '@cursor', 'sdk');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(api.sdk.sdkDir, 'package.json'), '{"name":"sdk-host","private":true}');
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@cursor/sdk', version: '1.3.1', main: 'index.js' }));
    copyFileSync(resolve(__dirname, '..', 'test', 'fake-sdk.cjs'), join(pkg, 'index.js'));
    process.env.CURSOR_API_KEY = 'integration-test-key';
    const st = await api.sdk.refresh();
    assert(st.state === 'ready', `state ${st.state}: ${st.message}`);

    const tab = mgr.newTab(true);
    mgr.send(tab.id, 'what is in README?', 'ask', undefined);
    await waitFor(() => !tab.running && tab.transcript.length === 2, 20000, 'sdk run');
    const run = tab.transcript[1] as RunRecord;
    assert(run.status === 'success', `status ${run.status}: ${run.outcome?.message}`);
    const text = run.events.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join('');
    assert(text.includes('fake SDK') && text.includes('tools=read|grep'), `text: ${text}`);
    assert(tab.sessionId?.startsWith('agent-'), `session ${tab.sessionId}`);

    // Follow-up resumes the same SDK agent.
    mgr.send(tab.id, 'and again', 'agent', undefined);
    await waitFor(() => !tab.running && tab.transcript.length === 4, 20000, 'sdk follow-up');
    assert((tab.transcript[3] as RunRecord).status === 'success', 'follow-up failed');
    mgr.closeTab(tab.id);
  });

  await test('switching back to the CLI backend', async () => {
    await config.update('backend', undefined, vscode.ConfigurationTarget.Global);
    delete process.env.CURSOR_API_KEY;
    const tab = mgr.newTab(true);
    process.env.FAKE_FIXTURE = 'ask-simple';
    mgr.send(tab.id, 'hello again', 'ask', undefined);
    await waitFor(() => !tab.running && tab.transcript.length === 2, 20000, 'cli run');
    const text = (tab.transcript[1] as RunRecord).events.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join('');
    assert(text.includes('exports a single function'), `cli text: ${text}`);
    mgr.closeTab(tab.id);
  });
}
