/**
 * Pure chip-list logic (no vscode imports, unit-tested): de-duplication and merging of
 * overlapping selections (PLAN.md §5.4).
 */
import type { ContextChip } from '../shared/protocol';

export type SelectionChip = Extract<ContextChip, { kind: 'selection' }>;

let seq = 0;
export const chipId = () => `chip_${Date.now().toString(36)}_${(seq++).toString(36)}`;

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Lines start..end overlap or touch (adjacent ranges also merge). */
function touches(a: SelectionChip, b: SelectionChip): boolean {
  return a.startLine <= b.endLine + 1 && b.startLine <= a.endLine + 1;
}

/**
 * Merge two selection chips of the same file into one covering both ranges.
 * Text is rebuilt line by line; where both snapshots have a line, the newer chip (`b`) wins.
 * If either side has no snapshot (over the size limit), the result has none.
 */
export function mergeSelections(a: SelectionChip, b: SelectionChip, maxLines: number): SelectionChip {
  const start = Math.min(a.startLine, b.startLine);
  const end = Math.max(a.endLine, b.endLine);
  let text: string | undefined;
  if (a.text !== undefined && b.text !== undefined && end - start + 1 <= maxLines) {
    const lines = new Map<number, string>();
    a.text.split('\n').forEach((l, i) => lines.set(a.startLine + i, l));
    b.text.split('\n').forEach((l, i) => lines.set(b.startLine + i, l));
    const out: string[] = [];
    for (let n = start; n <= end; n++) out.push(lines.get(n) ?? '');
    text = out.join('\n');
  }
  return {
    ...a,
    id: a.id,
    startLine: start,
    endLine: end,
    text,
    changed: (a.changed || b.changed) ?? undefined,
  };
}

export interface AddResult {
  chips: ContextChip[];
  /** What happened, for logging/notices. */
  action: 'added' | 'merged' | 'duplicate' | 'replaced';
}

export function addChip(list: ContextChip[], chip: ContextChip, maxLines: number): AddResult {
  switch (chip.kind) {
    case 'file': {
      if (list.some((c) => c.kind === 'file' && samePath(c.path, chip.path))) return { chips: list, action: 'duplicate' };
      return { chips: [...list, chip], action: 'added' };
    }
    case 'terminal': {
      if (list.some((c) => c.kind === 'terminal' && c.text === chip.text)) return { chips: list, action: 'duplicate' };
      return { chips: [...list, chip], action: 'added' };
    }
    case 'diagnostics': {
      const i = list.findIndex((c) => c.kind === 'diagnostics' && (c.path ?? '') === (chip.path ?? ''));
      if (i < 0) return { chips: [...list, chip], action: 'added' };
      const next = [...list];
      next[i] = { ...chip, id: list[i]!.id };
      return { chips: next, action: 'replaced' };
    }
    case 'selection': {
      // Exact duplicate?
      if (
        list.some(
          (c) => c.kind === 'selection' && samePath(c.path, chip.path) && c.startLine === chip.startLine && c.endLine === chip.endLine,
        )
      ) {
        // Refresh the snapshot in place (the user re-added the same lines).
        return {
          chips: list.map((c) =>
            c.kind === 'selection' && samePath(c.path, chip.path) && c.startLine === chip.startLine && c.endLine === chip.endLine
              ? { ...chip, id: c.id }
              : c,
          ),
          action: 'duplicate',
        };
      }
      // Merge with every touching selection of the same file (a new range can bridge two).
      let merged: SelectionChip = chip;
      let firstIndex = -1;
      let mergedAny = false;
      const rest: ContextChip[] = [];
      list.forEach((c, i) => {
        if (c.kind === 'selection' && samePath(c.path, chip.path) && touches(c, merged)) {
          merged = mergeSelections(c, merged, maxLines);
          if (firstIndex < 0) firstIndex = i;
          mergedAny = true;
        } else {
          rest.push(c);
        }
      });
      if (!mergedAny) return { chips: [...list, chip], action: 'added' };
      // A later chip may now touch the grown range; repeat until stable.
      let changed = true;
      let remaining = rest;
      while (changed) {
        changed = false;
        const next: ContextChip[] = [];
        for (const c of remaining) {
          if (c.kind === 'selection' && samePath(c.path, chip.path) && touches(c, merged)) {
            merged = mergeSelections(c, merged, maxLines);
            changed = true;
          } else next.push(c);
        }
        remaining = next;
      }
      // Keep the merged chip at the position of the first chip it absorbed.
      const before = list.slice(0, firstIndex).filter((c) => remaining.includes(c));
      const after = remaining.filter((c) => !before.includes(c));
      return { chips: [...before, merged, ...after], action: 'merged' };
    }
  }
}

/** Short label for UI and logs. */
export function chipLabel(c: ContextChip): string {
  switch (c.kind) {
    case 'selection':
      return `${c.path}:${c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}-${c.endLine}`}`;
    case 'file':
      return c.isFolder ? `${c.path}/` : c.path;
    case 'terminal':
      return `Terminal: ${c.name}`;
    case 'diagnostics':
      return c.path ? `Problems: ${c.path}` : 'Problems: workspace';
  }
}
