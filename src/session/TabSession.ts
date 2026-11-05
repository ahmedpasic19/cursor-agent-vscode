import type { AgentBackend, RunHandle } from '../backend/AgentBackend';
import type { AgentEvent, Mode, RunOutcome } from '../shared/events';
import type { RunRecord, TabSnapshot, TranscriptItem, UserMessage } from '../shared/protocol';
import { buildPrompt, titleFrom } from './promptBuilder';

let counter = 0;
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export interface RunSettings {
  partialOutput: boolean;
  extraArgs: string[];
  postResultGraceMs: number;
  timeoutMs: number;
}

export interface TabEvents {
  onRunStarted(tab: TabSession, user: UserMessage, run: RunRecord): void;
  onRunEvent(tab: TabSession, run: RunRecord, ev: AgentEvent): void;
  onRunFinished(tab: TabSession, run: RunRecord, outcome: RunOutcome): void;
  onTabUpdated(tab: TabSession): void;
}

/** One chat tab: its CLI session, transcript, and at most one active run. */
export class TabSession {
  readonly id = newId('tab');
  title = 'New chat';
  private titled = false;
  sessionId?: string;
  /** Mode the CLI session is currently in (sticky across --resume). */
  sessionMode?: Mode;
  mode: Mode;
  model?: string;
  readonly transcript: TranscriptItem[] = [];
  private active?: { run: RunRecord; handle?: RunHandle };

  constructor(
    readonly cwd: string | undefined,
    mode: Mode,
    model: string | undefined,
    private readonly events: TabEvents,
  ) {
    this.mode = mode;
    this.model = model;
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
      transcript: this.transcript,
    };
  }

  /**
   * Adds the user message and a queued run record. The run starts when `start()` is
   * called (the SessionManager decides when, to honor the concurrency limit).
   */
  enqueue(text: string, mode: Mode, model: string | undefined): RunRecord {
    if (this.active) throw new Error('A run is already active in this tab');
    this.mode = mode;
    this.model = model || undefined;
    if (!this.titled) {
      this.title = titleFrom(text);
      this.titled = true;
    }
    const user: UserMessage = { id: newId('msg'), role: 'user', text, mode, at: Date.now() };
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
  async start(backend: AgentBackend, settings: RunSettings): Promise<void> {
    const active = this.active;
    if (!active || active.handle) return;
    const run = active.run;
    const user = this.transcript[this.transcript.length - 2] as UserMessage;

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
    const prompt = buildPrompt({
      text: user.text,
      mode: run.mode,
      sessionMode: this.sessionId ? this.sessionMode : undefined,
    });

    active.handle = backend.run(
      {
        cwd: this.cwd,
        prompt,
        mode: run.mode,
        model: run.model,
        resumeSessionId: this.sessionId,
        ...settings,
      },
      (ev) => {
        run.events.push(ev);
        if (ev.kind === 'init' && !this.sessionId) {
          this.sessionId = ev.sessionId;
        }
        if (ev.kind === 'modeSwitched' && (ev.to === 'agent' || ev.to === 'ask' || ev.to === 'plan')) {
          this.sessionMode = ev.to;
        }
        this.events.onRunEvent(this, run, ev);
      },
    );
    this.events.onTabUpdated(this);
    // ask/plan are applied by --mode. Agent mode on a resumed plan/ask session only takes
    // effect once the agent calls switchMode (handled in the event callback above).
    if (run.mode !== 'agent' || !this.sessionMode) this.sessionMode = run.mode;
    const outcome = await active.handle.done;
    this.finish(run, outcome);
  }

  private finish(run: RunRecord, outcome: RunOutcome): void {
    if (outcome.sessionId) this.sessionId = outcome.sessionId;
    run.status = outcome.status;
    run.outcome = outcome;
    run.endedAt = Date.now();
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
    if (a && !a.handle) this.finish(a.run, { status: 'error', exitCode: null, stderrTail: [], message });
  }

  /** Stop the active run (or drop it from the queue). */
  stop(): void {
    const a = this.active;
    if (!a) return;
    if (a.handle) a.handle.stop();
    else this.finish(a.run, { status: 'stopped', exitCode: null, stderrTail: [] });
  }
}
