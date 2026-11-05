import type { ContextChip } from '../../../src/shared/protocol';
import { send } from '../vscode';

const ICON: Record<ContextChip['kind'], string> = {
  selection: '⌗',
  file: '📄',
  terminal: '❯',
  diagnostics: '⚠',
};

function label(c: ContextChip): string {
  switch (c.kind) {
    case 'selection': {
      const name = c.path.split('/').pop() ?? c.path;
      return `${name}:${c.startLine === c.endLine ? c.startLine : `${c.startLine}-${c.endLine}`}`;
    }
    case 'file':
      return c.isFolder ? `${c.path.split('/').pop()}/` : (c.path.split('/').pop() ?? c.path);
    case 'terminal':
      return `${c.name} (${c.lineCount} line${c.lineCount === 1 ? '' : 's'})`;
    case 'diagnostics':
      return `${c.items.length} problem${c.items.length === 1 ? '' : 's'}${c.path ? ` in ${c.path.split('/').pop()}` : ''}`;
  }
}

function tooltip(c: ContextChip): string {
  switch (c.kind) {
    case 'selection': {
      const head = `${c.path} lines ${c.startLine}–${c.endLine}`;
      if (c.text === undefined) return `${head}\nOver the size limit: sent as path and line range only.`;
      const preview = c.text.split('\n').slice(0, 12).join('\n');
      return `${head}${c.changed ? '\nFile changed since added — the snapshot below is what gets sent.' : ''}\n\n${preview}`;
    }
    case 'file':
      return `${c.isFolder ? 'Folder' : 'File'}: ${c.path}\nThe agent reads it itself; only the path is sent.`;
    case 'terminal':
      return c.text.split('\n').slice(-12).join('\n');
    case 'diagnostics':
      return c.items
        .slice(0, 12)
        .map((i) => `${i.path} ${i.line}`)
        .join('\n');
  }
}

function openChip(c: ContextChip) {
  if (c.kind === 'selection') send({ type: 'file/open', path: c.absPath, line: c.startLine, endLine: c.endLine });
  else if (c.kind === 'file' && !c.isFolder) send({ type: 'file/open', path: c.absPath });
  else if (c.kind === 'diagnostics' && c.path) send({ type: 'file/open', path: c.path });
}

interface Props {
  chips: ContextChip[];
  tabId?: string;
  /** Read-only rendering (in the transcript). */
  readOnly?: boolean;
}

export function ContextChips({ chips, tabId, readOnly }: Props) {
  if (!chips.length) return null;
  return (
    <div className={`chips${readOnly ? ' readonly' : ''}`}>
      {chips.map((c) => (
        <span key={c.id} className={`chip chip-${c.kind}`} title={tooltip(c)}>
          <button className="chip-main" onClick={() => openChip(c)} tabIndex={readOnly ? -1 : 0}>
            <span className="chip-icon" aria-hidden>
              {ICON[c.kind]}
            </span>
            <span className="chip-label">{label(c)}</span>
            {c.kind === 'selection' && c.text === undefined && (
              <span className="chip-flag" title="Over the size limit: path and line range only">
                range
              </span>
            )}
            {c.kind === 'selection' && c.changed && !readOnly && (
              <span className="chip-flag changed" title="File changed since added; the snapshot is sent">
                changed
              </span>
            )}
          </button>
          {!readOnly && tabId && (
            <button
              className="chip-remove"
              aria-label={`Remove ${label(c)}`}
              onClick={() => send({ type: 'chip/remove', tabId, chipId: c.id })}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
