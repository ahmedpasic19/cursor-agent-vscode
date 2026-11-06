/**
 * "What you are looking at": the active editor file and its selection, mirrored into the chat
 * panel above the composer. Pure helpers (no vscode import) so both sides and the tests use them.
 */
import type { ActiveEditor, ContextChip } from './protocol';

/**
 * Shape (see ActiveEditorSchema): workspace-relative `path` + `absPath`, and — when something is
 * selected — the first range as 1-based `startLine`/`endLine`, plus `selectedLines` and
 * `selections` totalled over every non-empty selection.
 */
export type ActiveEditorInfo = ActiveEditor;

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export const hasSelection = (a: ActiveEditorInfo): boolean => a.startLine !== undefined && a.endLine !== undefined;

/** Label of the file pill: just the file name. */
export const fileLabel = (a: ActiveEditorInfo): string => base(a.path);

/** Label of the selection pill, e.g. `3 lines selected` or `1 line selected`. */
export function selectionLabel(a: ActiveEditorInfo): string {
  if (!hasSelection(a)) return '';
  const n = a.selectedLines ?? a.endLine! - a.startLine! + 1;
  const lines = `${n} line${n === 1 ? '' : 's'} selected`;
  return (a.selections ?? 1) > 1 ? `${lines} (${a.selections} ranges)` : lines;
}

/** Line range shown next to the selection label, e.g. `12-20` or `12`. */
export function rangeLabel(a: ActiveEditorInfo): string {
  if (!hasSelection(a)) return '';
  return a.startLine === a.endLine ? `${a.startLine}` : `${a.startLine}-${a.endLine}`;
}

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The whole file is already attached as a chip. */
export function fileAttached(a: ActiveEditorInfo, chips: ContextChip[]): boolean {
  return chips.some((c) => c.kind === 'file' && !c.isFolder && samePath(c.absPath, a.absPath));
}

/**
 * The selection is already covered by an attached chip (a selection chip spanning it, or the
 * whole file). Only decided for a single range; with several ranges we always offer the add.
 */
export function selectionAttached(a: ActiveEditorInfo, chips: ContextChip[]): boolean {
  if (!hasSelection(a) || (a.selections ?? 1) > 1) return false;
  return chips.some(
    (c) =>
      c.kind === 'selection' &&
      samePath(c.absPath, a.absPath) &&
      c.startLine <= a.startLine! &&
      c.endLine >= a.endLine!,
  );
}
