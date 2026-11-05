import type { ChildProcess } from 'node:child_process';
import type { AgentEvent, RunOutcome } from '../shared/events';
import { CursorStreamParser } from '../parser/cursorStreamJson';
import type { AgentBackend, RunHandle, RunOptions } from './AgentBackend';
import type { CliCapabilities } from './cliCapabilities';
import type { CliInfo } from './cliLocator';
import { LineReader, RingBuffer } from './lineReader';
import { killTree, spawnCli } from './processUtil';

export type Logger = (line: string) => void;

/** Builds the headless argv for one run (docs/CLI_NOTES.md §2). */
export function buildArgs(opts: RunOptions, caps?: CliCapabilities): string[] {
  const has = (flag: string) => !caps || caps.flags.has(flag);
  const args = ['-p', '--trust', '--output-format', 'stream-json'];
  if (opts.partialOutput && has('--stream-partial-output')) args.push('--stream-partial-output');
  args.push('--workspace', opts.cwd);
  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  if (opts.mode === 'agent') args.push('--force');
  else if (has('--mode')) args.push('--mode', opts.mode);
  args.push(...opts.extraArgs);
  return args;
}

export class CliBackend implements AgentBackend {
  constructor(
    private readonly cli: CliInfo,
    private readonly log: Logger = () => {},
    private readonly caps?: CliCapabilities,
  ) {}

  run(opts: RunOptions, onEvent: (ev: AgentEvent) => void): RunHandle {
    const args = buildArgs(opts, this.caps);
    const partial = args.includes('--stream-partial-output');
    const parser = new CursorStreamParser({ partialOutput: partial });
    const stderr = new RingBuffer(200);

    let child: ChildProcess | undefined;
    let sessionId: string | undefined;
    let gotResult: Extract<AgentEvent, { kind: 'result' }> | undefined;
    let stopped = false;
    let timedOut = false;
    let killedAfterResult = false;
    let settled = false;
    let resolveDone!: (o: RunOutcome) => void;
    const done = new Promise<RunOutcome>((r) => (resolveDone = r));
    const timers: NodeJS.Timeout[] = [];

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      const tail = stderr.toArray();
      let outcome: RunOutcome;
      if (gotResult && !stopped) {
        outcome = {
          status: gotResult.isError ? 'error' : 'success',
          exitCode,
          stderrTail: tail,
          sessionId,
          message: gotResult.isError ? (gotResult.text ?? tail.find((l) => l.trim())) : undefined,
        };
      } else if (stopped) {
        outcome = { status: 'stopped', exitCode, stderrTail: tail, sessionId };
      } else if (timedOut) {
        outcome = { status: 'timeout', exitCode, stderrTail: tail, sessionId, message: 'Run timed out' };
      } else {
        outcome = {
          status: 'error',
          exitCode,
          stderrTail: tail,
          sessionId,
          message:
            spawnError ??
            tail.find((l) => l.trim()) ??
            `cursor-agent exited with code ${exitCode} before sending a result`,
        };
      }
      this.log(
        `[run] done status=${outcome.status} exit=${exitCode}${killedAfterResult ? ' (killed after result grace)' : ''}`,
      );
      resolveDone(outcome);
    };

    const kill = () => {
      const pid = child?.pid;
      void killTree(pid).then(() => {
        // If 'close' never fires (pipes held open by a stray grandchild), settle anyway.
        timers.push(setTimeout(() => finish(child?.exitCode ?? null), 1500));
      });
    };

    const emit = (ev: AgentEvent) => {
      if (settled) return;
      if (ev.kind === 'init') sessionId = ev.sessionId;
      if (ev.kind === 'result') {
        if (gotResult) return;
        gotResult = ev;
        sessionId = ev.sessionId ?? sessionId;
        // Hang workaround: the process should exit on its own shortly after `result`.
        timers.push(
          setTimeout(() => {
            if (child && child.exitCode === null && child.signalCode === null) {
              killedAfterResult = true;
              kill();
            }
          }, opts.postResultGraceMs),
        );
      }
      try {
        onEvent(ev);
      } catch (e) {
        this.log(`[run] onEvent threw: ${String(e)}`);
      }
    };

    this.log(`[run] spawn ${this.cli.display}`);
    this.log(`[run] args ${JSON.stringify(args)}`);
    this.log(`[run] cwd ${opts.cwd}`);
    this.log(`[run] prompt (${opts.prompt.length} chars):\n${opts.prompt}`);

    try {
      child = spawnCli(this.cli, args, opts.cwd);
    } catch (e) {
      queueMicrotask(() => finish(null, `Failed to start cursor-agent: ${String(e)}`));
      return { done, stop: () => {} };
    }

    const out = new LineReader((line) => {
      for (const ev of parser.parseLine(line)) {
        if (ev.kind === 'unknown') this.log(`[run] unknown event: ${line.slice(0, 500)}`);
        emit(ev);
      }
    });
    const err = new LineReader((line) => {
      stderr.push(line);
      this.log(`[stderr] ${line}`);
    });
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stdout?.on('end', () => out.end());
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.stderr?.on('end', () => err.end());
    child.stdin?.on('error', (e) => this.log(`[run] stdin error: ${e.message}`));
    child.on('error', (e) => finish(null, `Failed to start cursor-agent: ${e.message}`));
    child.on('close', (code) => finish(code));

    child.stdin?.end(opts.prompt, 'utf8');

    timers.push(
      setTimeout(() => {
        timedOut = true;
        this.log('[run] hard timeout reached; killing');
        kill();
      }, opts.timeoutMs),
    );

    return {
      done,
      stop: () => {
        if (settled || stopped) return;
        stopped = !gotResult;
        this.log('[run] stop requested');
        kill();
      },
    };
  }
}
