import { realpathSync } from 'node:fs';
import type { AgentBackend, RunHandle } from '../backend/AgentBackend';
import { chipLabel, expandChipTokens } from '../shared/inlineChips';
import type { CheckpointService } from '../checkpoints/CheckpointService';
import type { AgentEvent, Mode, RunOutcome } from '../shared/events';
import { addChip, type AddResult } from '../context/chips';
import type { ContextChip, PromptCommandInput, RunRecord, TabSnapshot, TranscriptItem, UserMessage } from '../shared/protocol';
import { compactEvents } from '../shared/transcript';
import { buildPrompt, chipsForAttachedContext, extraRoots, titleFrom } from './promptBuilder';

/** Placeholder while a run is starting (taking its checkpoint). */
const PENDING_HANDLE: RunHandle = { done: new Promise(() => {}), stop: () => {} };

let counter = 0;
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export interface RunSettings {
  partialOutput: boolean;
  extraArgs: string[];
  postResultGraceMs: number;
  timeoutMs: number;
  /** CLI supports -w (from --help). */
  worktreeSupported?: boolean;
  /** All workspace folders; the ones other than this tab's cwd are passed as extra roots. */
  workspaceRoots?: string[];
  approveMcps?: boolean;
  pluginDirs?: string[];
}

export interface TabEvents {
  onRunStarted(tab: TabSession, user: UserMessage, run: RunRecord): void;
  onRunEvent(tab: TabSession, run: RunRecord, ev: AgentEvent): void;
  onRunFinished(tab: TabSession, run: RunRecord, outcome: RunOutcome): void;
  onTabUpdated(tab: TabSession): void;
  onChipsUpdated(tab: TabSession): void;
  /** The tab was cleared (/clear): the webview must replace its copy. */
  onTabReset(tab: TabSession): void;
  onRunChanges(tab: TabSession, run: RunRecord): void;
  onRunWarnings(tab: TabSession, run: RunRecord): void;
}

/** A checkpoint service for this tab's root, or a reason why checkpoints are off. */
export type CheckpointSource = CheckpointService | { unavailable: string } | undefined;

/** Coordinates Agent runs across tabs (SessionManager implements it). */
export interface OverlapTracker {
  agentRunStarted(tab: TabSession, run: RunRecord): void;
  agentRunEnded(tab: TabSession, run: RunRecord): void;
  /** Paths edited by tool calls of other tabs' runs that overlapped `run` (normalized keys). */
  foreignPaths(tab: TabSession, run: RunRecord): Set<string>;
}

export interface RunContext {
  checkpoints?: CheckpointSource;
  overlap?: OverlapTracker;
}

/** On-disk form of a tab (HistoryStore). */
export interface PersistedTab {
  version: 1;
  id: string;
  title: string;
  titled: boolean;
  cwd?: string;
  sessionId?: string;
  sessionMode?: Mode;
  mode: Mode;
  model?: string;
  chips: ContextChip[];
  transcript: TranscriptItem[];
  createdAt: number;
  updatedAt: number;
  worktree?: boolean;
  worktreePath?: string;
}

const realRoots = new Map<string, string>();
function realRoot(root: string): string {
  let r = realRoots.get(root);
  if (r === undefined) {
    try {
      r = realpathSync.native(root);
    } catch {
      r = root;
    }
    realRoots.set(root, r);
  }
  return r;
}

