import type { AccountInfo, ConnectionInfo, ConnectionSetup } from '../../../src/shared/protocol';
import { send } from '../vscode';

const SETUPS: Array<{ id: ConnectionSetup; title: string; detail: string }> = [
  {
    id: 'cliLogin',
    title: 'CLI · Cursor login',
    detail: 'Uses your Cursor subscription through the CLI’s own login. Recommended.',
  },
  {
    id: 'cliKey',
    title: 'CLI · API key',
    detail: 'Same CLI, signed in with an API key (CURSOR_API_KEY). Handy when you can’t use the browser login.',
  },
  {
    id: 'sdk',
    title: 'SDK · API key',
    detail: 'Runs @cursor/sdk instead of the CLI. Billed by usage; needs Node 22.13+ and a one-time install.',
  },
];

const KEYS_URL = 'https://cursor.com/dashboard?tab=integrations';

/** Settings: how the extension connects to Cursor, plus the shared API key. */
export function SettingsBody({ connection, account }: { connection?: ConnectionInfo; account?: AccountInfo }) {
  if (!connection) return <div className="pad muted">Loading…</div>;
  const needsKey = connection.setup !== 'cliLogin';
  const state = account?.state;
  const status =
    state === 'ready'
      ? { cls: 'ok', text: 'Connected' }
      : state === 'checking' || !state
        ? { cls: 'muted', text: 'Checking…' }
        : { cls: 'err', text: account?.message ?? 'Not connected' };

  return (
    <div className="settings">
      <div className="subhead">Connection</div>
      <div className="setup-list" role="radiogroup" aria-label="Connection">
        {SETUPS.map((s) => (
          <label key={s.id} className={`setup${connection.setup === s.id ? ' active' : ''}`}>
            <input
              type="radio"
              name="setup"
              checked={connection.setup === s.id}
              onChange={() => send({ type: 'connection/setup', setup: s.id })}
            />
            <span className="setup-text">
              <span className="setup-title">{s.title}</span>
              <span className="setup-detail">{s.detail}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="subhead">API key</div>
      <div className="kvs">
        <div className="kv">
          <span className="kv-key">Key</span>
          <span className="kv-val">
            {connection.hasKey ? `••••${connection.keyHint ?? ''}${connection.keyFromEnv ? ' (CURSOR_API_KEY)' : ''}` : 'Not set'}
          </span>
        </div>
      </div>
      <div className="btn-row tight">
        <button className={`btn${needsKey && !connection.hasKey ? ' primary' : ''}`} onClick={() => send({ type: 'sdk/setKey' })}>
          {connection.hasKey && !connection.keyFromEnv ? 'Replace key' : 'Set key'}
        </button>
        {connection.hasKey && !connection.keyFromEnv && (
          <button className="btn" onClick={() => send({ type: 'apiKey/clear' })}>
            Remove
          </button>
        )}
        <button className="link small" onClick={() => send({ type: 'link/open', url: KEYS_URL })}>
          Get a key
        </button>
      </div>
      <div className="setting-note muted">
        {needsKey
          ? 'Stored in VS Code Secret Storage, never in settings files.'
          : 'Only needed for the API-key setups. Stored in VS Code Secret Storage.'}
      </div>

      <div className="subhead">Status</div>
      <div className="btn-row tight">
        <span className={`status-dot ${status.cls}`} aria-hidden />
        <span className="status-text" title={status.text}>
          {status.text}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => send({ type: 'cli/refresh' })}>
          Test
        </button>
      </div>
      {connection.setup === 'sdk' && state === 'sdkNotInstalled' && (
        <div className="btn-row tight">
          <button className="btn primary" onClick={() => send({ type: 'sdk/install' })}>
            Install SDK
          </button>
        </div>
      )}
      <div className="btn-row tight">
        <button className="link small" onClick={() => send({ type: 'settings/open' })}>
          All settings…
        </button>
      </div>
    </div>
  );
}
