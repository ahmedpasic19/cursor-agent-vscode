/** Messages between the extension host and the SDK worker process (NDJSON over stdio). */

export type WorkerRequest =
  | {
      op: 'run';
      cwd: string;
      prompt: string;
      /** SDK modes are agent | plan; Ask is agent + read-only `tools`. */
      mode: 'agent' | 'plan';
      tools?: string[];
      model: string;
      /** Resume this agent (the tab's session id) instead of creating one. */
      agentId?: string;
    }
  | { op: 'models' }
  | { op: 'cancel' };

export type WorkerMessage =
  | { t: 'agent'; agentId: string; model?: string; resumed: boolean }
  | { t: 'delta'; update: unknown }
  | {
      t: 'done';
      result: {
        status: 'finished' | 'error' | 'cancelled';
        result?: string;
        error?: { message: string; code?: string };
        durationMs?: number;
        usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
      };
    }
  | { t: 'models'; models: { id: string; label: string; isDefault?: boolean }[] }
  /** Failure before/outside a run (bad key, SDK missing, etc.). `name` is the SDK error class. */
  | { t: 'error'; name: string; message: string }
  | { t: 'log'; message: string };

/** Read-only toolset used to emulate the CLI's Ask mode (the SDK has no ask mode). */
export const ASK_MODE_TOOLS = ['read', 'grep', 'glob', 'ls', 'semSearch', 'readLints'];