/** Case-insensitive on Windows, forward slashes, relative to the tab root. */
export function pathKey(root: string, p: string): string {
  let rel = p.replace(/\\/g, '/');
  // The agent may report paths under the resolved root (e.g. macOS /var → /private/var).
  for (const candidate of [root, realRoot(root)]) {
    const r = candidate.replace(/\\/g, '/').replace(/\/$/, '');
    if (rel.toLowerCase().startsWith(r.toLowerCase() + '/')) {
      rel = rel.slice(r.length + 1);
      break;
    }
  }
  rel = rel.replace(/^\.\//, '');
  return process.platform === 'win32' ? rel.toLowerCase() : rel;
}

/** One chat tab: its CLI session, transcript, and at most one active run. */
export class TabSession {
  readonly id: string;
  title = 'New chat';
  private titled = false;
  createdAt = Date.now();
  updatedAt = Date.now();
  /** Paths edited/deleted by each run's tool calls (normalized keys), for overlap attribution. */
  readonly touched = new Map<string, Set<string>>();
  sessionId?: string;
  /** Mode the CLI session is currently in (sticky across --resume). */
  sessionMode?: Mode;
  mode: Mode;
  model?: string;
  readonly transcript: TranscriptItem[] = [];
  /** Context chips waiting for the next message. */
  chips: ContextChip[] = [];
  /** Runs use an isolated git worktree (`-w cursor-agent-<tab>`), reused across runs. */
  worktree = false;
  worktreePath?: string;
  private active?: { run: RunRecord; handle?: RunHandle };

  constructor(
    readonly cwd: string | undefined,
    mode: Mode,
    model: string | undefined,
    private readonly events: TabEvents,
    restore?: PersistedTab,
  ) {
    this.mode = mode;
    this.model = model;
    this.id = restore?.id ?? newId('tab');
    if (restore) {
      this.title = restore.title;
      this.titled = restore.titled;
      this.sessionId = restore.sessionId;
      this.sessionMode = restore.sessionMode;
      this.chips = restore.chips ?? [];
      this.createdAt = restore.createdAt;
      this.updatedAt = restore.updatedAt;
      this.worktree = !!restore.worktree;
      this.worktreePath = restore.worktreePath;
      for (const item of restore.transcript) {
        // Runs that were active when VS Code closed can't be continued as-is.
        if (item.role === 'run' && (item.status === 'running' || item.status === 'queued')) {
          item.status = 'interrupted';
          if (item.changes?.status === 'pending') {
            item.changes = { ...item.changes, status: 'unavailable', message: 'VS Code closed during this run; its changes were not recorded.' };
          }
        }
        this.transcript.push(item);
      }
    }
  }

  serialize(): PersistedTab {
    return {
      version: 1,
      id: this.id,
      title: this.title,
      titled: this.titled,
      cwd: this.cwd,
      sessionId: this.sessionId,
      sessionMode: this.sessionMode,
      mode: this.mode,
      model: this.model,
      chips: this.chips,
      transcript: this.transcript,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      worktree: this.worktree,
      worktreePath: this.worktreePath,
    };
  }

  /** Stable worktree name for this tab (the CLI reuses an existing worktree with the same name). */
  get worktreeName(): string {
    return `cursor-agent-${this.id.replace(/^tab_/, '')}`;
  }

  setWorktree(enabled: boolean): void {
    if (this.active || this.worktree === enabled) return;
    this.worktree = enabled;
    this.events.onTabUpdated(this);
  }

  rename(title: string): void {
    this.title = title.trim().slice(0, 200) || this.title;
    this.titled = true;
    this.events.onTabUpdated(this);
  }

  get running(): boolean {
    return !!this.active;
  }

  snapshot(): TabSnapshot {
    return {
      id: this.id,
      title: this.title,
      sessionId: this.sessionId,
      mode: this.mode,
      model: this.model,
      cwd: this.cwd,
      running: this.running,
      worktree: this.worktree || undefined,
      worktreePath: this.worktreePath,
      chips: this.chips,
      transcript: this.transcript,
    };
  }

  /**
   * Adds the user message and a queued run record. The run starts when `start()` is
   * called (the SessionManager decides when, to honor the concurrency limit).
   */
  addChip(chip: ContextChip, maxLines: number): AddResult['action'] {
    const r = addChip(this.chips, chip, maxLines);
    this.chips = r.chips;
    this.events.onChipsUpdated(this);
    return r.action;
  }

  removeChip(id: string): void {
    this.chips = this.chips.filter((c) => c.id !== id);
    this.events.onChipsUpdated(this);
  }

  /** Update chips in place (e.g. mark selections whose file changed). */
  updateChips(fn: (c: ContextChip) => ContextChip): void {
    let changed = false;
    this.chips = this.chips.map((c) => {
      const n = fn(c);
      if (n !== c) changed = true;
      return n;
    });
    if (changed) this.events.onChipsUpdated(this);
  }

  /** /clear: forget the CLI session and transcript; keep the tab. */
  clear(): void {
    if (this.active) return;
    this.transcript.length = 0;
    this.sessionId = undefined;
    this.sessionMode = undefined;
    this.title = 'New chat';
    this.titled = false;
    this.events.onTabReset(this);
  }

  enqueue(
    text: string,
    mode: Mode,
    model: string | undefined,
    chipIds: string[] = [],
    chipsOverride?: ContextChip[],
    promptOpts?: { sendText: string; promptCommand?: PromptCommandInput },
  ): RunRecord {
    if (this.active) throw new Error('A run is already active in this tab');
    // Consume the requested chips (in composer order).
    const attached = chipsOverride ?? this.chips.filter((c) => chipIds.includes(c.id));
    if (!chipsOverride && attached.length) {
      this.chips = this.chips.filter((c) => !chipIds.includes(c.id));
      this.events.onChipsUpdated(this);
    }
    this.mode = mode;
    this.model = model || undefined;
    const sendText = promptOpts?.sendText ?? text;
    if (!this.titled) {
      this.title = titleFrom(expandChipTokens(text, attached, chipLabel));
      this.titled = true;
    }
    const user: UserMessage = {
      id: newId('msg'),
      role: 'user',
      text,
      ...(sendText !== text ? { sendText } : {}),
      ...(promptOpts?.promptCommand ? { promptCommand: promptOpts.promptCommand } : {}),
      mode,
      at: Date.now(),
      chips: attached.length ? attached : undefined,
    };
    this.updatedAt = Date.now();
    const run: RunRecord = {
      id: newId('run'),
      role: 'run',
      mode,
      model: this.model,
      status: 'queued',
      events: [],
      startedAt: Date.now(),
    };
    this.transcript.push(user, run);
    this.active = { run };
    this.events.onRunStarted(this, user, run);
    this.events.onTabUpdated(this);
    return run;
  }

  /** Starts the queued run. Resolves when it finishes. */
  async start(backend: AgentBackend, settings: RunSettings, ctx: RunContext = {}): Promise<void> {
    const { checkpoints, overlap } = ctx;
    const active = this.active;
    if (!active || active.handle) return;
    const run = active.run;
    const user = this.transcript[this.transcript.length - 2] as UserMessage;
    // Guard against starting twice while the pre-snapshot is being taken.
    active.handle = PENDING_HANDLE;

    if (!this.cwd) {
      this.finish(run, {
        status: 'error',
        exitCode: null,
        stderrTail: [],
        message: 'Open a folder or workspace first — the agent needs a working directory.',
      });
      return;
    }

    run.status = 'running';
    run.startedAt = Date.now();

    // Checkpoint before Agent runs (PLAN.md 5.6).
    let ckpt: CheckpointService | undefined;
    let preSha: string | undefined;
    const useWorktree = this.worktree && settings.worktreeSupported !== false;
    if (run.mode === 'agent' && useWorktree) {
      run.changes = {
        status: 'unavailable',
        files: [],
        message: 'This run works in its own git worktree, so your working tree is untouched. Review and merge its branch when you are happy with it.',
      };
      this.events.onRunChanges(this, run);
    } else if (run.mode === 'agent' && checkpoints) {
      if ('unavailable' in checkpoints) {
        run.changes = { status: 'unavailable', files: [], message: checkpoints.unavailable };
      } else {
        try {
          preSha = await checkpoints.snapshot(`pre:${this.id}:${run.id}`);
          ckpt = checkpoints;
          run.changes = { status: 'pending', preSha, files: [] };
        } catch (e) {
          run.changes = {
            status: 'unavailable',
            files: [],
            message: `Checkpoint failed (${e instanceof Error ? e.message : String(e)}); this run has no undo.`,
          };
        }
      }
      // Stopped while the snapshot was being taken: nothing ran, nothing changed.
      if (this.active?.run !== run) {
        if (preSha) run.changes = { status: 'ready', preSha, postSha: preSha, files: [] };
        this.events.onRunChanges(this, run);
        return;
      }
      this.events.onRunChanges(this, run);
    }

    // Agent turn on a resumed Ask/Plan chat: rewrite the stored mode so the run starts in Agent
    // (docs/ASK_TO_AGENT_SWITCH.md). If that fails, resume via Plan mode + the switch prefix.
    let switchViaPlan = false;
    if (run.mode === 'agent' && this.sessionId && this.sessionMode && this.sessionMode !== 'agent' && backend.setSessionMode) {
      let ok = false;
      try {
        ok = await backend.setSessionMode(this.sessionId, 'agent');
      } catch {
        ok = false;
      }
      if (ok) this.sessionMode = 'agent';
      else switchViaPlan = true;
      // Stopped while the store was being updated.
      if (this.active?.run !== run) {
        if (run.changes?.status === 'pending' && preSha) {
          run.changes = { status: 'ready', preSha, postSha: preSha, files: [] };
          this.events.onRunChanges(this, run);
        }
        return;
      }
    }

    const touched = new Set<string>();
    this.touched.set(run.id, touched);
    if (run.mode === 'agent') overlap?.agentRunStarted(this, run);

    const prompt = buildPrompt({
      text: user.sendText ?? user.text,
      mode: run.mode,
      sessionMode: this.sessionId ? this.sessionMode : undefined,
      chips: user.chips,
      cwd: this.cwd,
    });
    const { workspaceRoots, ...runSettings } = settings;
    const chipsForRoots = user.chips?.length ? chipsForAttachedContext(user.chips) : [];
    const addDirs = extraRoots(this.cwd, workspaceRoots ?? [], chipsForRoots);

    active.handle = backend.run(
      {
        cwd: this.cwd,
        prompt,
        mode: run.mode,
        model: run.model,
        resumeSessionId: this.sessionId,
        ...runSettings,
        worktreeName: useWorktree ? this.worktreeName : undefined,
        addDirs: addDirs.length ? addDirs : undefined,
        switchViaPlan: switchViaPlan || undefined,
      },
      (ev) => {
        run.events.push(ev);
        if (ev.kind === 'init' && !this.sessionId) {
          this.sessionId = ev.sessionId;
        }
        if (ev.kind === 'worktree' && ev.path !== this.worktreePath) {
          this.worktreePath = ev.path;
          this.events.onTabUpdated(this);
        }
        if (ev.kind === 'modeSwitched' && (ev.to === 'agent' || ev.to === 'ask' || ev.to === 'plan')) {
          this.sessionMode = ev.to;
        }
        if (ev.kind === 'toolCompleted' && !ev.tool.error && (ev.tool.uiKind === 'edit' || ev.tool.uiKind === 'delete')) {
          const p = (ev.tool.result?.path as string | undefined) || (ev.tool.args.path as string | undefined);
          if (p && this.cwd) touched.add(pathKey(this.cwd, p));
        }
        this.events.onRunEvent(this, run, ev);
      },
    );
    this.events.onTabUpdated(this);
    // ask/plan are applied by --mode. Agent mode on a resumed plan/ask session only takes
    // effect once the agent calls switchMode (handled in the event callback above).
    if (run.mode !== 'agent' || !this.sessionMode) this.sessionMode = run.mode;
    const outcome = await active.handle.done;
    // The in-run SwitchMode is not saved: the chat is stored in Plan mode now.
    if (switchViaPlan) this.sessionMode = 'plan';
    if (ckpt && preSha) {
      // Diff even after errors/stops: the agent may have changed files before failing.
      try {
        const postSha = await ckpt.snapshot(`post:${this.id}:${run.id}`);
        const files = await ckpt.diff(preSha, postSha);
        // Files another overlapping tab's run edited (and this run didn't) are flagged.
        const foreign = overlap?.foreignPaths(this, run) ?? new Set<string>();
        run.changes = {
          status: 'ready',
          preSha,
          postSha,
          files: files.map((f) => {
            const isForeign = foreign.has(pathKey(this.cwd!, f.path)) && !touched.has(pathKey(this.cwd!, f.path));
            return { ...f, state: 'pending' as const, ...(isForeign ? { foreign: true } : {}) };
          }),
        };
      } catch (e) {
        run.changes = {
          status: 'unavailable',
          preSha,
          files: [],
          message: `Could not compute changes: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      this.events.onRunChanges(this, run);
    }
    if (run.mode === 'agent') overlap?.agentRunEnded(this, run);
    this.finish(run, outcome);
  }

  /** Attach a warning to a run (e.g. overlapping Agent runs). */
  addWarning(run: RunRecord, text: string): void {
    run.warnings = [...(run.warnings ?? []).filter((w) => w !== text), text];
    this.events.onRunWarnings(this, run);
  }

  findRun(runId: string): RunRecord | undefined {
    return this.transcript.find((i): i is RunRecord => i.role === 'run' && i.id === runId);
  }

  private finish(run: RunRecord, outcome: RunOutcome): void {
    if (outcome.sessionId) this.sessionId = outcome.sessionId;
    run.status = outcome.status;
    run.outcome = outcome;
    run.endedAt = Date.now();
    // Merge streamed deltas: same rendering, far smaller history files.
    run.events = compactEvents(run.events);
    this.updatedAt = Date.now();
    if (this.active?.run === run) this.active = undefined;
    this.events.onRunFinished(this, run, outcome);
    this.events.onTabUpdated(this);
  }

  lastUserMessage(): UserMessage | undefined {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const item = this.transcript[i]!;
      if (item.role === 'user') return item;
    }
    return undefined;
  }

  /** Fail a queued run before it starts (e.g. CLI not available). */
  failQueued(message: string): void {
    const a = this.active;
    if (a && (!a.handle || a.handle === PENDING_HANDLE)) this.finish(a.run, { status: 'error', exitCode: null, stderrTail: [], message });
  }

  /** Stop the active run (or drop it from the queue). */
  stop(): void {
    const a = this.active;
    if (!a) return;
    if (a.handle && a.handle !== PENDING_HANDLE) a.handle.stop();
    else this.finish(a.run, { status: 'stopped', exitCode: null, stderrTail: [] });
  }
}
