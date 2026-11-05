/**
 * Raw Cursor `stream-json` NDJSON → normalized AgentEvent[].
 * Defensive by design: never throws on unexpected shapes; unknown events become `{kind:'unknown'}`.
 * Schema notes: docs/CLI_NOTES.md §5.
 */
import type { AgentEvent, ToolCallInfo, Usage } from '../shared/events';
import { toolUiKind } from './toolKinds';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface ParserOptions {
  /** Whether the CLI was started with --stream-partial-output (changes assistant dedupe rules). */
  partialOutput: boolean;
}

export class CursorStreamParser {
  constructor(private readonly opts: ParserOptions) {}

  /** Parse one NDJSON line. Returns [] for blank lines; `unknown` for non-JSON. */
  parseLine(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      const wt = /^Using worktree:\s*(.+)$/.exec(trimmed);
      if (wt) return [{ kind: 'worktree', path: wt[1]!.trim() }];
      return [{ kind: 'unknown', raw: trimmed }];
    }
    return this.parse(raw);
  }

  parse(raw: unknown): AgentEvent[] {
    if (!isObj(raw)) return [{ kind: 'unknown', raw }];
    try {
      return this.parseObj(raw);
    } catch {
      return [{ kind: 'unknown', raw }];
    }
  }

  private parseObj(ev: Obj): AgentEvent[] {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init' && str(ev.session_id)) {
          return [{ kind: 'init', sessionId: str(ev.session_id)!, model: str(ev.model), cwd: str(ev.cwd) }];
        }
        return [{ kind: 'unknown', raw: ev }];

      case 'user':
        // Echo of our own prompt; the transcript already has it.
        return [];

      case 'thinking':
        if (ev.subtype === 'delta') {
          const text = str(ev.text) ?? '';
          return text ? [{ kind: 'thinking', text, at: num(ev.timestamp_ms) }] : [];
        }
        if (ev.subtype === 'completed') return [{ kind: 'thinkingDone', at: num(ev.timestamp_ms) }];
        return [{ kind: 'unknown', raw: ev }];

      case 'assistant':
        return this.parseAssistant(ev);

      case 'tool_call':
        return this.parseToolCall(ev);

      case 'interaction_query':
        // Headless mode auto-answers these (createPlan / switchMode); the matching
        // tool_call events carry everything we render.
        return [];

      case 'result': {
        const usage = isObj(ev.usage) ? (ev.usage as Usage) : undefined;
        return [
          {
            kind: 'result',
            sessionId: str(ev.session_id),
            isError: ev.is_error === true || (ev.subtype !== undefined && ev.subtype !== 'success'),
            durationMs: num(ev.duration_ms),
            text: str(ev.result),
            usage,
          },
        ];
      }

      default:
        return [{ kind: 'unknown', raw: ev }];
    }
  }

  private parseAssistant(ev: Obj): AgentEvent[] {
    if (this.opts.partialOutput) {
      // Duplicate flushes: before tool calls (has model_call_id) and at end of turn (no timestamp_ms).
      if (ev.model_call_id !== undefined) return [];
      if (ev.timestamp_ms === undefined) return [];
    }
    const message = ev.message;
    if (!isObj(message) || !Array.isArray(message.content)) return [{ kind: 'unknown', raw: ev }];
    const text = message.content
      .map((c) => (isObj(c) && c.type === 'text' ? (str(c.text) ?? '') : ''))
      .join('');
    return text ? [{ kind: 'text', text }] : [];
  }

  private parseToolCall(ev: Obj): AgentEvent[] {
    const callId = str(ev.call_id);
    const tc = ev.tool_call;
    if (!callId || !isObj(tc)) return [{ kind: 'unknown', raw: ev }];
    const key = Object.keys(tc).find((k) => k.endsWith('ToolCall') && isObj(tc[k]));
    if (!key) return [{ kind: 'unknown', raw: ev }];
    const body = tc[key] as Obj;
    const name = key.slice(0, -'ToolCall'.length);
    const tool: ToolCallInfo = {
      callId,
      name,
      uiKind: toolUiKind(name),
      args: isObj(body.args) ? body.args : {},
    };

    if (ev.subtype === 'started') return [{ kind: 'toolStarted', tool }];
    if (ev.subtype !== 'completed') return [{ kind: 'unknown', raw: ev }];

    const result = body.result;
    if (isObj(result) && isObj(result.success)) {
      tool.result = result.success;
    } else if (isObj(result)) {
      tool.error = errorMessage(result);
    } else {
      tool.error = 'Tool returned no result';
    }

    const out: AgentEvent[] = [{ kind: 'toolCompleted', tool }];
    if (tool.uiKind === 'mode' && tool.result) {
      const to = str(tool.result.toModeId);
      if (to) out.push({ kind: 'modeSwitched', from: str(tool.result.fromModeId), to });
    }
    return out;
  }
}

function errorMessage(result: Obj): string {
  for (const v of Object.values(result)) {
    if (isObj(v)) {
      const msg = str(v.modelVisibleError) ?? str(v.error) ?? str(v.message);
      if (msg) return msg;
    } else if (typeof v === 'string' && v) {
      return v;
    }
  }
  const firstKey = Object.keys(result)[0];
  return firstKey ? `Tool failed (${firstKey})` : 'Tool failed';
}
