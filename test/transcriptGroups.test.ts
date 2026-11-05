import { describe, expect, it } from 'vitest';
import type { ToolCallInfo } from '../src/shared/events';
import { exploreSummary, groupBlocks, type Block } from '../src/shared/transcript';

const tool = (callId: string, uiKind: ToolCallInfo['uiKind'], name: string = uiKind): Block => ({
  type: 'tool',
  status: 'done',
  tool: { callId, name, uiKind, args: {} },
});
const think = (text: string, done = true, startedAt?: number, endedAt?: number): Block => ({ type: 'thinking', text, done, startedAt, endedAt });
const text = (t: string): Block => ({ type: 'text', text: t });

describe('groupBlocks', () => {
  it('groups 2+ consecutive read/search tools and absorbs done thinking between them', () => {
    const items = groupBlocks([text('hi'), tool('a', 'read'), think('hmm'), tool('b', 'search', 'grep'), tool('c', 'read'), text('done')]);
    expect(items.map((i) => i.type)).toEqual(['block', 'explore', 'block']);
    const x = items[1]!;
    expect(x.type === 'explore' && x.tools.map((t) => t.tool.callId)).toEqual(['a', 'b', 'c']);
  });

  it('leaves a single read alone and keeps trailing thinking outside the group', () => {
    const items = groupBlocks([tool('a', 'read'), think('x'), tool('e', 'edit')]);
    expect(items.map((i) => i.type)).toEqual(['block', 'thinking', 'block']);
    const items2 = groupBlocks([tool('a', 'read'), tool('b', 'read'), think('after')]);
    expect(items2.map((i) => i.type)).toEqual(['explore', 'thinking']);
  });

  it('does not absorb running thinking or other tools', () => {
    const items = groupBlocks([tool('a', 'read'), think('live', false), tool('b', 'read')]);
    expect(items.map((i) => i.type)).toEqual(['block', 'thinking', 'block']);
    const items2 = groupBlocks([tool('a', 'read'), tool('s', 'shell'), tool('b', 'read')]);
    expect(items2.map((i) => i.type)).toEqual(['block', 'block', 'block']);
  });

  it('merges consecutive thinking blocks', () => {
    const items = groupBlocks([think('one', true, 1000, 2000), think(' two ', true, 2000, 4500), text('x')]);
    expect(items[0]).toMatchObject({ type: 'thinking', text: 'one\n\ntwo', done: true, ms: 3500 });
    expect(items).toHaveLength(2);
  });
});

describe('exploreSummary', () => {
  it('counts reads, searches and listings', () => {
    const tools = [tool('a', 'read'), tool('b', 'read'), tool('c', 'search', 'grep'), tool('d', 'search', 'ls')] as never;
    expect(exploreSummary(tools, false)).toBe('Read 2 files, searched 1 pattern, listed 1 folder');
    expect(exploreSummary([tool('a', 'read'), tool('b', 'read')] as never, true)).toBe('Reading 2 files');
  });
});
