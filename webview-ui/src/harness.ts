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
import { addChip, chipId } from '../../src/context/chips';
import { fuzzyFilter, withFolders } from '../../src/context/fuzzy';
import { CursorStreamParser } from '../../src/parser/cursorStreamJson';
import type { ActiveEditor, ChangedFile, CliStatus, ContextChip, HostMessage, RunChanges, RunRecord, SessionRow, WebviewMessage } from '../../src/shared/protocol';
import { buildPrompt } from '../../src/session/promptBuilder';

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
let chips: ContextChip[] = [];
let tabModel: string | undefined;
let lastPrompt = '';
/** Fake Changes-card state per run (Agent replays). */
const runChanges = new Map<string, RunChanges>();
const runOrder: { userId: string; runId: string }[] = [];

function postChanges(runId: string) {
  const c = runChanges.get(runId);
  if (c) post({ type: 'changes/updated', tabId: TAB, runId, changes: c });
}

function setFileState(runId: string, paths: string[] | 'all', state: ChangedFile['state']) {
  const c = runChanges.get(runId);
  if (!c) return;
  c.files = c.files.map((f) => (paths === 'all' || paths.includes(f.path) ? { ...f, state } : f));
  postChanges(runId);
}

// Two workspace folders, like a multi-root workspace.
const FAKE_FILES = [
  ...withFolders(
    ['src/math.ts', 'src/app.ts', 'src/booking/api.ts', 'src/booking/types.ts', 'src/components/Button.tsx', 'test/math.test.ts', 'README.md', 'package.json'],
    { root: 'C:/ws/web', folder: 'web' },
  ),
  ...withFolders(['src/math.ts', 'src/server.ts', 'README.md'], { root: 'C:/ws/api', folder: 'api' }),
];
const MODELS = [
  { id: 'auto', label: 'Auto', isDefault: true },
  { id: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
  { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 1M High' },
  { id: 'gpt-5.6-sol-high', label: 'GPT-5.6 Sol 1M High' },
];
const MATH_LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of math.ts`);
/** Pretend the user is looking at these lines in the editor (the "looking at" pills). */
const ACTIVE_EDITOR: ActiveEditor = {
  path: 'src/math.ts',
  absPath: 'C:/ws/web/src/math.ts',
  languageId: 'typescript',
  startLine: 12,
  endLine: 14,
  selections: 1,
  selectedLines: 3,
};

function setChips(next: ContextChip[]) {
  chips = next;
  post({ type: 'chips/updated', tabId: TAB, chips });
}

function addFake(chip: ContextChip) {
  const r = addChip(chips, chip, 2000);
  setChips(r.chips);
  post({ type: 'composer/focus' });
  return r.action;
}

function selection(path: string, a: number, b: number): ContextChip {
  return {
    id: chipId(),
    kind: 'selection',
    path,
    absPath: `C:/ws/${path}`,
    startLine: a,
    endLine: b,
    language: 'typescript',
    text: MATH_LINES.slice(a - 1, b).join('\n'),
  };
}

function post(msg: HostMessage) {
  window.postMessage(msg, '*');
}

function tabMeta() {
  return { id: TAB, title: current.prompt.slice(0, 30), mode: tabMode, model: tabModel, cwd: current.cwd, running };
}

function reset() {
  cancel?.();
  running = false;
  runChanges.clear();
  runOrder.length = 0;
  post({ type: 'state/full', tabs: [{ ...tabMeta(), chips, transcript: [] }], activeTabId: TAB, cli, settings: { defaultMode: 'agent' } });
  post({ type: 'models/list', models: MODELS, source: 'cli' });
  post({ type: 'editor/active', active: ACTIVE_EDITOR });
}

function replay(sc: Scenario, text: string, mode: Mode, attached: ContextChip[] = []) {
  cancel?.();
  const parser = new CursorStreamParser({ partialOutput: sc.partial });
  const events = sc.ndjson.split('\n').flatMap((l) => parser.parseLine(l));
  const runId = `run_${++n}`;
  tabMode = mode;
  running = true;
  post({
    type: 'run/started',
    tabId: TAB,
    user: { id: `msg_${n}`, role: 'user', text, mode, at: Date.now(), chips: attached.length ? attached : undefined },
    run: { id: runId, role: 'run', mode, status: 'running', events: [], startedAt: Date.now() },
  });
  post({ type: 'tab/updated', tab: tabMeta() });
  runOrder.push({ userId: `msg_${n}`, runId });
  if (mode === 'agent') {
    runChanges.set(runId, { status: 'pending', preSha: 'pre', files: [] });
    postChanges(runId);
  }
  let i = 0;
  let stopped = false;
  const finish = (status: 'success' | 'error' | 'stopped') => {
    running = false;
    if (mode === 'agent') {
      // Files from the fixture's edit/shell tool calls, plus a file "created by a shell command".
      const files: ChangedFile[] = [];
      for (const e of events) {
        if (e.kind !== 'toolCompleted' || !e.tool.result) continue;
        const r = e.tool.result as { path?: string; linesAdded?: number; linesRemoved?: number; beforeFullFileContent?: string };
        if (e.tool.uiKind === 'edit' && r.path) {
          const path = r.path.replace(/\\/g, '/').split('/').pop()!;
          files.push({ path: `src/${path}`, status: r.beforeFullFileContent === undefined ? 'A' : 'M', added: r.linesAdded ?? 0, removed: r.linesRemoved ?? 0, binary: false, state: 'pending' });
        }
        if (e.tool.uiKind === 'shell') files.push({ path: 'out.txt', status: 'A', added: 1, removed: 0, binary: false, state: 'pending' });
      }
      if (sc.name === 'all-cards') files.push({ path: 'old.txt', status: 'D', added: 0, removed: 3, binary: false, state: 'pending' }, { path: 'assets/logo.png', status: 'M', added: 0, removed: 0, binary: true, state: 'pending' });
      runChanges.set(runId, { status: 'ready', preSha: 'pre', postSha: 'post', files });
      postChanges(runId);
    }
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
      case 'ready': {
        reset();
        replay(current, current.prompt, current.mode);
        const now = Date.now();
        const row = (id: string, title: string, ago: number, extra: Partial<SessionRow> = {}): SessionRow => ({
          id,
          title,
          createdAt: now - ago,
          updatedAt: now - ago,
          preview: `${title} …`,
          messageCount: 4,
          status: 'idle',
          unread: false,
          ...extra,
        });
        post({
          type: 'sessions/state',
          groups: [],
          activeId: TAB,
          rows: [
            row(TAB, 'Harness session', 0),
            row('s1', 'Backfill migration for invoices', 21 * 60_000, { status: 'running' }),
            row('s2', 'Storno e-fiscal flow', 3 * 3_600_000, { unread: true }),
            row('s3', 'Fix TableOffers total', 26 * 3_600_000),
            row('s4', 'Refactor auth middleware', 4 * 86_400_000),
            row('s5', 'Investigate flaky checkpoint test', 40 * 86_400_000),
          ],
        });
        break;
      }
      case 'session/open':
        post({ type: 'notice', level: 'info', text: `(harness) would open session ${msg.id}` });
        break;
      case 'context/add':
        // The "looking at" pills: adding behaves like the real Ctrl+I / Add file commands.
        if (msg.what === 'selection') addFake(selection(ACTIVE_EDITOR.path, ACTIVE_EDITOR.startLine!, ACTIVE_EDITOR.endLine!));
        else if (msg.what === 'activeFile')
          addFake({ id: chipId(), kind: 'file', path: ACTIVE_EDITOR.path, absPath: ACTIVE_EDITOR.absPath, isFolder: false });
        else post({ type: 'notice', level: 'info', text: `(harness) would add ${msg.what} to the chat` });
        break;
      case 'tab/new': {
        const id = `tab_extra_${++n}`;
        post({ type: 'tab/created', tab: { id, title: 'New chat', mode: 'agent', cwd: current.cwd, running: false, chips: [], transcript: [] } });
        post({ type: 'tab/activated', tabId: id });
        break;
      }
      case 'tab/rename':
        if (msg.tabId === TAB) post({ type: 'tab/updated', tab: { ...tabMeta(), title: msg.title } });
        else post({ type: 'notice', level: 'info', text: `(harness) renamed to ${msg.title}` });
        break;
      case 'sessions/show':
        post({ type: 'notice', level: 'info', text: '(harness) would reveal the Session Manager — open sessions-harness.html' });
        break;
      case 'message/send': {
        const attached = chips.filter((c) => msg.chipIds.includes(c.id));
        lastPrompt = buildPrompt({ text: msg.text, mode: msg.mode, chips: attached });
        (window as unknown as { __lastPrompt: string }).__lastPrompt = lastPrompt;
        const pre = document.getElementById('last-prompt');
        if (pre) pre.textContent = lastPrompt;
        setChips(chips.filter((c) => !msg.chipIds.includes(c.id)));
        replay(current, msg.text, msg.mode, attached);
        break;
      }
      case 'chip/remove':
        setChips(chips.filter((c) => c.id !== msg.chipId));
        break;
      case 'mention/search':
        setTimeout(
          () => post({ type: 'mention/results', requestId: msg.requestId, items: fuzzyFilter(msg.query, FAKE_FILES, 50) }),
          30,
        );
        break;
      case 'mention/pick':
        addFake({ id: chipId(), kind: 'file', path: msg.path, absPath: `${msg.root ?? 'C:/ws'}/${msg.path}`, isFolder: msg.isFolder });
        break;
      case 'image/add':
        addFake({ id: chipId(), kind: 'image', name: msg.name, absPath: `C:/storage/attachments/${msg.name}`, mime: msg.mime, bytes: Math.round((msg.data.length * 3) / 4), thumb: msg.thumb });
        break;
      case 'changes/revertFile':
        setFileState(msg.runId, [msg.path], 'reverted');
        break;
      case 'changes/keepFile':
        setFileState(msg.runId, [msg.path], 'kept');
        break;
      case 'changes/revertAll':
        if (confirm('Revert all changes from this run?')) setFileState(msg.runId, 'all', 'reverted');
        break;
      case 'changes/keepAll':
        setFileState(msg.runId, (runChanges.get(msg.runId)?.files ?? []).filter((f) => f.state === 'pending').map((f) => f.path), 'kept');
        break;
      case 'checkpoint/restore': {
        const i = runOrder.findIndex((r) => r.userId === msg.userMessageId);
        if (i >= 0 && confirm('Restore code to before this message?')) for (const r of runOrder.slice(i)) setFileState(r.runId, 'all', 'reverted');
        break;
      }
      case 'changes/openDiff':
        post({ type: 'notice', level: 'info', text: `(harness) would open diff for ${msg.path}` });
        break;
      case 'tab/setModel':
        tabModel = msg.model;
        post({ type: 'tab/updated', tab: tabMeta() });
        break;
      case 'tab/clear':
        cancel?.();
        post({ type: 'tab/reset', tab: { ...tabMeta(), title: 'New chat', chips, transcript: [] } });
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
  for (const state of ['ready', 'checking', 'notFound', 'notLoggedIn', 'error', 'sdkNotInstalled', 'noApiKey'] as const) {
    const b = document.createElement('button');
    b.textContent = state;
    if (cli.state === state) b.className = 'active';
    b.onclick = () => {
      cli = {
        ...cli,
        state,
        backend: state === 'sdkNotInstalled' || state === 'noApiKey' ? 'sdk' : 'cli',
        message: state === 'error' ? 'Could not run cursor-agent --version' : state === 'notFound' ? undefined : cli.message,
      };
      post({ type: 'cli/status', cli });
      renderPanel();
    };
    panel.append(b);
  }
  const h2 = document.createElement('h3');
  h2.textContent = 'Add to Chat (simulated)';
  panel.append(h2);
  const actions: [string, () => void][] = [
    ['Selection math.ts:10-24', () => addFake(selection('src/math.ts', 10, 24))],
    ['Selection math.ts:20-30 (overlaps)', () => addFake(selection('src/math.ts', 20, 30))],
    ['Selection app.ts:3-5', () => addFake(selection('src/app.ts', 3, 5))],
    ['File booking/types.ts', () => addFake({ id: chipId(), kind: 'file', path: 'src/booking/types.ts', absPath: 'C:/ws/src/booking/types.ts', isFolder: false })],
    ['Terminal output', () => addFake({ id: chipId(), kind: 'terminal', name: 'pwsh', text: '$ npm test\nFAIL src/math.test.ts\n  ✕ adds numbers', lineCount: 3 })],
    ['Problems in app.ts', () => addFake({ id: chipId(), kind: 'diagnostics', path: 'src/app.ts', items: [{ path: 'src/app.ts', line: "L12: error ts2339: Property 'x' does not exist on type 'Y'." }] })],
    ['Selection over limit', () => {
      const { text: _omit, ...big } = selection('src/big.ts', 1, 5000) as Extract<ContextChip, { kind: 'selection' }>;
      addFake(big);
    }],
    ['Notice', () => post({ type: 'notice', level: 'warning', text: 'Selection has 5000 lines (limit 2000); attached as a path and line range only.' })],
  ];
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    panel.append(b);
  }
  const tabsBtn = document.createElement('button');
  tabsBtn.textContent = 'Add 2 background sessions (1 running)';
  tabsBtn.onclick = () => {
    const mk = (id: string, title: string, running: boolean) =>
      post({ type: 'tab/created', tab: { id, title, mode: 'agent', cwd: current.cwd, running, chips: [], transcript: [] } });
    mk('tab_bg1', 'Refactor auth middleware', true);
    mk('tab_bg2', 'Why is CI slow?', false);
    // Activity in a background tab marks it unread.
    post({ type: 'run/started', tabId: 'tab_bg2', user: { id: 'bgm', role: 'user', text: 'Why is CI slow?', mode: 'ask', at: Date.now() }, run: { id: 'bgr', role: 'run', mode: 'ask', status: 'running', events: [], startedAt: Date.now() } });
    post({ type: 'run/event', tabId: 'tab_bg2', runId: 'bgr', event: { kind: 'text', text: 'Mostly the e2e job.' } });
    post({ type: 'run/finished', tabId: 'tab_bg2', runId: 'bgr', status: 'success', outcome: { status: 'success', exitCode: 0, stderrTail: [] } });
    post({ type: 'run/warnings', tabId: TAB, runId: `run_${n}`, warnings: ['Another tab (“Refactor auth middleware”) is also editing this workspace. Its edits can show up in this run\'s changes; files it edited are marked and skipped by Revert all. Consider worktree mode for parallel edits.'] });
  };
  panel.append(tabsBtn);

  const h3 = document.createElement('h3');
  h3.textContent = 'Last prompt sent (stdin)';
  panel.append(h3);
  const pre = document.createElement('pre');
  pre.id = 'last-prompt';
  pre.style.cssText = 'white-space:pre-wrap;font-size:10px;max-height:240px;overflow:auto;background:#1b1b1b;padding:4px;margin:0';
  pre.textContent = lastPrompt || '(send a message)';
  panel.append(pre);

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
