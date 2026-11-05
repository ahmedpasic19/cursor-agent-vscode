/**
 * Status and backend factory for the SDK backend: is @cursor/sdk installed, is Node new enough,
 * is there an API key. No vscode imports (the key comes from a callback backed by SecretStorage).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliStatus } from '../shared/protocol';
import { listSdkModels, SdkBackend, type SdkWorkerConfig } from './SdkBackend';

export const PINNED_SDK_VERSION = '1.3.1';
const MIN_NODE: [number, number] = [22, 13];

export interface SdkServiceDeps {
  sdkDir: string;
  workerPath: string;
  nodePath(): string;
  defaultModel(): string;
  getApiKey(): Promise<string | undefined>;
  log(line: string): void;
  onStatus(s: CliStatus): void;
}

export function parseNodeVersion(v: string): [number, number, number] | undefined {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function nodeVersionOk(v: [number, number, number]): boolean {
  return v[0] > MIN_NODE[0] || (v[0] === MIN_NODE[0] && v[1] >= MIN_NODE[1]);
}

export class SdkService {
  status: CliStatus = { state: 'checking', backend: 'sdk' };
  private apiKey?: string;
  private refreshing?: Promise<CliStatus>;
  private modelCache?: { id: string; label: string }[];

  constructor(private readonly deps: SdkServiceDeps) {}

  /** Folder whose node_modules holds @cursor/sdk. */
  get sdkDir(): string {
    return this.deps.sdkDir;
  }

  installedVersion(): string | undefined {
    const pkg = join(this.deps.sdkDir, 'node_modules', '@cursor', 'sdk', 'package.json');
    if (!existsSync(pkg)) return undefined;
    try {
      return (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version;
    } catch {
      return undefined;
    }
  }

  refresh(): Promise<CliStatus> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private set(s: Omit<CliStatus, 'backend'>): CliStatus {
    this.status = { ...s, backend: 'sdk', features: { modes: true, partialOutput: true, worktree: false } };
    this.deps.onStatus(this.status);
    return this.status;
  }

  private async doRefresh(): Promise<CliStatus> {
    this.set({ state: 'checking' });
    const node = await nodeVersion(this.deps.nodePath());
    if (!node) {
      return this.set({
        state: 'error',
        message: `Could not run Node (“${this.deps.nodePath()}”). The SDK backend needs Node ${MIN_NODE.join('.')}+; set cursorAgent.sdk.nodePath.`,
      });
    }
    if (!nodeVersionOk(node)) {
      return this.set({
        state: 'error',
        message: `Node ${node.join('.')} is too old for @cursor/sdk (needs ${MIN_NODE.join('.')}+). Install a newer Node or set cursorAgent.sdk.nodePath.`,
      });
    }
    const version = this.installedVersion();
    if (!version) {
      return this.set({ state: 'sdkNotInstalled', message: `@cursor/sdk is not installed yet (Node ${node.join('.')} OK).` });
    }
    this.apiKey = await this.deps.getApiKey();
    if (!this.apiKey) {
      return this.set({ state: 'noApiKey', version: `sdk ${version}`, message: 'The SDK backend needs a Cursor API key (billed by usage).' });
    }
    this.deps.log(`[sdk] ready: @cursor/sdk ${version}, node ${node.join('.')}`);
    return this.set({ state: 'ready', version: `sdk ${version}` });
  }

  private config(): SdkWorkerConfig | string {
    if (this.status.state !== 'ready' || !this.apiKey) return this.status.message ?? 'The SDK backend is not ready.';
    return {
      nodePath: this.deps.nodePath(),
      workerPath: this.deps.workerPath,
      sdkDir: this.deps.sdkDir,
      apiKey: this.apiKey,
      defaultModel: this.deps.defaultModel(),
    };
  }

  backend(): SdkBackend | string {
    const cfg = this.config();
    return typeof cfg === 'string' ? cfg : new SdkBackend(cfg, this.deps.log);
  }

  async models(force = false): Promise<{ id: string; label: string }[]> {
    if (this.refreshing) await this.refreshing;
    const cfg = this.config();
    if (typeof cfg === 'string') return [];
    if (this.modelCache && !force) return this.modelCache;
    const r = await listSdkModels(cfg);
    if (r.error) this.deps.log(`[sdk] models: ${r.error}`);
    if (r.models.length) this.modelCache = r.models;
    return r.models;
  }
}

function nodeVersion(nodePath: string): Promise<[number, number, number] | undefined> {
  return new Promise((resolve) => {
    execFile(nodePath, ['-v'], { windowsHide: true, timeout: 10_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (err, stdout) =>
      resolve(err ? undefined : parseNodeVersion(String(stdout))),
    );
  });
}
