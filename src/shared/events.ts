/**
 * Normalized agent events: our own types, independent of the CLI's raw schema.
 * Produced by src/parser/cursorStreamJson.ts, consumed by the host and the webview.
 */

export type Mode = 'agent' | 'ask' | 'plan';

/** UI-level tool categories (see src/parser/toolKinds.ts). */
export type ToolUiKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'shell'
  | 'search'
  | 'plan'
  | 'mode'
  | 'todo'
  | 'mcp'
  | 'unknown';

export interface ToolCallInfo {
  callId: string;
  /** Raw key without the `ToolCall` suffix, e.g. `read`, `edit`, `shell`. */
  name: string;
  uiKind: ToolUiKind;
  args: Record<string, unknown>;
  /** `result.success` payload when completed successfully. */
  result?: Record<string, unknown>;
  /** Error message when completed with `result.error` (or any non-success result). */
  error?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type AgentEvent =
  | { kind: 'init'; sessionId: string; model?: string; cwd?: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'thinkingDone' }
  | { kind: 'toolStarted'; tool: ToolCallInfo }
  | { kind: 'toolCompleted'; tool: ToolCallInfo }
  | { kind: 'modeSwitched'; from?: string; to: string }
  | {
      kind: 'result';
      sessionId?: string;
      isError: boolean;
      durationMs?: number;
      text?: string;
      usage?: Usage;
    }
  | { kind: 'unknown'; raw: unknown };

export type RunStatus = 'queued' | 'running' | 'success' | 'error' | 'stopped' | 'timeout' | 'interrupted';

export interface RunOutcome {
  status: Exclude<RunStatus, 'queued' | 'running'>;
  exitCode: number | null;
  /** Last lines of stderr, newest last. */
  stderrTail: string[];
  sessionId?: string;
  message?: string;
}
