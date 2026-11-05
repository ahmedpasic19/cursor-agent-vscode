import { describe, expect, it } from 'vitest';
import { CursorStreamParser } from '../src/parser/cursorStreamJson';
import type { AgentEvent } from '../src/shared/events';
import { buildRunView } from '../src/shared/transcript';
import { loadFixtures } from './helpers';

const fixtures = loadFixtures();

function parseFixture(lines: string[], partial: boolean): AgentEvent[] {
  const p = new CursorStreamParser({ partialOutput: partial });
  return lines.flatMap((l) => p.parseLine(l));
}

/** Shorten absolute temp paths and huge payloads so snapshots stay readable and stable. */
function compact(events: AgentEvent[]): unknown[] {
  return events.map((e) => {
    if (e.kind === 'toolStarted' || e.kind === 'toolCompleted') {
      return {
        kind: e.kind,
        name: e.tool.name,
        uiKind: e.tool.uiKind,
        argKeys: Object.keys(e.tool.args).sort(),
        resultKeys: e.tool.result ? Object.keys(e.tool.result).sort() : undefined,
        error: e.tool.error,
      };
    }
    if (e.kind === 'init') return { kind: 'init', model: e.model };
    if (e.kind === 'result') return { kind: 'result', isError: e.isError, hasUsage: !!e.usage };
    return e;
  });
}

describe('CursorStreamParser on recorded fixtures', () => {
  it('has fixtures', () => expect(fixtures.length).toBeGreaterThanOrEqual(10));

  for (const fx of fixtures) {
    describe(fx.name, () => {
      const events = parseFixture(fx.lines, fx.partial);

      it('produces no unknown events', () => {
        expect(events.filter((e) => e.kind === 'unknown')).toEqual([]);
      });

      it('matches snapshot', () => {
        expect(compact(events)).toMatchSnapshot();
      });

      if (fx.meta.exitCode === 0) {
        it('starts with init and ends with result', () => {
          // -w runs announce the worktree before init.
          expect(events.find((e) => e.kind !== 'worktree')?.kind).toBe('init');
          if (fx.meta.args.includes('-w')) expect(events[0]).toMatchObject({ kind: 'worktree' });
          expect(events.at(-1)?.kind).toBe('result');
        });

        it('pairs every tool start with a completion', () => {
          const started = events.filter((e) => e.kind === 'toolStarted').map((e) => (e as any).tool.callId);
          const completed = events.filter((e) => e.kind === 'toolCompleted').map((e) => (e as any).tool.callId);
          expect(new Set(completed)).toEqual(new Set(started));
        });

        it('streams assistant text without duplicates (all segments == result text)', () => {
          const view = buildRunView(events);
          const texts = view.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
          const result = events.at(-1) as Extract<AgentEvent, { kind: 'result' }>;
          expect(texts.length).toBeGreaterThan(0);
          // `result.result` is the concatenation of every assistant segment in the run.
          expect(texts.join('').trim()).toBe(result.text!.trim());
          // No segment may contain itself twice (the signature of a missed duplicate flush).
          for (const t of texts) {
            const half = t.length / 2;
            if (t.length > 4 && Number.isInteger(half)) expect(t.slice(0, half)).not.toBe(t.slice(half));
          }
        });
      } else {
        it('error run has no stdout events', () => {
          expect(events).toEqual([]);
        });
      }
    });
  }
});

describe('CursorStreamParser edge cases', () => {
  const p = () => new CursorStreamParser({ partialOutput: true });

  it('turns non-JSON into unknown', () => {
    expect(p().parseLine('not json')).toEqual([{ kind: 'unknown', raw: 'not json' }]);
  });

  it('ignores blank lines', () => {
    expect(p().parseLine('   ')).toEqual([]);
  });

  it('turns unknown event types into unknown (never throws)', () => {
    const raw = { type: 'brand_new_event', foo: 1 };
    expect(p().parse(raw)).toEqual([{ kind: 'unknown', raw }]);
    expect(p().parse(null)).toEqual([{ kind: 'unknown', raw: null }]);
    expect(p().parse({ type: 'tool_call', subtype: 'started' })).toEqual([
      { kind: 'unknown', raw: { type: 'tool_call', subtype: 'started' } },
    ]);
  });

  it('extracts tool errors', () => {
    const [ev] = p().parse({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'c1',
      tool_call: { editToolCall: { args: { path: 'a' }, result: { error: { modelVisibleError: 'nope' } } } },
    });
    expect(ev).toMatchObject({ kind: 'toolCompleted', tool: { error: 'nope', uiKind: 'edit' } });
  });

  it('emits modeSwitched for switchModeToolCall', () => {
    const evs = p().parse({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'c2',
      tool_call: { switchModeToolCall: { args: {}, result: { success: { fromModeId: 'plan', toModeId: 'agent' } } } },
    });
    expect(evs[1]).toEqual({ kind: 'modeSwitched', from: 'plan', to: 'agent' });
  });

  it('without partial output keeps whole assistant messages', () => {
    const np = new CursorStreamParser({ partialOutput: false });
    expect(np.parse({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })).toEqual([
      { kind: 'text', text: 'hi' },
    ]);
  });
});

describe('synthetic fixtures', () => {
  it('all-cards: unknown events and tools degrade gracefully', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const lines = readFileSync(resolve(import.meta.dirname, 'synthetic', 'all-cards.ndjson'), 'utf8').split('\n');
    const events = parseFixture(lines, true);
    const unknown = events.filter((e) => e.kind === 'unknown');
    expect(unknown).toHaveLength(2); // brand_new_event + non-JSON line
    const kinds = events.flatMap((e) => (e.kind === 'toolCompleted' ? [e.tool.uiKind] : []));
    expect(kinds).toEqual(['search', 'delete', 'shell', 'todo', 'mcp', 'unknown']);
    const failed = events.find((e) => e.kind === 'toolCompleted' && e.tool.name === 'brandNew');
    expect(failed && failed.kind === 'toolCompleted' && failed.tool.error).toBe('Something went wrong');
  });
});
