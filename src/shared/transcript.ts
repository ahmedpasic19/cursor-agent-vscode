/**
 * Folds a run's AgentEvents into renderable blocks. Shared by host and webview so
 * both agree on what a transcript looks like.
 */
import type { AgentEvent, ToolCallInfo, Usage } from './events';

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; done: boolean; startedAt?: number; endedAt?: number }
  | { type: 'tool'; tool: ToolCallInfo; status: 'running' | 'done' | 'error' }
  | { type: 'unknown'; raw: unknown };

export interface RunSummary {
  durationMs?: number;
  usage?: Usage;
  model?: string;
  isError?: boolean;
  /** Set when the run used a git worktree (-w). */
  worktree?: string;
}

export interface RunView {
  blocks: Block[];
  summary: RunSummary;
}

export function emptyRunView(): RunView {
  return { blocks: [], summary: {} };
}

/** Mutates and returns `view`. */
export function applyEvent(view: RunView, ev: AgentEvent): RunView {
  const blocks = view.blocks;
  const last = blocks[blocks.length - 1];
  switch (ev.kind) {
    case 'init':
      view.summary.model = ev.model;
      break;
    case 'text':
      if (last?.type === 'text') last.text += ev.text;
      else blocks.push({ type: 'text', text: ev.text });
      break;
    case 'thinking':
      if (last?.type === 'thinking' && !last.done) last.text += ev.text;
      else blocks.push({ type: 'thinking', text: ev.text, done: false, startedAt: ev.at });
      break;
    case 'thinkingDone':
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!;
        if (b.type === 'thinking' && !b.done) {
          b.done = true;
          b.endedAt = ev.at;
          break;
        }
      }
      break;
    case 'toolStarted':
      if (!findTool(blocks, ev.tool.callId)) blocks.push({ type: 'tool', tool: ev.tool, status: 'running' });
      break;
    case 'toolCompleted': {
      const status = ev.tool.error !== undefined ? 'error' : 'done';
      const existing = findTool(blocks, ev.tool.callId);
      if (existing) {
        existing.tool = ev.tool;
        existing.status = status;
      } else {
        blocks.push({ type: 'tool', tool: ev.tool, status });
      }
      break;
    }
    case 'modeSwitched':
      break;
    case 'worktree':
      view.summary.worktree = ev.path;
      break;
    case 'result':
      view.summary.durationMs = ev.durationMs;
      view.summary.usage = ev.usage;
      view.summary.isError = ev.isError;
      // Close any thinking block left open.
      for (const b of blocks) if (b.type === 'thinking') b.done = true;
      break;
    case 'unknown':
      blocks.push({ type: 'unknown', raw: ev.raw });
      break;
  }
  return view;
}

function findTool(blocks: Block[], callId: string): Extract<Block, { type: 'tool' }> | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.type === 'tool' && b.tool.callId === callId) return b;
  }
  return undefined;
}

/**
 * Merge consecutive text deltas and consecutive thinking deltas. buildRunView() gives the
 * same blocks for the compacted list; history files get much smaller.
 */
export function compactEvents(events: AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (ev.kind === 'text' && last?.kind === 'text') {
      out[out.length - 1] = { kind: 'text', text: last.text + ev.text };
    } else if (ev.kind === 'thinking' && last?.kind === 'thinking') {
      out[out.length - 1] = { kind: 'thinking', text: last.text + ev.text, at: last.at };
    } else {
      out.push(ev);
    }
  }
  return out;
}

export function buildRunView(events: AgentEvent[]): RunView {
  const view = emptyRunView();
  for (const ev of events) applyEvent(view, ev);
  return view;
}

// ---------- display grouping (webview timeline) ----------

export type ToolBlock = Extract<Block, { type: 'tool' }>;
export type ThinkingBlock = Extract<Block, { type: 'thinking' }>;

export type DisplayItem =
  | { type: 'block'; key: string; block: Block; index: number }
  /** Consecutive thinking blocks folded into one "Thinking" line. */
  | { type: 'thinking'; key: string; text: string; done: boolean; ms?: number }
  /** 2+ consecutive read-only tools (read / search), with done thinking in between absorbed. */
  | { type: 'explore'; key: string; tools: ToolBlock[] };

const isExploreTool = (b: Block | undefined): b is ToolBlock =>
  b?.type === 'tool' && (b.tool.uiKind === 'read' || b.tool.uiKind === 'search');

/**
 * Turns a run's blocks into timeline items: merges consecutive thinking blocks and groups runs
 * of read/search tools ("Read 6 files, searched 2 patterns"). Pure; the blocks are not copied.
 */
export function groupBlocks(blocks: Block[]): DisplayItem[] {
  const out: DisplayItem[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i]!;
    if (isExploreTool(b)) {
      let j = i;
      let lastTool = i;
      while (j < blocks.length) {
        const x = blocks[j]!;
        if (isExploreTool(x)) lastTool = j;
        else if (!(x.type === 'thinking' && x.done)) break;
        j++;
      }
      const tools = blocks.slice(i, lastTool + 1).filter(isExploreTool);
      if (tools.length >= 2) {
        out.push({ type: 'explore', key: `x-${tools[0]!.tool.callId}`, tools });
        i = lastTool + 1;
        continue;
      }
    }
    if (b.type === 'thinking') {
      let j = i;
      const parts: string[] = [];
      let start: number | undefined;
      let end: number | undefined;
      let done = true;
      while (j < blocks.length && blocks[j]!.type === 'thinking') {
        const t = blocks[j] as ThinkingBlock;
        if (t.text.trim()) parts.push(t.text.trim());
        start ??= t.startedAt;
        end = t.endedAt ?? end;
        done = t.done;
        j++;
      }
      out.push({
        type: 'thinking',
        key: `t-${i}`,
        text: parts.join('\n\n'),
        done,
        ms: start !== undefined && end !== undefined ? end - start : undefined,
      });
      i = j;
      continue;
    }
    out.push({ type: 'block', key: b.type === 'tool' ? b.tool.callId : `b-${i}`, block: b, index: i });
    i++;
  }
  return out;
}

/** "Read 3 files, searched 2 patterns, listed 1 folder". */
export function exploreSummary(tools: ToolBlock[], running: boolean): string {
  let read = 0;
  let searched = 0;
  let listed = 0;
  for (const t of tools) {
    if (t.tool.uiKind === 'read') read++;
    else if (t.tool.name === 'ls' || t.tool.name === 'list') listed++;
    else searched++;
  }
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  if (read) parts.push(`${running && !searched && !listed ? 'Reading' : 'Read'} ${n(read, 'file', 'files')}`);
  if (searched) parts.push(`${parts.length ? 'searched' : running ? 'Searching' : 'Searched'} ${n(searched, 'pattern', 'patterns')}`);
  if (listed) parts.push(`${parts.length ? 'listed' : 'Listed'} ${n(listed, 'folder', 'folders')}`);
  return parts.join(', ');
}
