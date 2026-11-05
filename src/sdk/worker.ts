/**
 * SDK worker: runs one request against @cursor/sdk in its own Node process (Node >= 22.13).
 * Bundled to dist/sdk-worker.cjs; @cursor/sdk itself is loaded from CURSOR_SDK_DIR at runtime
 * (installed on demand), because it ships native binaries that can't be bundled.
 *
 * stdin:  one WorkerRequest JSON line, then optionally {"op":"cancel"}
 * stdout: WorkerMessage NDJSON lines
 * The API key comes from CURSOR_API_KEY (environment only — never argv or stdin).
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { WorkerMessage, WorkerRequest } from './workerProtocol';

function out(msg: WorkerMessage): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function fail(e: unknown): never {
  const err = e as { name?: string; message?: string; constructor?: { name?: string } };
  // SDK error classes often keep name === 'Error', so fall back to the class name.
  const name = err?.name && err.name !== 'Error' ? err.name : (err?.constructor?.name ?? 'Error');
  out({ t: 'error', name, message: err?.message ?? String(e) });
  process.exit(1);
}

interface SdkModule {
  Agent: {
    create(o: Record<string, unknown>): Promise<SdkAgent>;
    resume(id: string, o: Record<string, unknown>): Promise<SdkAgent>;
  };
  Cursor: { models: { list(o?: Record<string, unknown>): Promise<unknown[]> } };
}
interface SdkAgent {
  agentId: string;
  model?: { id: string };
  send(text: string, o: Record<string, unknown>): Promise<SdkRun>;
  close(): void;
}
interface SdkRun {
  wait(): Promise<{
    status: 'finished' | 'error' | 'cancelled';
    result?: string;
    error?: { message: string; code?: string };
    durationMs?: number;
    usage?: Record<string, number>;
  }>;
  cancel(): Promise<void>;
}

function loadSdk(): SdkModule {
  const dir = process.env.CURSOR_SDK_DIR;
  if (!dir) throw Object.assign(new Error('CURSOR_SDK_DIR is not set'), { name: 'SdkNotInstalled' });
  try {
    return createRequire(join(dir, 'package.json'))('@cursor/sdk') as SdkModule;
  } catch (e) {
    // First line only: Node appends a multi-line "Require stack".
    const reason = String((e as Error).message).split('\n')[0];
    throw Object.assign(new Error(`@cursor/sdk is not installed in ${dir} (${reason})`), { name: 'SdkNotInstalled' });
  }
}

const lines = createInterface({ input: process.stdin });
let first = true;
let run: SdkRun | undefined;
let cancelRequested = false;

lines.on('line', (line) => {
  if (!line.trim()) return;
  let req: WorkerRequest;
  try {
    req = JSON.parse(line) as WorkerRequest;
  } catch {
    return;
  }
  if (req.op === 'cancel') {
    cancelRequested = true;
    void run?.cancel().catch(() => undefined);
    return;
  }
  if (!first) return;
  first = false;
  void handle(req).catch(fail);
});

async function handle(req: WorkerRequest): Promise<void> {
  const sdk = loadSdk();
  const apiKey = process.env.CURSOR_API_KEY;

  if (req.op === 'models') {
    const list = (await sdk.Cursor.models.list({ apiKey })) as {
      model?: { id?: string };
      id?: string;
      displayName?: string;
      name?: string;
      isDefault?: boolean;
    }[];
    const models = list
      .map((m) => ({ id: m.model?.id ?? m.id ?? '', label: m.displayName ?? m.name ?? m.model?.id ?? m.id ?? '', isDefault: m.isDefault }))
      .filter((m) => m.id);
    out({ t: 'models', models });
    process.exit(0);
  }

  if (req.op !== 'run') return;
  const options = {
    apiKey,
    model: { id: req.model },
    mode: req.mode,
    ...(req.tools ? { tools: req.tools } : {}),
    local: { cwd: req.cwd },
  };
  const agent = req.agentId ? await sdk.Agent.resume(req.agentId, options) : await sdk.Agent.create(options);
  out({ t: 'agent', agentId: agent.agentId, model: agent.model?.id ?? req.model, resumed: !!req.agentId });
  if (cancelRequested) {
    out({ t: 'done', result: { status: 'cancelled' } });
    process.exit(0);
  }
  run = await agent.send(req.prompt, {
    mode: req.mode,
    model: { id: req.model },
    onDelta: ({ update }: { update: unknown }) => out({ t: 'delta', update }),
  });
  if (cancelRequested) void run.cancel().catch(() => undefined);
  const result = await run.wait();
  out({
    t: 'done',
    result: {
      status: result.status,
      result: result.result,
      error: result.error,
      durationMs: result.durationMs,
      usage: result.usage,
    },
  });
  try {
    agent.close();
  } catch {
    /* ignore */
  }
  // Let stdout drain, then exit (the SDK may keep handles open).
  setTimeout(() => process.exit(0), 50);
}
