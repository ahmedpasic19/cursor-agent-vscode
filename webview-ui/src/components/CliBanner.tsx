import type { CliStatus } from '../../../src/shared/protocol';
import { send } from '../vscode';

/** Top-of-panel banner for CLI problems: what's wrong and what to do (PLAN.md §5.9). */
export function CliBanner({ cli }: { cli: CliStatus }) {
  if (cli.state === 'ready') return null;
  if (cli.state === 'checking')
    return <div className="cli-checking muted">{cli.backend === 'sdk' ? 'Checking the SDK backend…' : 'Checking Cursor Agent CLI…'}</div>;

  if (cli.state === 'notFound') {
    return (
      <div className="error-banner top" role="alert">
        <div className="error-title">Cursor Agent CLI not found</div>
        <div className="error-message">
          Install the Cursor CLI (see <a href="https://cursor.com/cli">cursor.com/cli</a>), run{' '}
          <code>cursor-agent login</code> once, then click Retry. If it's installed somewhere unusual, set its path.
        </div>
        {cli.message && <div className="error-message muted">{cli.message}</div>}
        <div className="banner-actions">
          <button className="btn primary" onClick={() => send({ type: 'settings/open', query: 'cursorAgent.cliPath' })}>
            Set path
          </button>
          <button className="btn secondary" onClick={() => send({ type: 'cli/refresh' })}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (cli.state === 'sdkNotInstalled') {
    return (
      <div className="error-banner top" role="alert">
        <div className="error-title">SDK backend: @cursor/sdk not installed</div>
        <div className="error-message">
          The SDK backend runs @cursor/sdk in a separate Node process. Install it once (npm, into the extension's storage), or
          switch back to the CLI backend.
        </div>
        {cli.message && <div className="error-message muted">{cli.message}</div>}
        <div className="banner-actions">
          <button className="btn primary" onClick={() => send({ type: 'sdk/install' })}>
            Install SDK
          </button>
          <button className="btn secondary" onClick={() => send({ type: 'cli/refresh' })}>
            Retry
          </button>
          <button className="link" onClick={() => send({ type: 'backend/switch', backend: 'cli' })}>
            Use the CLI instead
          </button>
        </div>
      </div>
    );
  }

  if (cli.state === 'noApiKey') {
    return (
      <div className="error-banner top" role="alert">
        <div className="error-title">SDK backend: API key needed</div>
        <div className="error-message">
          The SDK authenticates with a Cursor API key and is billed by usage (the CLI uses your subscription login instead).
        </div>
        <div className="banner-actions">
          <button className="btn primary" onClick={() => send({ type: 'sdk/setKey' })}>
            Set API key
          </button>
          <button className="link" onClick={() => send({ type: 'backend/switch', backend: 'cli' })}>
            Use the CLI instead
          </button>
        </div>
      </div>
    );
  }

  if (cli.state === 'notLoggedIn') {
    return (
      <div className="error-banner top" role="alert">
        <div className="error-title">Not logged in to Cursor</div>
        <div className="error-message">Log in once in a terminal; the extension uses your Cursor subscription.</div>
        <div className="banner-actions">
          <button className="btn primary" onClick={() => send({ type: 'auth/login' })}>
            Log in
          </button>
          <button className="btn secondary" onClick={() => send({ type: 'cli/refresh' })}>
            I've logged in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="error-banner top" role="alert">
      <div className="error-title">{cli.backend === 'sdk' ? 'SDK backend problem' : 'Cursor Agent CLI problem'}</div>
      {cli.message && <div className="error-message">{cli.message}</div>}
      <div className="banner-actions">
        <button className="btn secondary" onClick={() => send({ type: 'cli/refresh' })}>
          Retry
        </button>
        <button className="link" onClick={() => send({ type: 'log/show' })}>
          Show log
        </button>
      </div>
    </div>
  );
}
