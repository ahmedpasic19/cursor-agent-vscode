import { useState } from 'react';
import type { ToolCallInfo } from '../../../src/shared/events';

type Status = 'running' | 'done' | 'error';

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** One-line header. Phase 2 replaces this with per-kind cards. */
function header(tool: ToolCallInfo): string {
  const a = tool.args;
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
  switch (tool.uiKind) {
    case 'read':
      return `Read ${basename(s('path') ?? '')}`;
    case 'edit': {
      const r = tool.result;
      const counts = r ? ` +${r.linesAdded ?? 0} −${r.linesRemoved ?? 0}` : '';
      return `Edited ${basename(s('path') ?? '')}${counts}`;
    }
    case 'delete':
      return `Deleted ${basename(s('path') ?? '')}`;
    case 'shell':
      return `$ ${s('command') ?? ''}`;
    case 'search':
      return `Searched "${s('globPattern') ?? s('pattern') ?? s('query') ?? ''}"`;
    case 'plan':
      return 'Created plan';
    case 'mode':
      return `Switched to ${s('targetModeId') ?? '?'} mode`;
    default:
      return tool.name;
  }
}

export function ToolCard({ tool, status }: { tool: ToolCallInfo; status: Status }) {
  const [open, setOpen] = useState(false);
  const icon = status === 'running' ? <span className="spinner" aria-label="running" /> : status === 'error' ? '✕' : '✓';
  return (
    <div className={`tool-card ${status}`}>
      <button className="tool-header" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-icon">{icon}</span>
        <span className="tool-title">{header(tool)}</span>
        <span className="chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-body">
          {tool.error && <div className="tool-error">{tool.error}</div>}
          <pre>{JSON.stringify({ args: tool.args, result: tool.result }, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

export function UnknownCard({ raw }: { raw: unknown }) {
  const [open, setOpen] = useState(false);
  const type = (raw as { type?: string })?.type ?? 'event';
  return (
    <div className="tool-card unknown">
      <button className="tool-header" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-icon">?</span>
        <span className="tool-title">Unrecognized {type}</span>
        <span className="chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-body">
          <pre>{typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
