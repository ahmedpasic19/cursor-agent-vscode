/**
 * Dev harness: runs the real webview in a browser and fakes the host by replaying
 * recorded CLI fixtures through the real parser.
 *
 *   npx vite --config webview-ui/vite.config.ts   →  open /harness.html?fixture=plan-mode
 *
 * Every message you send replays the selected fixture (default: ask-simple).
 */
import { CursorStreamParser } from '../../src/parser/cursorStreamJson';
import type { HostMessage, RunRecord, WebviewMessage } from '../../src/shared/protocol';

const fixtures = import.meta.glob('../../test/fixtures/*.ndjson', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;
const stderrs = import.meta.glob('../../test/fixtures/*.stderr.txt', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

const params = new URLSearchParams(location.search);
const fixtureName = params.get('fixture') ?? 'ask-simple';
const delay = Number(params.get('delay') ?? 25);
const TAB = 'tab_harness';
let n = 0;
let cancel: (() => void) | undefined;

function post(msg: HostMessage) {
  window.postMessage(msg, '*');
}

function replay(text: string, mode: RunRecord['mode']) {
  const raw = fixtures[`../../test/fixtures/${fixtureName}.ndjson`] ?? '';
  const stderr = stderrs[`../../test/fixtures/${fixtureName}.stderr.txt`] ?? '';
  const parser = new CursorStreamParser({ partialOutput: !fixtureName.includes('no-partial') });
  const events = raw.split('\n').flatMap((l) => parser.parseLine(l));
  const runId = `run_${++n}`;
  post({
    type: 'run/started',
    tabId: TAB,
    user: { id: `msg_${n}`, role: 'user', text, mode, at: Date.now() },
    run: { id: runId, role: 'run', mode, status: 'running', events: [], startedAt: Date.now() },
  });
  post({ type: 'tab/updated', tab: { id: TAB, title: `Harness: ${fixtureName}`, mode, running: true } });
  let i = 0;
  let stopped = false;
  const finish = (status: 'success' | 'error' | 'stopped') => {
    const lines = stderr.split('\n').filter(Boolean);
    post({
      type: 'run/finished',
      tabId: TAB,
      runId,
      status,
      outcome: { status, exitCode: status === 'error' ? 1 : 0, stderrTail: lines, message: status === 'error' ? lines[0] : undefined },
    });
    post({ type: 'tab/updated', tab: { id: TAB, title: `Harness: ${fixtureName}`, mode, running: false } });
  };
  const tick = () => {
    if (stopped) return;
    if (i >= events.length) return finish(events.some((e) => e.kind === 'result') ? 'success' : 'error');
    post({ type: 'run/event', tabId: TAB, runId, event: events[i++]! });
    setTimeout(tick, delay);
  };
  cancel = () => {
    stopped = true;
    finish('stopped');
  };
  setTimeout(tick, delay);
}

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage(msg: WebviewMessage) {
    console.log('[webview → host]', msg);
    if (msg.type === 'ready' || msg.type === 'tab/new') {
      post({
        type: 'state/full',
        tabs: [{ id: TAB, title: `Harness: ${fixtureName}`, mode: 'agent', running: false, transcript: [] }],
        activeTabId: TAB,
        cli: { state: 'ready', version: 'harness' },
        settings: { defaultMode: 'agent' },
      });
    } else if (msg.type === 'message/send') {
      replay(msg.text, msg.mode);
    } else if (msg.type === 'run/stop') {
      cancel?.();
    }
  },
});

await import('./main');
