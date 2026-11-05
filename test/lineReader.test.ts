import { describe, expect, it } from 'vitest';
import { LineReader, RingBuffer } from '../src/backend/lineReader';

function collect(chunks: Buffer[]): string[] {
  const out: string[] = [];
  const r = new LineReader((l) => out.push(l));
  for (const c of chunks) r.push(c);
  r.end();
  return out;
}

describe('LineReader', () => {
  it('splits on \\n and strips \\r', () => {
    expect(collect([Buffer.from('a\r\nb\nc')])).toEqual(['a', 'b', 'c']);
  });

  it('handles a chunk split in the middle of a line', () => {
    expect(collect([Buffer.from('{"a":'), Buffer.from('1}\n{"b"'), Buffer.from(':2}\n')])).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  it('handles a chunk split inside a multi-byte UTF-8 character', () => {
    const full = Buffer.from('héllo “wörld” 🚀\nnext\n', 'utf8');
    // Split at every possible byte offset.
    for (let i = 1; i < full.length; i++) {
      expect(collect([full.subarray(0, i), full.subarray(i)])).toEqual(['héllo “wörld” 🚀', 'next']);
    }
  });

  it('handles a \\r\\n pair split across chunks', () => {
    expect(collect([Buffer.from('a\r'), Buffer.from('\nb\n')])).toEqual(['a', 'b']);
  });
});

describe('RingBuffer', () => {
  it('keeps only the last N items', () => {
    const r = new RingBuffer(2);
    ['a', 'b', 'c'].forEach((x) => r.push(x));
    expect(r.toArray()).toEqual(['b', 'c']);
  });
});
