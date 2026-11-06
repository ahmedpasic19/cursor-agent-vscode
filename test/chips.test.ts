import { describe, expect, it } from 'vitest';
import { addChip, chipLabel, type SelectionChip } from '../src/context/chips';
import { fuzzyFilter, fuzzyScore, withFolders } from '../src/context/fuzzy';
import type { ContextChip } from '../src/shared/protocol';
import { buildPrompt, chipsForAttachedContext, serializeChips, SWITCH_TO_AGENT_PREFIX } from '../src/session/promptBuilder';

const LINES = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);

function sel(path: string, a: number, b: number, id = `${path}:${a}-${b}`): SelectionChip {
  return { id, kind: 'selection', path, absPath: `C:\\ws\\${path}`, startLine: a, endLine: b, language: 'typescript', text: LINES.slice(a - 1, b).join('\n') };
}

function addAll(chips: ContextChip[], max = 2000): ContextChip[] {
  return chips.reduce<ContextChip[]>((list, c) => addChip(list, c, max).chips, []);
}

describe('addChip: selections', () => {
  it('keeps separate ranges in the same file', () => {
    const r = addAll([sel('a.ts', 1, 5), sel('a.ts', 10, 12)]);
    expect(r.map(chipLabel)).toEqual(['a.ts:L1-5', 'a.ts:L10-12']);
  });

  it('does not add the exact same range twice', () => {
    const r = addChip([sel('a.ts', 3, 7)], sel('a.ts', 3, 7, 'other'), 2000);
    expect(r.action).toBe('duplicate');
    expect(r.chips).toHaveLength(1);
    expect(r.chips[0]!.id).toBe('a.ts:3-7'); // keeps the original id
  });

  it('merges overlapping ranges and rebuilds the text line by line', () => {
    const r = addChip([sel('a.ts', 10, 24)], sel('a.ts', 20, 30), 2000);
    expect(r.action).toBe('merged');
    expect(r.chips).toHaveLength(1);
    const m = r.chips[0] as SelectionChip;
    expect([m.startLine, m.endLine]).toEqual([10, 30]);
    expect(m.text).toBe(LINES.slice(9, 30).join('\n'));
  });

  it('merges adjacent ranges', () => {
    const r = addChip([sel('a.ts', 1, 4)], sel('a.ts', 5, 8), 2000);
    expect(r.chips.map(chipLabel)).toEqual(['a.ts:L1-8']);
  });

  it('merges a contained range into the outer one', () => {
    const r = addChip([sel('a.ts', 1, 50)], sel('a.ts', 10, 12), 2000);
    expect(r.chips.map(chipLabel)).toEqual(['a.ts:L1-50']);
    expect((r.chips[0] as SelectionChip).text).toBe(LINES.slice(0, 50).join('\n'));
  });

  it('a bridging range merges two existing chips into one, keeping position', () => {
    const list = addAll([sel('a.ts', 1, 3), sel('b.ts', 1, 2), sel('a.ts', 10, 12)]);
    const r = addChip(list, sel('a.ts', 3, 10), 2000);
    expect(r.chips.map(chipLabel)).toEqual(['a.ts:L1-12', 'b.ts:L1-2']);
  });

  it('never merges across files (case-insensitive paths count as the same file)', () => {
    const r = addAll([sel('a.ts', 1, 5), sel('b.ts', 1, 5), sel('A.ts', 4, 6)]);
    expect(r.map(chipLabel)).toEqual(['a.ts:L1-6', 'b.ts:L1-5']);
  });

  it('drops the snapshot when the merged range exceeds the limit', () => {
    const r = addChip([sel('a.ts', 1, 30)], sel('a.ts', 20, 60), 50);
    const m = r.chips[0] as SelectionChip;
    expect([m.startLine, m.endLine]).toEqual([1, 60]);
    expect(m.text).toBeUndefined();
  });
});

describe('addChip: other kinds', () => {
  it('dedupes files and terminal output; replaces diagnostics for the same file', () => {
    const file: ContextChip = { id: 'f1', kind: 'file', path: 'src/x.ts', absPath: 'x', isFolder: false };
    const term: ContextChip = { id: 't1', kind: 'terminal', name: 'pwsh', text: 'out', lineCount: 1 };
    const d1: ContextChip = { id: 'd1', kind: 'diagnostics', path: 'a.ts', items: [{ path: 'a.ts', line: 'L1: error' }] };
    const d2: ContextChip = { id: 'd2', kind: 'diagnostics', path: 'a.ts', items: [{ path: 'a.ts', line: 'L2: error' }] };
    let list = addAll([file, term, d1]);
    expect(addChip(list, { ...file, id: 'f2' }, 2000).action).toBe('duplicate');
    expect(addChip(list, { ...term, id: 't2' }, 2000).action).toBe('duplicate');
    const r = addChip(list, d2, 2000);
    expect(r.action).toBe('replaced');
    list = r.chips;
    expect(list).toHaveLength(3);
    expect((list[2] as Extract<ContextChip, { kind: 'diagnostics' }>).items[0]!.line).toBe('L2: error');
  });
});

