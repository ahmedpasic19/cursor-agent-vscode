import { useState } from 'react';
import type { RunRecord } from '../../../src/shared/protocol';
import type { Block, RunView } from '../../../src/shared/transcript';
import { send } from '../vscode';
import { ChangesCard } from './ChangesCard';
import { ErrorBanner } from './ErrorBanner';
import { Markdown } from './Markdown';
import { ToolCard, UnknownCard } from './tools/ToolCard';
import { useTab } from './tools/util';

function ThinkingBlock({ block }: { block: Extract<Block, { type: 'thinking' }> }) {
  const [open, setOpen] = useState(false);
  const secs =
    block.startedAt !== undefined && block.endedAt !== undefined
      ? Math.max(1, Math.round((block.endedAt - block.startedAt) / 1000))
      : undefined;
  const label = block.done ? (secs !== undefined ? `Thought for ${secs}s` : 'Thought') : 'Thinking…';
  return (
    <div className="thinking">
      <button className="thinking-header" onClick={() => setOpen(!open)} aria-expanded={open}>
        {label} <span className="chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="thinking-body">{block.text}</div>}
    </div>
  );
}

function formatDuration(ms?: number): string | undefined {
  if (ms === undefined) return undefined;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
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
  const s = view.summary;
  const footer = [
    s.model,
    formatDuration(s.durationMs),
    s.usage
      ? `${formatTokens((s.usage.inputTokens ?? 0) + (s.usage.cacheReadTokens ?? 0))} in · ${formatTokens(s.usage.outputTokens)} out`
      : undefined,
  ].filter(Boolean);

  const canExecutePlan = isLatest && !running && run.mode === 'plan' && run.status === 'success';
  const hasPlanCard = blocks.some((b) => b.type === 'tool' && b.tool.uiKind === 'plan');

  return (
    <div className="run">
      {run.status === 'queued' && <div className="run-note">Queued — waiting for another run to finish…</div>}
      {run.status === 'running' && blocks.length === 0 && <div className="run-note pulsing">Working…</div>}
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'text':
            return <Markdown key={i} text={b.text} streaming={active && lastIsText && i === blocks.length - 1} />;
          case 'thinking':
            return <ThinkingBlock key={i} block={b} />;
          case 'tool':
            return <ToolCard key={b.tool.callId} tool={b.tool} status={b.status} canExecutePlan={canExecutePlan} />;
          case 'unknown':
            return <UnknownCard key={i} raw={b.raw} />;
        }
      })}
      {run.status === 'stopped' && <div className="run-note">Stopped. Send a message to continue this chat.</div>}
      {run.status === 'interrupted' && <div className="run-note">Interrupted.</div>}
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
      {!active && run.status === 'success' && footer.length > 0 && <div className="run-footer">{footer.join(' · ')}</div>}
      {run.changes && <ChangesCard runId={run.id} changes={run.changes} runActive={active} />}
    </div>
  );
}
