import type { AccountInfo, PlanUsageState, UsageSummary, UsageTotals } from '../../../src/shared/protocol';
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

const DASHBOARD = 'https://cursor.com/dashboard?tab=usage';

function PlanBar({ label, pct, sub, cls }: { label: string; pct?: number; sub?: boolean; cls: string }) {
  if (pct === undefined) return null;
  const shown = Math.round(pct);
  return (
    <div className={`plan-row${sub ? ' sub' : ''}`}>
      <span className="plan-label">{label}</span>
      <span className="plan-value">{shown}% used</span>
      <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown} aria-label={`${label} usage`}>
        <div className={`bar-fill ${cls}${pct >= 90 ? ' high' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const resetDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Cursor plan usage for the billing period, like the CLI's /usage screen. */
function PlanUsageBlock({ plan }: { plan?: PlanUsageState }) {
  if (!plan) return null;
  const head = (right?: string) => (
    <div className="subhead with-meta">
      <span>Plan usage</span>
      {right && <span className="subhead-meta">{right}</span>}
    </div>
  );
  if (plan.status === 'loading') {
    return (
      <>
        {head()}
        <div className="pad muted small">Loading plan usage…</div>
      </>
    );
  }
  if (plan.status !== 'ok') {
    const why =
      plan.status === 'noToken'
        ? 'Plan usage needs the Cursor CLI login.'
        : plan.status === 'auth'
          ? 'The saved Cursor login has expired. Send a message (the CLI refreshes it) or log in again.'
          : 'Plan usage is unavailable right now.';
    return (
      <>
        {head()}
        <div className="pad muted small">
          {why}{' '}
          <button className="link" onClick={() => send({ type: 'link/open', url: DASHBOARD })}>
            Open dashboard
          </button>
        </div>
      </>
    );
  }
  const u = plan.usage;
  return (
    <>
      {head(u.cycleEnd ? `Resets ${resetDate(u.cycleEnd)}` : undefined)}
      <div className="plan" title={u.message}>
        <PlanBar label="Included" pct={u.includedPct} cls="plan-included" />
        <PlanBar label="Auto" pct={u.autoPct} sub cls="plan-auto" />
        <PlanBar label="API" pct={u.apiPct} sub cls="plan-api" />
        <div className="plan-row">
          <span className="plan-label">On-Demand</span>
          <span className="plan-value">
            {u.onDemand.enabled && u.onDemand.limitCents ? `${money(u.onDemand.usedCents ?? 0)} / ${money(u.onDemand.limitCents)}` : 'Disabled'}
          </span>
        </div>
      </div>
    </>
  );
}

/** Account & Usage: CLI facts, Cursor plan usage, and our own token totals. */
export function AccountBody({ account, usage, plan }: { account?: AccountInfo; usage?: UsageSummary; plan?: PlanUsageState }) {
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
        <KV k="Plan" v={plan?.status === 'ok' ? (plan.usage.planName ?? account.tier) : account.tier} />
        <KV
          k="Backend"
          v={sdk ? 'SDK (usage-billed)' : `CLI ${account.version ?? ''}`.trim()}
          title={account.latest ? `${account.version ?? ''} — ${account.latest}` : undefined}
        />
        <KV k="Model" v={account.model} />
      </div>
      <PlanUsageBlock plan={plan} />
      {usage && (
        <>
          <div className="subhead">Tokens</div>
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
