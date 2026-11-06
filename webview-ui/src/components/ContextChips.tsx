import type { ContextChip } from '../../../src/shared/protocol';
import { chipLabel } from '../../../src/shared/inlineChips';
import { send } from '../vscode';

export const CHIP_ICON: Record<ContextChip['kind'], string> = {
  selection: '⌗',
  file: '📄',
  image: '🖼',
  terminal: '❯',
  diagnostics: '⚠',
};

const label = chipLabel;

export function chipTooltip(c: ContextChip): string {
  switch (c.kind) {
    case 'selection': {
      const head = `${c.path} lines ${c.startLine}–${c.endLine}`;
      if (c.text === undefined) return `${head}\nOver the size limit: sent as path and line range only.`;
      const preview = c.text.split('\n').slice(0, 12).join('\n');
      return `${head}${c.changed ? '\nFile changed since added — the snapshot below is what gets sent.' : ''}\n\n${preview}`;
    }
    case 'file':
      return `${c.isFolder ? 'Folder' : 'File'}: ${c.path}\nThe agent reads it itself; only the path is sent.`;
    case 'image':
      return `Image: ${c.name} (${formatBytes(c.bytes)})\nThe agent opens it from:\n${c.absPath}`;
    case 'terminal':
      return c.text.split('\n').slice(-12).join('\n');
    case 'diagnostics':
      return c.items
        .slice(0, 12)
        .map((i) => `${i.path} ${i.line}`)
        .join('\n');
  }
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function openChip(c: ContextChip) {
  if (c.kind === 'image') return send({ type: 'file/open', path: c.absPath });
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
        <span key={c.id} className={`chip chip-${c.kind}`} title={chipTooltip(c)}>
          <button className="chip-main" onClick={() => openChip(c)} tabIndex={readOnly ? -1 : 0}>
            {c.kind === 'image' && c.thumb ? (
              <img className="chip-thumb" src={c.thumb} alt="" />
            ) : (
              <span className="chip-icon" aria-hidden>
                {CHIP_ICON[c.kind]}
              </span>
            )}
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

/** One read-only chip, used inline in sent messages. */
export function InlineChip({ chip }: { chip: ContextChip }) {
  return (
    <button type="button" className={`chip chip-inline chip-${chip.kind}`} title={chipTooltip(chip)} onClick={() => openChip(chip)}>
      {chip.kind === 'image' && chip.thumb ? (
        <img className="chip-thumb" src={chip.thumb} alt="" />
      ) : (
        <span className="chip-icon" aria-hidden>
          {CHIP_ICON[chip.kind]}
        </span>
      )}
      <span className="chip-label">{chipLabel(chip)}</span>
    </button>
  );
}

type ImageChip = Extract<ContextChip, { kind: 'image' }>;

/** Attached images as thumbnails (above the composer input and above sent messages), not chips. */
export function ImageThumbs({ images, tabId, readOnly }: { images: ImageChip[]; tabId?: string; readOnly?: boolean }) {
  if (!images.length) return null;
  return (
    <div className={`image-thumbs${readOnly ? ' readonly' : ''}`}>
      {images.map((c) => (
        <span key={c.id} className="image-thumb" title={chipTooltip(c)}>
          <button className="image-thumb-open" onClick={() => openChip(c)} aria-label={`Open ${c.name}`}>
            {c.thumb ? <img src={c.thumb} alt="" /> : <span className="glyph">{CHIP_ICON.image}</span>}
          </button>
          {!readOnly && tabId && (
            <button className="image-thumb-remove" aria-label={`Remove ${c.name}`} onClick={() => send({ type: 'chip/remove', tabId, chipId: c.id })}>
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
