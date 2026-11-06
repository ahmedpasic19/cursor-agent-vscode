import { describe, expect, it } from 'vitest';
import {
  type ActiveEditorInfo,
  fileAttached,
  fileLabel,
  hasSelection,
  rangeLabel,
  selectionAttached,
  selectionLabel,
} from '../src/shared/activeEditor';
import type { ContextChip } from '../src/shared/protocol';

const file = (path = 'src/app/main.ts'): ActiveEditorInfo => ({ path, absPath: `C:\\ws\\${path.replace(/\//g, '\\')}` });
const withSel = (startLine: number, endLine: number, extra: Partial<ActiveEditorInfo> = {}): ActiveEditorInfo => ({
  ...file(),
  startLine,
  endLine,
  selections: 1,
  selectedLines: endLine - startLine + 1,
  ...extra,
});

const selChip = (a: number, b: number, path = 'src/app/main.ts'): ContextChip => ({
  id: `c${a}`,
  kind: 'selection',
  path,
  absPath: `C:\\ws\\${path.replace(/\//g, '\\')}`,
  startLine: a,
  endLine: b,
});
const fileChip = (path = 'src/app/main.ts', isFolder = false): Extract<ContextChip, { kind: 'file' }> => ({
  id: 'f1',
  kind: 'file',
  path,
  absPath: `C:\\ws\\${path.replace(/\//g, '\\')}`,
  isFolder,
});

describe('active editor labels', () => {
  it('shows the file name only', () => {
    expect(fileLabel(file())).toBe('main.ts');
    expect(hasSelection(file())).toBe(false);
    expect(selectionLabel(file())).toBe('');
  });

  it('counts the selected lines', () => {
    expect(selectionLabel(withSel(12, 14))).toBe('3 lines selected');
    expect(selectionLabel(withSel(12, 12))).toBe('1 line selected');
    expect(rangeLabel(withSel(12, 14))).toBe('12-14');
    expect(rangeLabel(withSel(12, 12))).toBe('12');
  });

  it('names the number of ranges for a multi-cursor selection', () => {
    expect(selectionLabel(withSel(1, 2, { selections: 2, selectedLines: 5 }))).toBe('5 lines selected (2 ranges)');
  });
});

describe('already attached', () => {
  it('matches a file chip by path, case-insensitively', () => {
    expect(fileAttached(file(), [fileChip()])).toBe(true);
    expect(fileAttached(file(), [{ ...fileChip(), absPath: 'c:\\WS\\SRC\\app\\MAIN.TS' }])).toBe(true);
    expect(fileAttached(file(), [fileChip('src/app/other.ts')])).toBe(false);
    expect(fileAttached(file(), [])).toBe(false);
  });

  it('does not treat a folder chip as the file', () => {
    expect(fileAttached(file(), [fileChip('src/app/main.ts', true)])).toBe(false);
  });

  it('counts a selection as attached only when a chip covers it', () => {
    expect(selectionAttached(withSel(12, 14), [selChip(10, 20)])).toBe(true);
    expect(selectionAttached(withSel(12, 14), [selChip(12, 14)])).toBe(true);
    expect(selectionAttached(withSel(12, 20), [selChip(12, 14)])).toBe(false);
    expect(selectionAttached(withSel(12, 14), [selChip(12, 14, 'src/app/other.ts')])).toBe(false);
  });

  it('always offers a multi-range selection, and has nothing to match without one', () => {
    expect(selectionAttached(withSel(12, 14, { selections: 2 }), [selChip(1, 100)])).toBe(false);
    expect(selectionAttached(file(), [selChip(1, 100)])).toBe(false);
  });
});