describe('promptBuilder', () => {
  it('sends plain text when there are no chips', () => {
    expect(buildPrompt({ text: 'hi', mode: 'ask' })).toBe('hi');
  });

  it('drops redundant file chips when a selection for the same file exists', () => {
    const s = sel('src/x.ts', 1, 3);
    const f: ContextChip = { id: 'f', kind: 'file', path: 'src/x.ts', absPath: s.absPath, isFolder: false };
    expect(chipsForAttachedContext([s, f])).toEqual([s]);
    const p = buildPrompt({ text: 'x', mode: 'ask', chips: [s, f] });
    expect(p).toContain('<selection');
    expect(p).not.toContain('<file path=');
  });

  it('serializes three chips from two files plus a terminal chip (PLAN.md §5.4 format)', () => {
    const chips: ContextChip[] = [
      sel('src/booking/api.ts', 10, 12),
      sel('src/booking/api.ts', 40, 41),
      sel('src/app.ts', 1, 1),
      { id: 'f', kind: 'file', path: 'src/booking/types.ts', absPath: 'x', isFolder: false },
      { id: 't', kind: 'terminal', name: 'pwsh', text: '$ npm test\nFAIL', lineCount: 2 },
      {
        id: 'd',
        kind: 'diagnostics',
        path: 'src/app.tsx',
        items: [{ path: 'src/app.tsx', line: "L12: error ts2339: Property 'x' does not exist on type 'Y'." }],
      },
    ];
    expect(buildPrompt({ text: 'Fix the booking bug', mode: 'agent', chips })).toBe(
      [
        '<attached_context>',
        '<selection path="src/booking/api.ts" lines="10-12" language="typescript">',
        'L10\nL11\nL12',
        '</selection>',
        '<selection path="src/booking/api.ts" lines="40-41" language="typescript">',
        'L40\nL41',
        '</selection>',
        '<selection path="src/app.ts" lines="1" language="typescript">',
        'L1',
        '</selection>',
        '<file path="src/booking/types.ts" />',
        '<terminal_output name="pwsh">',
        '$ npm test\nFAIL',
        '</terminal_output>',
        '<diagnostics path="src/app.tsx">',
        "L12: error ts2339: Property 'x' does not exist on type 'Y'.",
        '</diagnostics>',
        '</attached_context>',
        '',
        '<user_message>',
        'Fix the booking bug',
        '</user_message>',
      ].join('\n'),
    );
  });

  it('over-limit selections and folders are sent as paths only', () => {
    const big: ContextChip = { id: 'b', kind: 'selection', path: 'big.ts', absPath: 'x', startLine: 1, endLine: 5000 };
    const folder: ContextChip = { id: 'f', kind: 'file', path: 'src/lib', absPath: 'x', isFolder: true };
    expect(serializeChips([big, folder])).toBe(
      '<attached_context>\n<selection path="big.ts" lines="1-5000" />\n<folder path="src/lib" />\n</attached_context>',
    );
  });

  it('escapes attribute values', () => {
    const f: ContextChip = { id: 'f', kind: 'file', path: 'a "b" & <c>.ts', absPath: 'x', isFolder: false };
    expect(serializeChips([f])).toContain('<file path="a &quot;b&quot; &amp; &lt;c>.ts" />');
  });

  it('puts the switch-to-agent prefix before the context', () => {
    const p = buildPrompt({ text: 'go', mode: 'agent', sessionMode: 'plan', chips: [sel('a.ts', 1, 1)] });
    expect(p.startsWith(SWITCH_TO_AGENT_PREFIX + '<attached_context>')).toBe(true);
  });
});

describe('fuzzy file matching', () => {
  const files = withFolders(['src/booking/api.ts', 'src/booking/types.ts', 'src/app.tsx', 'README.md', 'test/api.test.ts']);

  it('derives folders', () => {
    expect(files.filter((f) => f.isFolder).map((f) => f.path).sort()).toEqual(['src', 'src/booking', 'test']);
  });

  it('ranks file-name matches first', () => {
    expect(fuzzyFilter('api', files, 3).map((f) => f.path)).toEqual(['src/booking/api.ts', 'test/api.test.ts']);
  });

  it('matches subsequences across path segments', () => {
    expect(fuzzyScore('sbt', 'src/booking/types.ts')).toBeDefined();
    expect(fuzzyScore('xyz', 'src/booking/types.ts')).toBeUndefined();
    expect(fuzzyFilter('bktyp', files, 1)[0]!.path).toBe('src/booking/types.ts');
  });

  it('empty query lists shallow paths first', () => {
    expect(fuzzyFilter('', files, 3).map((f) => f.path)).toEqual(['README.md', 'src', 'test']);
  });
});
