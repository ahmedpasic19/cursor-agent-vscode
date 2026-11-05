/**
 * Maps SDK worker messages (SDK InteractionUpdates) to our normalized AgentEvents, so the UI,
 * transcript, checkpoints and history work unchanged (docs/SDK_NOTES.md). Pure; unit-tested.
 */
import { toolUiKind } from '../parser/toolKinds';
import type { AgentEvent, ToolCallInfo, Usage } from '../shared/events';
import type { WorkerMessage } from './workerProtocol';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Updates that carry nothing we render (partials and bookkeeping). */
const IGNORED = new Set([
  'partial-tool-call',
  'tool-call-delta',
  'token-delta',
  'step-started',
  'step-completed',
  'summary',
  'summary-started',
  'summary-completed',
  'shell-output-delta',
  'user-message-appended',
  'tool-requests-listed',
]);

/** SDK `{ type, args, result: {status, value|error} }` → ToolCallInfo. */
export function mapToolCall(callId: string, toolCall: unknown, completed: boolean): ToolCallInfo | undefined {
  if (!isObj(toolCall) || typeof toolCall.type !== 'string') return undefined;
  const name = toolCall.type;
  const info: ToolCallInfo = { callId, name, uiKind: toolUiKind(name), args: isObj(toolCall.args) ? toolCall.args : {} };
  if (!completed) return info;
  const r = toolCall.result;
  if (isObj(r) && r.status === 'success') {
    info.result = isObj(r.value) ? { ...r.value } : {};
    // Our edit card looks for result.path; the SDK keeps it in args.
    if ((info.uiKind === 'edit' || info.uiKind === 'delete') && !info.result.path && typeof info.args.path === 'string') {
      info.result.path = info.args.path;
    }
    // SDK `write` reports linesCreated; show it as added lines.
    if (name === 'write' && info.result.linesAdded === undefined && typeof info.result.linesCreated === 'number') {
      info.result.linesAdded = info.result.linesCreated;
      info.result.linesRemoved = 0;
    }
  } else if (isObj(r) && r.status === 'error') {
    info.error = (isObj(r.error) && str(r.error.message)) || 'Tool failed';
  } else {
    info.error = 'Tool returned no result';
  }
  return info;
}

export class SdkEventMapper {
  private usage?: Usage;
  private agentId?: string;
  private thinkingStart?: number;

  constructor(private readonly now: () => number = Date.now) {}

  map(msg: WorkerMessage): AgentEvent[] {
    switch (msg.t) {
      case 'agent':
        this.agentId = msg.agentId;
        return [{ kind: 'init', sessionId: msg.agentId, model: msg.model }];
      case 'delta':
        return this.mapUpdate(msg.update);
      case 'done': {
        const r = msg.result;
        const u = r.usage ?? this.usage;
        return [
          {
            kind: 'result',
            sessionId: this.agentId,
            isError: r.status === 'error',
            durationMs: r.durationMs,
            text: r.result ?? r.error?.message,
            usage: u
              ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens }
              : undefined,
          },
        ];
      }
      case 'models':
      case 'error':
      case 'log':
        return [];
    }
  }

  private mapUpdate(update: unknown): AgentEvent[] {
    if (!isObj(update) || typeof update.type !== 'string') return [{ kind: 'unknown', raw: update }];
    switch (update.type) {
      case 'text-delta': {
        const text = str(update.text) ?? '';
        return text ? [{ kind: 'text', text }] : [];
      }
      case 'thinking-delta': {
        const text = str(update.text) ?? '';
        this.thinkingStart ??= this.now();
        return text ? [{ kind: 'thinking', text, at: this.thinkingStart }] : [];
      }
      case 'thinking-completed': {
        const dur = typeof update.thinkingDurationMs === 'number' ? update.thinkingDurationMs : undefined;
        const start = this.thinkingStart ?? this.now();
        this.thinkingStart = undefined;
        return [{ kind: 'thinkingDone', at: dur !== undefined ? start + dur : this.now() }];
      }
      case 'tool-call-started':
      case 'tool-call-completed': {
        const done = update.type === 'tool-call-completed';
        const tool = mapToolCall(str(update.callId) ?? '', update.toolCall, done);
        if (!tool) return [{ kind: 'unknown', raw: update }];
        return [done ? { kind: 'toolCompleted', tool } : { kind: 'toolStarted', tool }];
      }
      case 'turn-ended':
        if (isObj(update.usage)) this.usage = update.usage as Usage;
        return [];
      default:
        return IGNORED.has(update.type) ? [] : [{ kind: 'unknown', raw: update }];
    }
  }
}

/** User-facing text for SDK errors (class names from @cursor/sdk errors.d.ts). */
export function friendlySdkError(name: string, message: string): string {
  switch (name) {
    case 'AuthenticationError':
      return `Cursor rejected the SDK API key (${message}). Run “Cursor Agent: Set SDK API Key”.`;
    case 'RateLimitError':
      return `Rate limited by Cursor: ${message}`;
    case 'NetworkError':
      return `Network error talking to Cursor: ${message}`;
    case 'ConfigurationError':
      return `SDK configuration error: ${message}`;
    case 'AgentNotFoundError':
      return `The SDK agent for this chat no longer exists (${message}). Use /clear to start a new session.`;
    case 'SdkNotInstalled':
      return `${message}. Run “Cursor Agent: Install SDK Backend”.`;
    default:
      return `${name}: ${message}`;
  }
}
