/**
 * Session Manager fixture harness (webview-ui/sessions-harness.html). Fakes the host:
 * rows in every status, groups, account states, budget bars. Not shipped.
 */
import type { AccountInfo, HostMessage, SessionGroup, SessionRow, UsageSummary, WebviewMessage } from '../../../src/shared/protocol';

const now = Date.now();
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

let groups: SessionGroup[] = [{ id: 'g1', name: 'Invoices', collapsed: false }];
let rows: SessionRow[] = [
  row('s1', 'Backfill invoice migration temp table removal', 21 * MIN, 'running', false, 'g1'),
  row('s2', 'Storno e-fiscalization for advance invoices', 3 * H, 'idle', true, 'g1'),
  row('s3', 'Production order phase not updated', 20 * H, 'queued', false),
  row('s4', 'EU offer to partner invoice tax_rate error', 23 * H, 'interrupted', false),
  row('s5', 'Offer-to-invoice "Not unique table/alias" error', 23 * H + 10 * MIN, 'error', false),
  row('s6', 'TableOffers total display mismatch with a really long title that has to truncate', 1 * D + H, 'idle', false),
  row('s7', 'OfferForm currency conversion doubling prices', 1 * D + 2 * H, 'idle', false),
  row('s8', 'Uncommitted changes in documentCurrency.ts', 9 * D, 'idle', false),
  row('s9', 'Old spike: shadow-git checkpoints', 45 * D, 'idle', false),
];
let activeId: string | undefined = 's2';

function row(id: string, title: string, ago: number, status: SessionRow['status'], unread: boolean, groupId?: string): SessionRow {
  return { id, title, createdAt: now - ago - H, updatedAt: now - ago, preview: `${title} — first message text for search`, messageCount: 3, status, unread, groupId };
}

const usage = (budget: number): UsageSummary => ({
  session: { input: 41_200, output: 6_900, cacheRead: 120_000, cacheWrite: 8_000, runs: 4 },
  today: { input: 182_000, output: 31_000, cacheRead: 640_000, cacheWrite: 22_000, runs: 17 },
  week: { input: 1_400_000, output: 210_000, cacheRead: 4_100_000, cacheWrite: 150_000, runs: 96 },
  dailyBudget: budget,
});

const accounts: Record<string, AccountInfo> = {
  ready: { backend: 'cli', state: 'ready', email: 'dev@example.com', tier: 'Pro', model: 'Auto', version: '2026.11.05-86047df', latest: 'up to date' },
  sdk: { backend: 'sdk', state: 'ready', model: 'auto', version: '1.0.4' },
  checking: { backend: 'cli', state: 'checking' },
  notLoggedIn: { backend: 'cli', state: 'notLoggedIn', message: 'Not logged in. Run `cursor-agent login`.' },
  notFound: { backend: 'cli', state: 'notFound', message: 'cursor-agent not found. Install it (https://cursor.com/cli) or set cursorAgent.cliPath.' },
  noApiKey: { backend: 'sdk', state: 'noApiKey', message: 'Set an API key for the SDK backend.' },
};
let account = accounts.ready!;
let budget = 0;

function post(msg: HostMessage) {
  window.postMessage(msg, '*');
}
const pushRows = () => post({ type: 'sessions/state', rows, groups, activeId });
const pushAccount = () => post({ type: 'account/state', account, usage: usage(budget) });

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage(msg: WebviewMessage) {
    console.log('[webview → host]', msg);
    (window as unknown as { __hostLog: WebviewMessage[] }).__hostLog.push(msg);
    switch (msg.type) {
      case 'ready':
        pushRows();
        pushAccount();
        break;
      case 'session/open':
        activeId = msg.id;
        rows = rows.map((r) => (r.id === msg.id ? { ...r, unread: false } : r));
        pushRows();
        break;
      case 'tab/new':
        post({ type: 'notice', level: 'info', text: '(harness) would open a new chat on the right' });
        break;
      case 'tab/rename':
        rows = rows.map((r) => (r.id === msg.tabId ? { ...r, title: msg.title } : r));
        pushRows();
        break;
      case 'session/delete':
        if (confirm('Delete this session?')) {
          rows = rows.filter((r) => r.id !== msg.id);
          pushRows();
        }
        break;
      case 'session/move':
        rows = rows.map((r) => (r.id === msg.id ? { ...r, groupId: msg.groupId } : r));
        pushRows();
        break;
      case 'group/create':
        groups = [...groups, { id: `g${groups.length + 1}_${Date.now()}`, name: msg.name, collapsed: false }];
        pushRows();
        break;
      case 'group/rename':
        groups = groups.map((g) => (g.id === msg.id ? { ...g, name: msg.name } : g));
        pushRows();
        break;
      case 'group/delete':
        groups = groups.filter((g) => g.id !== msg.id);
        rows = rows.map((r) => (r.groupId === msg.id ? { ...r, groupId: undefined } : r));
        pushRows();
        break;
      case 'group/toggle':
        groups = groups.map((g) => (g.id === msg.id ? { ...g, collapsed: msg.collapsed } : g));
        pushRows();
        break;
      case 'account/details':
      case 'auth/logout':
      case 'auth/login':
        post({ type: 'notice', level: 'info', text: `(harness) ${msg.type}` });
        break;
    }
  },
});
(window as unknown as { __hostLog: WebviewMessage[] }).__hostLog = [];

function renderPanel() {
  const panel = document.getElementById('panel')!;
  panel.innerHTML = '';
  const h = (t: string) => {
    const e = document.createElement('h3');
    e.textContent = t;
    panel.append(e);
  };
  const btn = (label: string, fn: () => void, active = false) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (active) b.className = 'active';
    b.onclick = () => {
      fn();
      renderPanel();
    };
    panel.append(b);
  };
  h('Account state');
  for (const [k, a] of Object.entries(accounts)) btn(k, () => ((account = a), pushAccount()), account === a);
  h('Daily token budget');
  for (const b of [0, 500_000, 1_000_000]) btn(b ? b.toLocaleString() : 'off (plain totals)', () => ((budget = b), pushAccount()), budget === b);
  h('Sessions');
  btn('Finish s1 in background (unread)', () => {
    rows = rows.map((r) => (r.id === 's1' ? { ...r, status: 'idle', unread: true, updatedAt: Date.now() } : r));
    pushRows();
  });
  btn('Start s7 running', () => {
    rows = rows.map((r) => (r.id === 's7' ? { ...r, status: 'running', updatedAt: Date.now() } : r));
    pushRows();
  });
  btn('Empty list', () => ((rows = []), (groups = []), pushRows()));
  btn('Focus search (Show Sessions)', () => post({ type: 'sessions/focusSearch' }));
  btn('Error notice', () => post({ type: 'notice', level: 'error', text: 'That chat could not be loaded.' }));
}

renderPanel();
await import('./main');
