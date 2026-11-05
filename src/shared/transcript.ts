/**
 * Folds a run's AgentEvents into renderable blocks. Shared by host and webview so
 * both agree on what a transcript looks like.
 */
import type { AgentEvent, ToolCallInfo, Usage } from './events';

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; done: boolean }
  | { type: 'tool'; tool: ToolCallInfo; status: 'running' | 'done' | 'error' }
  | { type: 'unknown'; raw: unknown };

export interface RunSummary {
  durationMs?: number;
  usage?: Usage;
  model?: string;
  isError?: boolean;
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
      else blocks.push({ type: 'thinking', text: ev.text, done: false });
      break;
    case 'thinkingDone':
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!;
        if (b.type === 'thinking' && !b.done) {
          b.done = true;
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

export function buildRunView(events: AgentEvent[]): RunView {
  const view = emptyRunView();
  for (const ev of events) applyEvent(view, ev);
  return view;
}
