import type { RunOutcome } from '../../../src/shared/events';
import { send } from '../vscode';

const AUTH_RE = /not (logged|signed) in|unauthenticated|unauthori[sz]ed|please (log|sign) ?in|cursor-agent login|authentication (required|failed)/i;

export function looksLikeAuthError(outcome?: RunOutcome): boolean {
  if (!outcome) return false;
  return AUTH_RE.test([outcome.message ?? '', ...outcome.stderrTail].join('\n'));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

interface Props {
  tabId: string;
  status: 'error' | 'timeout';
  outcome?: RunOutcome;
  /** Retry is offered only for the latest run when the tab is idle. */
  canRetry: boolean;
}

/** Failed run: what went wrong, the stderr tail, and what to do next (PLAN.md §5.5). */
export function ErrorBanner({ tabId, status, outcome, canRetry }: Props) {
  const auth = looksLikeAuthError(outcome);
  const tail = outcome?.stderrTail.filter((l) => l.trim()) ?? [];
  const title = auth ? 'Not logged in to Cursor' : status === 'timeout' ? 'Run timed out' : 'Run failed';
  const exit = outcome?.exitCode !== null && outcome?.exitCode !== undefined ? ` (exit code ${outcome.exitCode})` : '';
  return (
    <div className="error-banner" role="alert">
      <div className="error-title">
        {title}
        <span className="muted">{exit}</span>
      </div>
      {outcome?.message && <div className="error-message">{truncate(outcome.message, 400)}</div>}
      {tail.length > 1 && (
        <details>
          <summary>stderr ({tail.length} lines)</summary>
          <pre>{tail.slice(-20).join('\n')}</pre>
        </details>
      )}
      <div className="banner-actions">
        {auth && (
          <button className="btn primary" onClick={() => send({ type: 'auth/login' })}>
            Run cursor-agent login
          </button>
        )}
        {canRetry && (
          <button className={`btn ${auth ? 'secondary' : 'primary'}`} onClick={() => send({ type: 'run/retry', tabId })}>
            Retry
          </button>
        )}
        <button className="link" onClick={() => send({ type: 'log/show' })}>
          Show log
        </button>
      </div>
    </div>
  );
}
