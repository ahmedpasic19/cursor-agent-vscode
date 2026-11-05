import { useState } from 'react';
import type { RunRecord } from '../../../src/shared/protocol';
import type { Block, RunView } from '../../../src/shared/transcript';
import { send } from '../vscode';
import { Markdown } from './Markdown';
import { ToolCard, UnknownCard } from './ToolCard';

function ThinkingBlock({ text, done }: { text: string; done: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button className="thinking-header" onClick={() => setOpen(!open)} aria-expanded={open}>
        {done ? 'Thought' : 'Thinking…'} <span className="chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

function BlockView({ block, streaming }: { block: Block; streaming: boolean }) {
  switch (block.type) {
    case 'text':
      return <Markdown text={block.text} streaming={streaming} />;
    case 'thinking':
      return <ThinkingBlock text={block.text} done={block.done} />;
    case 'tool':
      return <ToolCard tool={block.tool} status={block.status} />;
    case 'unknown':
      return <UnknownCard raw={block.raw} />;
  }
}

function formatDuration(ms?: number): string | undefined {
  if (ms === undefined) return undefined;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatTokens(n?: number): string {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function RunMessage({ run, view }: { run: RunRecord; view: RunView }) {
  const active = run.status === 'running' || run.status === 'queued';
  const blocks = view.blocks;
  const lastIsText = blocks[blocks.length - 1]?.type === 'text';
  const s = view.summary;
  const footer = [
    s.model,
    formatDuration(s.durationMs),
    s.usage ? `${formatTokens(s.usage.inputTokens)} in · ${formatTokens(s.usage.outputTokens)} out` : undefined,
  ].filter(Boolean);

  return (
    <div className="run">
      {run.status === 'queued' && <div className="run-note">Queued…</div>}
      {run.status === 'running' && blocks.length === 0 && <div className="run-note pulsing">Working…</div>}
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} streaming={active && lastIsText && i === blocks.length - 1} />
      ))}
      {run.status === 'stopped' && <div className="run-note">Stopped.</div>}
      {run.status === 'interrupted' && <div className="run-note">Interrupted.</div>}
      {(run.status === 'error' || run.status === 'timeout') && (
        <div className="error-banner" role="alert">
          <div className="error-title">{run.status === 'timeout' ? 'Run timed out' : 'Run failed'}</div>
          {run.outcome?.message && <div className="error-message">{truncate(run.outcome.message, 400)}</div>}
          {run.outcome && run.outcome.stderrTail.length > 1 && (
            <details>
              <summary>stderr</summary>
              <pre>{run.outcome.stderrTail.slice(-20).join('\n')}</pre>
            </details>
          )}
          <button className="link" onClick={() => send({ type: 'log/show' })}>
            Show log
          </button>
        </div>
      )}
      {!active && run.status === 'success' && footer.length > 0 && <div className="run-footer">{footer.join(' · ')}</div>}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
