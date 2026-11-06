import type { AgentEvent, Mode, RunOutcome } from '../shared/events';

export interface RunOptions {
  cwd: string;
  /** Final prompt text; delivered on stdin. */
  prompt: string;
  mode: Mode;
  model?: string;
  resumeSessionId?: string;
  partialOutput: boolean;
  extraArgs: string[];
  postResultGraceMs: number;
  timeoutMs: number;
  /** Run in a named git worktree (`-w <name>`); the same name reuses the same worktree. */
  worktreeName?: string;
  /** Extra workspace roots the agent may read and edit (`--add-dir`): other multi-root folders, image folders. */
  addDirs?: string[];
  /** `--approve-mcps`: load every configured MCP server without asking. */
  approveMcps?: boolean;
  /** `--plugin-dir` for each local plugin folder. */
  pluginDirs?: string[];
  /**
   * Agent run on a resumed Ask chat whose stored mode could not be rewritten: resume with
   * `--mode plan --force` so the agent can call SwitchMode (docs/ASK_TO_AGENT_SWITCH.md, fallback).
   */
  switchViaPlan?: boolean;
}

export interface RunHandle {
  /** Resolves once the process is gone (or the run was abandoned after a kill). */
  readonly done: Promise<RunOutcome>;
  /** Kill the process tree. The outcome becomes `stopped` unless the run already finished. */
  stop(): void;
}

/** Hides the CLI (and a future SDK backend) from the session layer. */
export interface AgentBackend {
  run(opts: RunOptions, onEvent: (ev: AgentEvent) => void): RunHandle;
  /**
   * Sets the mode a resumed session starts in, before `run`. Resolves true on success. Only
   * backends that store the mode (the CLI) implement it; never called while a run uses the session.
   */
  setSessionMode?(sessionId: string, mode: Mode): Promise<boolean>;
}
