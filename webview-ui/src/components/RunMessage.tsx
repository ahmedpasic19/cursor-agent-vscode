import { useState } from 'react';
import type { RunRecord } from '../../../src/shared/protocol';
import { exploreSummary, groupBlocks, type DisplayItem, type RunView, type ToolBlock } from '../../../src/shared/transcript';
import { send } from '../vscode';
import { ChangesCard } from './ChangesCard';
import { ErrorBanner } from './ErrorBanner';
import { Markdown } from './Markdown';
import { Mascot } from './Mascot';
import { ToolCard, UnknownCard } from './tools/ToolCard';
import { useTab } from './tools/util';

function ThinkingLine({ item }: { item: Extract<DisplayItem, { type: 'thinking' }> }) {
  const [open, setOpen] = useState(false);
  const secs = item.ms !== undefined ? Math.max(1, Math.round(item.ms / 1000)) : undefined;
  const expandable = !!item.text;
  return (
    <div className={`tl-item thinking${item.done ? '' : ' running'}`}>
      <span className="tl-dot" />
      <div className="tl-content">
        <button className={`tl-head${expandable ? ' expandable' : ''}`} onClick={() => expandable && setOpen(!open)} aria-expanded={expandable ? open : undefined}>
          <span className="tl-title thinking-label">
            {item.done ? 'Thinking' : 'Thinking…'}
            {item.done && secs !== undefined && secs >= 3 && <span className="muted"> {secs}s</span>}
          </span>
          {expandable && <span className={`tl-chevron${open ? ' open' : ''}`}>›</span>}
        </button>
        {open && <div className="tl-body thinking-body">{item.text}</div>}
      </div>
    </div>
  );
}

function ExploreGroup({ tools }: { tools: ToolBlock[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.some((t) => t.status === 'running');
  const failed = tools.some((t) => t.status === 'error');
  return (
    <div className={`tl-item tool explore ${running ? 'running' : failed ? 'error' : 'done'}`}>
      <span className="tl-dot" />
      <div className="tl-content">
        <button className="tl-head expandable" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="tl-title">
            <b className="tl-verb">{exploreSummary(tools, running)}</b>
          </span>
          <span className={`tl-chevron${open ? ' open' : ''}`}>›</span>
        </button>
        {open && (
          <div className="tl-group">
            {tools.map((t) => (
              <ToolCard key={t.tool.callId} tool={t.tool} status={t.status} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatDuration(ms?: number): string | undefined {
  if (ms === undefined) return undefined;
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatTokens(n?: number): string {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

interface Props {
  run: RunRecord;
  view: RunView;
  /** This is the newest run in the tab (Retry / Run this plan only apply there). */
  isLatest: boolean;
}

export function RunMessage({ run, view, isLatest }: Props) {
  const { tabId, running } = useTab();
  const active = run.status === 'running' || run.status === 'queued';
  const blocks = view.blocks;
  const lastIsText = blocks[blocks.length - 1]?.type === 'text';
  const items = groupBlocks(blocks);
  const s = view.summary;
  const footer = [
    s.worktree ? `⎇ ${s.worktree.split(/[\\/]/).pop()}` : undefined,
    s.model,
    formatDuration(s.durationMs),
    s.usage
      ? `${formatTokens((s.usage.inputTokens ?? 0) + (s.usage.cacheReadTokens ?? 0))} in · ${formatTokens(s.usage.outputTokens)} out`
      : undefined,
  ].filter(Boolean);

  const canExecutePlan = isLatest && !running && run.mode === 'plan' && run.status === 'success';
  const hasPlanCard = blocks.some((b) => b.type === 'tool' && b.tool.uiKind === 'plan');
  const lastBusy = blocks[blocks.length - 1];
  const showWorking = run.status === 'running' && !(lastBusy?.type === 'thinking' && !lastBusy.done) && !(lastBusy?.type === 'tool' && lastBusy.status === 'running') && !lastIsText;

  return (
    <div className="run">
      {run.status === 'queued' && <div className="run-note">Queued. Waiting for another run to finish…</div>}
      {run.warnings?.map((w) => (
        <div key={w} className="warn-banner" role="status">
          {w}
        </div>
      ))}
      {items.map((it) => {
        if (it.type === 'thinking') return <ThinkingLine key={it.key} item={it} />;
        if (it.type === 'explore') return <ExploreGroup key={it.key} tools={it.tools} />;
        const b = it.block;
        switch (b.type) {
          case 'text':
            return (
              <div key={it.key} className="tl-item text">
                <span className="tl-dot" />
                <div className="tl-content">
                  <Markdown text={b.text} streaming={active && lastIsText && it.index === blocks.length - 1} />
                </div>
              </div>
            );
          case 'tool':
            return <ToolCard key={it.key} tool={b.tool} status={b.status} canExecutePlan={canExecutePlan} />;
          case 'unknown':
            return <UnknownCard key={it.key} raw={b.raw} />;
          default:
            return null;
        }
      })}
      {showWorking && (
        <div className="tl-item working">
          <span className="tl-dot mascot-dot">
            <Mascot size={14} state="working" />
          </span>
          <div className="tl-content muted">Working…</div>
        </div>
      )}
      {run.status === 'stopped' && <div className="run-note">Stopped. Send a message to continue.</div>}
      {run.status === 'interrupted' && (
        <div className="run-note">
          Interrupted: VS Code closed while this was running.{' '}
          {isLatest && !running && (
            <button className="btn secondary small" onClick={() => send({ type: 'run/resume', tabId })} title="Send “continue” to the same session">
              Resume
            </button>
          )}
        </div>
      )}
      {(run.status === 'error' || run.status === 'timeout') && (
        <ErrorBanner tabId={tabId} status={run.status} outcome={run.outcome} canRetry={isLatest && !running} />
      )}
      {canExecutePlan && !hasPlanCard && (
        <div className="plan-actions">
          <button className="btn primary" onClick={() => send({ type: 'plan/execute', tabId })}>
            Run this plan
          </button>
        </div>
      )}
      {run.changes && <ChangesCard runId={run.id} changes={run.changes} runActive={active} />}
      {!active && run.status === 'success' && footer.length > 0 && <div className="run-footer">{footer.join(' · ')}</div>}
    </div>
  );
}
