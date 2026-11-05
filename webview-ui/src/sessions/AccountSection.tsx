import type { AccountInfo, UsageSummary, UsageTotals } from '../../../src/shared/protocol';
import { send } from '../vscode';
import { compactNumber } from './store';

const total = (t: UsageTotals) => t.input + t.output + t.cacheRead + t.cacheWrite;

function breakdown(t: UsageTotals): string {
  const f = (n: number) => n.toLocaleString();
  return `${f(total(t))} tokens in ${t.runs} run${t.runs === 1 ? '' : 's'}\ninput ${f(t.input)} · output ${f(t.output)}\ncache read ${f(t.cacheRead)} · cache write ${f(t.cacheWrite)}`;
}

function UsageRow({ label, totals, budget, caption }: { label: string; totals: UsageTotals; budget: number; caption?: string }) {
  const used = total(totals);
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : undefined;
  return (
    <div className="usage-row" title={breakdown(totals)}>
      <div className="usage-line">
        <span>{label}</span>
        <span className="usage-value">{pct !== undefined ? `${pct}%` : `${compactNumber(used)} tokens`}</span>
      </div>
      {pct !== undefined && (
        <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${label} usage`}>
          <div className={`bar-fill${pct >= 90 ? ' high' : ''}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {caption && <div className="usage-caption">{pct !== undefined ? `${compactNumber(used)} of ${compactNumber(budget)} · ${caption}` : caption}</div>}
    </div>
  );
}

function KV({ k, v, title }: { k: string; v?: string; title?: string }) {
  if (!v) return null;
  return (
    <div className="kv">
      <span className="kv-key">{k}</span>
      <span className="kv-val" title={title ?? v}>
        {v}
      </span>
    </div>
  );
}

/** Account & Usage: CLI facts plus our own token totals. */
export function AccountBody({ account, usage }: { account?: AccountInfo; usage?: UsageSummary }) {
  if (!account) return <div className="pad muted">Checking…</div>;
  const sdk = account.backend === 'sdk';

  if (account.state !== 'ready') {
    return (
      <div className="pad account-problem">
        {account.state === 'checking' ? (
          <span className="muted">Checking the Cursor {sdk ? 'SDK' : 'CLI'}…</span>
        ) : (
          <>
            <p>{account.message ?? 'The Cursor agent is not ready.'}</p>
            <div className="btn-row">
              {account.state === 'notLoggedIn' && (
                <button className="btn primary" onClick={() => send({ type: 'auth/login' })}>
                  Log in
                </button>
              )}
              {account.state === 'notFound' && (
                <button className="btn primary" onClick={() => send({ type: 'settings/open', query: 'cursorAgent.cliPath' })}>
                  Set CLI path
                </button>
              )}
              {account.state === 'sdkNotInstalled' && (
                <button className="btn primary" onClick={() => send({ type: 'sdk/install' })}>
                  Install SDK
                </button>
              )}
              {account.state === 'noApiKey' && (
                <button className="btn primary" onClick={() => send({ type: 'sdk/setKey' })}>
                  Set API key
                </button>
              )}
              <button className="btn" onClick={() => send({ type: 'cli/refresh' })}>
                Retry
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="subhead">Account</div>
      <div className="kvs">
        <KV k="Email" v={account.email ?? (sdk ? 'API key' : undefined)} />
        <KV k="Plan" v={account.tier} />
        <KV
          k="Backend"
          v={sdk ? 'SDK (usage-billed)' : `CLI ${account.version ?? ''}`.trim()}
          title={account.latest ? `${account.version ?? ''} — ${account.latest}` : undefined}
        />
        <KV k="Model" v={account.model} />
      </div>
      {usage && (
        <>
          <div className="subhead">Usage</div>
          {usage.session && usage.session.runs > 0 && <UsageRow label="This session" totals={usage.session} budget={0} />}
          <UsageRow label="Today" totals={usage.today} budget={usage.dailyBudget} caption="Resets at midnight" />
          <UsageRow label="Last 7 days" totals={usage.week} budget={usage.dailyBudget * 7} caption="Rolling 7 days" />
          <div className="usage-note muted" title="Counted from the token usage each run reports. Your plan's limits are on the Cursor dashboard (View details).">
            Tokens used through this extension.
          </div>
        </>
      )}
      {!sdk && (
        <div className="btn-row tight">
          <button className="link" onClick={() => send({ type: 'auth/logout' })}>
            Log out
          </button>
        </div>
      )}
    </>
  );
}
