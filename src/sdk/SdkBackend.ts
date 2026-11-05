/**
 * AgentBackend over @cursor/sdk, run in a separate Node worker per run (PLAN.md Phase 7,
 * docs/SDK_NOTES.md). Same RunHandle contract as CliBackend: events stream, stop() kills,
 * done resolves with a RunOutcome.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentBackend, RunHandle, RunOptions } from '../backend/AgentBackend';
import { LineReader, RingBuffer } from '../backend/lineReader';
import { killTree } from '../backend/processUtil';
import type { AgentEvent, RunOutcome } from '../shared/events';
import { friendlySdkError, SdkEventMapper } from './sdkEvents';
import { ASK_MODE_TOOLS, type WorkerMessage, type WorkerRequest } from './workerProtocol';

export interface SdkWorkerConfig {
  /** Node executable (>= 22.13). */
  nodePath: string;
  /** Path to dist/sdk-worker.cjs. */
  workerPath: string;
  /** Folder whose node_modules holds @cursor/sdk. */
  sdkDir: string;
  apiKey: string;
  /** Model when the tab has none (local SDK agents require one). */
  defaultModel: string;
}

type Log = (line: string) => void;

/** Spawn the worker with the key in the environment only. */
export function spawnWorker(cfg: SdkWorkerConfig): ChildProcess {
  // --no-warnings: the SDK triggers Node's "SQLite is experimental" warning on every start.
  return spawn(cfg.nodePath, ['--no-warnings', cfg.workerPath], {
    env: { ...process.env, CURSOR_API_KEY: cfg.apiKey, CURSOR_SDK_DIR: cfg.sdkDir, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function buildRequest(opts: RunOptions, defaultModel: string): Extract<WorkerRequest, { op: 'run' }> {
  return {
    op: 'run',
    cwd: opts.cwd,
    prompt: opts.prompt,
    // The SDK has no ask mode: Ask = agent mode with a read-only tool allowlist (SDK-enforced).
    mode: opts.mode === 'plan' ? 'plan' : 'agent',
    ...(opts.mode === 'ask' ? { tools: ASK_MODE_TOOLS } : {}),
    model: opts.model || defaultModel,
    ...(opts.resumeSessionId ? { agentId: opts.resumeSessionId } : {}),
  };
}

export class SdkBackend implements AgentBackend {
  constructor(
    private readonly cfg: SdkWorkerConfig,
    private readonly log: Log = () => {},
  ) {}

  run(opts: RunOptions, onEvent: (ev: AgentEvent) => void): RunHandle {
    const req = buildRequest(opts, this.cfg.defaultModel);
    const mapper = new SdkEventMapper();
    const stderr = new RingBuffer(200);
    let sessionId: string | undefined;
    let finalResult: Extract<WorkerMessage, { t: 'done' }>['result'] | undefined;
    let workerError: string | undefined;
    let stopped = false;
    let timedOut = false;
    let settled = false;
    let resolveDone!: (o: RunOutcome) => void;
    const done = new Promise<RunOutcome>((r) => (resolveDone = r));
    const timers: NodeJS.Timeout[] = [];

    this.log(`[sdk] spawn ${this.cfg.nodePath} ${this.cfg.workerPath}`);
    this.log(`[sdk] request ${JSON.stringify({ ...req, prompt: `(${req.prompt.length} chars)` })}`);
    this.log(`[sdk] prompt:\n${req.prompt}`);

    let child: ChildProcess;
    try {
      child = spawnWorker(this.cfg);
    } catch (e) {
      queueMicrotask(() => finish(null, `Failed to start the SDK worker: ${String(e)}`));
      return { done, stop: () => {} };
    }

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      const tail = stderr.toArray();
      let outcome: RunOutcome;
      if (stopped || finalResult?.status === 'cancelled') {
        outcome = { status: 'stopped', exitCode, stderrTail: tail, sessionId };
      } else if (finalResult?.status === 'finished') {
        outcome = { status: 'success', exitCode, stderrTail: tail, sessionId };
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
            workerError ??
            finalResult?.error?.message ??
            tail.find((l) => l.trim()) ??
            `The SDK worker exited with code ${exitCode} before finishing`,
        };
      }
      this.log(`[sdk] done status=${outcome.status} exit=${exitCode}`);
      resolveDone(outcome);
    };

    const send = (r: WorkerRequest) => {
      try {
        child.stdin?.write(JSON.stringify(r) + '\n');
      } catch {
        /* closed */
      }
    };

    const out = new LineReader((line) => {
      if (!line.trim()) return;
      let msg: WorkerMessage;
      try {
        msg = JSON.parse(line) as WorkerMessage;
      } catch {
        this.log(`[sdk] non-JSON: ${line.slice(0, 300)}`);
        return;
      }
      if (msg.t === 'error') {
        workerError = friendlySdkError(msg.name, msg.message);
        return;
      }
      if (msg.t === 'log') {
        this.log(`[sdk-worker] ${msg.message}`);
        return;
      }
      if (msg.t === 'agent') sessionId = msg.agentId;
      if (msg.t === 'done') finalResult = msg.result;
      for (const ev of mapper.map(msg)) {
        if (ev.kind === 'unknown') this.log(`[sdk] unknown update: ${JSON.stringify(ev.raw).slice(0, 300)}`);
        if (settled) return;
        try {
          onEvent(ev);
        } catch (e) {
          this.log(`[sdk] onEvent threw: ${String(e)}`);
        }
      }
    });
    const err = new LineReader((line) => {
      stderr.push(line);
      this.log(`[sdk-stderr] ${line}`);
    });
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stdout?.on('end', () => out.end());
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.stderr?.on('end', () => err.end());
    child.stdin?.on('error', () => undefined);
    child.on('error', (e) => finish(null, `Failed to start the SDK worker (${this.cfg.nodePath}): ${e.message}`));
    child.on('close', (code) => finish(code));

    send(req);

    timers.push(
      setTimeout(() => {
        timedOut = true;
        send({ op: 'cancel' });
        void killTree(child.pid);
      }, opts.timeoutMs),
    );

    return {
      done,
      stop: () => {
        if (settled || stopped) return;
        stopped = true;
        this.log('[sdk] stop requested');
        // Ask the SDK to cancel cleanly, then make sure the worker is gone.
        send({ op: 'cancel' });
        timers.push(setTimeout(() => void killTree(child.pid).then(() => timers.push(setTimeout(() => finish(child.exitCode), 1000))), 800));
      },
    };
  }
}

/** One-shot worker call for the model catalog. */
export function listSdkModels(cfg: SdkWorkerConfig, timeoutMs = 30000): Promise<{ models: { id: string; label: string }[]; error?: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnWorker(cfg);
    } catch (e) {
      resolve({ models: [], error: String(e) });
      return;
    }
    let models: { id: string; label: string }[] = [];
    let error: string | undefined;
    const reader = new LineReader((line) => {
      try {
        const m = JSON.parse(line) as WorkerMessage;
        if (m.t === 'models') models = m.models;
        if (m.t === 'error') error = friendlySdkError(m.name, m.message);
      } catch {
        /* ignore */
      }
    });
    child.stdout?.on('data', (c: Buffer) => reader.push(c));
    const t = setTimeout(() => void killTree(child.pid), timeoutMs);
    child.on('error', (e) => resolve({ models: [], error: e.message }));
    child.on('close', () => {
      clearTimeout(t);
      reader.end();
      resolve({ models, error });
    });
    child.stdin?.end(JSON.stringify({ op: 'models' }) + '\n');
  });
}
