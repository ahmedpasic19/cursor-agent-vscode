/**
 * Fixture harness ("storybook"): runs the real webview in a browser and fakes the host by
 * replaying recorded CLI fixtures through the real parser (PLAN.md Phase 2 acceptance).
 *
 *   npx vite --config webview-ui/vite.config.ts   →  open /harness.html
 *   /harness.html?fixture=plan-mode&delay=10      →  deep link to one scenario
 *
 * Host behaviour it fakes: message/send replays the selected fixture, run/retry replays the
 * last one, plan/execute replays `switch-agent` in Agent mode, run/stop cancels the replay.
 */
import { CursorStreamParser } from '../../src/parser/cursorStreamJson';
import type { CliStatus, HostMessage, RunRecord, WebviewMessage } from '../../src/shared/protocol';

type Mode = RunRecord['mode'];

const raw = {
  ...(import.meta.glob('../../test/fixtures/*.ndjson', { query: '?raw', import: 'default', eager: true }) as Record<string, string>),
  ...(import.meta.glob('../../test/synthetic/*.ndjson', { query: '?raw', import: 'default', eager: true }) as Record<string, string>),
};
const stderrs = {
  ...(import.meta.glob('../../test/fixtures/*.stderr.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>),
  ...(import.meta.glob('../../test/synthetic/*.stderr.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>),
};
const metas = import.meta.glob('../../test/fixtures/*.meta.json', { import: 'default', eager: true }) as Record<
  string,
  { args: string[]; prompt: string; exitCode: number | null }
>;

interface Scenario {
  name: string;
  group: 'Recorded' | 'Synthetic';
  ndjson: string;
  stderr: string;
  mode: Mode;
  prompt: string;
  partial: boolean;
  exitCode: number | null;
  cwd: string;
}

const scenarios: Scenario[] = Object.entries(raw)
  .map(([path, ndjson]) => {
    const name = path.split('/').pop()!.replace(/\.ndjson$/, '');
    const group = path.includes('/synthetic/') ? 'Synthetic' : 'Recorded';
    const meta = metas[path.replace(/\.ndjson$/, '.meta.json')];
    const args = meta?.args ?? [];
    const modeIdx = args.indexOf('--mode');
    const mode: Mode = modeIdx >= 0 ? (args[modeIdx + 1] as Mode) : args.includes('--force') ? 'agent' : 'agent';
    const stderr = stderrs[path.replace(/\.ndjson$/, '.stderr.txt')] ?? '';
    return {
      name,
      group,
      ndjson,
      stderr,
      mode,
      prompt: meta?.prompt ?? `(${name})`,
      partial: meta ? args.includes('--stream-partial-output') : true,
      exitCode: meta ? meta.exitCode : ndjson.trim() ? 0 : 1,
      cwd: initCwd(ndjson),
    } satisfies Scenario;
  })
  .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

function initCwd(ndjson: string): string {
  try {
    const first = JSON.parse(ndjson.split('\n')[0] ?? '');
    if (typeof first.cwd === 'string') return first.cwd;
  } catch {
    /* not JSON */
  }
  return 'C:\\ws';
}

const params = new URLSearchParams(location.search);
let current = scenarios.find((s) => s.name === (params.get('fixture') ?? 'all-cards')) ?? scenarios[0]!;
let delay = Number(params.get('delay') ?? 20);
let cli: CliStatus = { state: 'ready', version: 'harness', features: { modes: true, partialOutput: true, worktree: true } };

const TAB = 'tab_harness';
let n = 0;
let cancel: (() => void) | undefined;
let running = false;
let tabMode: Mode = 'agent';

function post(msg: HostMessage) {
  window.postMessage(msg, '*');
}

function tabMeta() {
  return { id: TAB, title: current.prompt.slice(0, 30), mode: tabMode, cwd: current.cwd, running };
}

function reset() {
  cancel?.();
  running = false;
  post({ type: 'state/full', tabs: [{ ...tabMeta(), transcript: [] }], activeTabId: TAB, cli, settings: { defaultMode: 'agent' } });
}

function replay(sc: Scenario, text: string, mode: Mode) {
  cancel?.();
  const parser = new CursorStreamParser({ partialOutput: sc.partial });
  const events = sc.ndjson.split('\n').flatMap((l) => parser.parseLine(l));
  const runId = `run_${++n}`;
  tabMode = mode;
  running = true;
  post({
    type: 'run/started',
    tabId: TAB,
    user: { id: `msg_${n}`, role: 'user', text, mode, at: Date.now() },
    run: { id: runId, role: 'run', mode, status: 'running', events: [], startedAt: Date.now() },
  });
  post({ type: 'tab/updated', tab: tabMeta() });
  let i = 0;
  let stopped = false;
  const finish = (status: 'success' | 'error' | 'stopped') => {
    running = false;
    const lines = sc.stderr.split('\n').filter(Boolean);
    post({
      type: 'run/finished',
      tabId: TAB,
      runId,
      status,
      outcome: {
        status,
        exitCode: status === 'error' ? (sc.exitCode ?? 1) : status === 'stopped' ? null : 0,
        stderrTail: lines,
        message: status === 'error' ? (lines[0] ?? 'cursor-agent exited before sending a result') : undefined,
      },
    });
    post({ type: 'tab/updated', tab: tabMeta() });
  };
  const tick = () => {
    if (stopped) return;
    if (i >= events.length) return finish(events.some((e) => e.kind === 'result') ? 'success' : 'error');
    post({ type: 'run/event', tabId: TAB, runId, event: events[i++]! });
    if (delay <= 0) tick();
    else setTimeout(tick, delay);
  };
  cancel = () => {
    if (stopped || !running) return;
    stopped = true;
    finish('stopped');
  };
  setTimeout(tick, Math.max(delay, 0));
}

// ---------- fake VS Code API ----------

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage(msg: WebviewMessage) {
    console.log('[webview → host]', msg);
    (window as unknown as { __hostLog: WebviewMessage[] }).__hostLog.push(msg);
    switch (msg.type) {
      case 'ready':
        reset();
        replay(current, current.prompt, current.mode);
        break;
      case 'tab/new':
        reset();
        break;
      case 'message/send':
        replay(current, msg.text, msg.mode);
        break;
      case 'run/retry':
        replay(current, current.prompt, current.mode);
        break;
      case 'plan/execute': {
        const sw = scenarios.find((s) => s.name === 'switch-agent')!;
        replay(sw, 'Implement the plan above.', 'agent');
        break;
      }
      case 'run/stop':
        cancel?.();
        break;
      case 'cli/refresh':
        cli = { ...cli, state: 'ready' };
        post({ type: 'cli/status', cli });
        break;
    }
  },
});
(window as unknown as { __hostLog: WebviewMessage[] }).__hostLog = [];

// ---------- control panel ----------

function renderPanel() {
  const panel = document.getElementById('panel')!;
  panel.innerHTML = '';
  for (const group of ['Recorded', 'Synthetic'] as const) {
    const h = document.createElement('h3');
    h.textContent = `${group} fixtures`;
    panel.append(h);
    for (const sc of scenarios.filter((s) => s.group === group)) {
      const b = document.createElement('button');
      b.textContent = `${sc.name}  ·  ${sc.mode}`;
      b.dataset.fixture = sc.name;
      if (sc === current) b.className = 'active';
      b.onclick = () => {
        current = sc;
        tabMode = sc.mode;
        history.replaceState(null, '', `?fixture=${sc.name}&delay=${delay}`);
        renderPanel();
        reset();
        replay(sc, sc.prompt, sc.mode);
      };
      panel.append(b);
    }
  }
  const h = document.createElement('h3');
  h.textContent = 'CLI state';
  panel.append(h);
  for (const state of ['ready', 'checking', 'notFound', 'notLoggedIn', 'error'] as const) {
    const b = document.createElement('button');
    b.textContent = state;
    if (cli.state === state) b.className = 'active';
    b.onclick = () => {
      cli = {
        ...cli,
        state,
        message: state === 'error' ? 'Could not run cursor-agent --version' : state === 'notFound' ? undefined : cli.message,
      };
      post({ type: 'cli/status', cli });
      renderPanel();
    };
    panel.append(b);
  }
  const lbl = document.createElement('label');
  lbl.innerHTML = `Delay per event (ms): <input id="delay" type="number" value="${delay}" style="width:60px">`;
  panel.append(lbl);
  (lbl.querySelector('input') as HTMLInputElement).onchange = (e) => {
    delay = Number((e.target as HTMLInputElement).value);
  };
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent =
    'Clicking a fixture replays it. Sending a message replays the selected fixture again. "Run this plan" replays switch-agent.';
  panel.append(hint);
}

renderPanel();
await import('./main');
