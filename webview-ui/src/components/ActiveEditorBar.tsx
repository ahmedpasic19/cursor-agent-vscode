import type { ActiveEditor, ContextChip } from '../../../src/shared/protocol';
import { fileAttached, fileLabel, hasSelection, rangeLabel, selectionAttached, selectionLabel } from '../../../src/shared/activeEditor';
import { send } from '../vscode';
import { CHIP_ICON } from './ContextChips';

interface Props {
  /** Undefined = no text editor focused; the bar is hidden. */
  active?: ActiveEditor;
  /** Chips already attached, so what is in there is shown as added instead of offered again. */
  chips: ContextChip[];
  disabled?: boolean;
}

/**
 * What the user is looking at right now: the active file and its selection, shown above the
 * composer. Clicking a pill attaches it exactly as Ctrl+I does (the host runs the same command).
 */
export function ActiveEditorBar({ active, chips, disabled }: Props) {
  if (!active || disabled) return null;
  const selection = hasSelection(active);
  const selIn = selectionAttached(active, chips);
  const fileIn = fileAttached(active, chips);

  return (
    <div className="active-editor" role="group" aria-label="Open in the editor">
      <span className="active-editor-lead" aria-hidden>
        Looking at
      </span>
      {selection && (
        <button
          type="button"
          className={`active-pill${selIn ? ' is-added' : ''}`}
          disabled={selIn}
          title={
            selIn
              ? `${active.path} lines ${rangeLabel(active)} is already attached`
              : `Add ${active.path} lines ${rangeLabel(active)} to the chat (same as Ctrl+I)`
          }
          onClick={() => send({ type: 'context/add', what: 'selection' })}
        >
          <span className="chip-icon" aria-hidden>
            {selIn ? '✓' : CHIP_ICON.selection}
          </span>
          <span className="chip-label">{selectionLabel(active)}</span>
          <span className="active-pill-range">{rangeLabel(active)}</span>
        </button>
      )}
      <button
        type="button"
        className={`active-pill${fileIn ? ' is-added' : ''}`}
        disabled={fileIn}
        title={fileIn ? `${active.path} is already attached` : `Add ${active.path} to the chat`}
        onClick={() => send({ type: 'context/add', what: 'activeFile' })}
      >
        <span className="chip-icon" aria-hidden>
          {fileIn ? '✓' : CHIP_ICON.file}
        </span>
        <span className="chip-label">{fileLabel(active)}</span>
      </button>
    </div>
  );
}
