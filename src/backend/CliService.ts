import { tmpdir } from 'node:os';
import type { CliStatus } from '../shared/protocol';
import { CliBackend, type Logger } from './CliBackend';
import { type AboutInfo, type CliCapabilities, type ModelInfo, probeAbout, probeAuth, probeCapabilities, probeModels, probeVersion } from './cliCapabilities';
import { type CliInfo, locateCli } from './cliLocator';
import { runCliCapture } from './processUtil';

/** Locates and probes the CLI; caches capabilities per version. */
export class CliService {
  private cli?: CliInfo;
  private caps?: CliCapabilities;
  status: CliStatus = { state: 'checking' };
  private refreshing?: Promise<CliStatus>;

  constructor(
    private readonly getConfiguredPath: () => string,
    private readonly log: Logger,
    private readonly capsCache: {
      get(version: string): string[] | undefined;
      set(version: string, flags: string[]): void;
    },
    private readonly onStatus: (s: CliStatus) => void,
  ) {}

  refresh(): Promise<CliStatus> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private set(s: CliStatus): CliStatus {
    this.status = s;
    this.onStatus(s);
    return s;
  }

  private async doRefresh(): Promise<CliStatus> {
    this.set({ state: 'checking' });
    const configured = this.getConfiguredPath();
    this.cli = locateCli(configured);
    if (!this.cli) {
      this.log(`[cli] not found (cliPath setting: ${JSON.stringify(configured)})`);
      return this.set({
        state: 'notFound',
        message: configured
          ? `cursor-agent not found at ${configured}`
          : 'cursor-agent not found. Install it (https://cursor.com/cli) or set cursorAgent.cliPath.',
      });
    }
    this.log(`[cli] using ${this.cli.display} (${this.cli.source})`);
    const cwd = tmpdir();
    const version = await probeVersion(this.cli, cwd);
    if (!version) {
      return this.set({ state: 'error', message: `Could not run ${this.cli.display} --version` });
    }
    const cached = this.capsCache.get(version);
    if (cached) {
      this.caps = { version, flags: new Set(cached) };
    } else {
      this.caps = await probeCapabilities(this.cli, cwd, version);
      if (this.caps.flags.size) this.capsCache.set(version, [...this.caps.flags]);
    }
    this.log(`[cli] version ${version}, ${this.caps.flags.size} flags`);
    const f = this.caps.flags;
    const known = f.size > 0; // failed --help → assume everything is supported
    const features = {
      modes: !known || f.has('--mode'),
      partialOutput: !known || f.has('--stream-partial-output'),
      worktree: !known || f.has('--worktree'),
    };
    const auth = await probeAuth(this.cli, cwd);
    if (auth.state === 'ready') return this.set({ state: 'ready', version, email: auth.email, features });
    if (auth.state === 'notLoggedIn') {
      return this.set({ state: 'notLoggedIn', version, features, message: 'Not logged in. Run `cursor-agent login`.' });
    }
    return this.set({ state: 'error', version, features, message: auth.message });
  }

  private modelCache?: { version: string; models: ModelInfo[] };

  /** `cursor-agent models`, cached per CLI version; [] if unavailable. */
  async models(force = false): Promise<ModelInfo[]> {
    if (this.refreshing) await this.refreshing;
    if (!this.cli || this.status.state !== 'ready') return [];
    const version = this.status.version ?? '';
    if (!force && this.modelCache?.version === version) return this.modelCache.models;
    const models = await probeModels(this.cli, tmpdir());
    this.log(`[cli] ${models.length} models`);
    if (models.length) this.modelCache = { version, models };
    return models;
  }

  /** Failures are cached too, so a CLI without `about` isn't spawned on every account refresh. */
  private aboutCache?: { version: string; info?: AboutInfo };
  private aboutPending?: Promise<AboutInfo | undefined>;

  /** `about --format json` (tier, default model), cached per CLI version unless forced. */
  async about(force = false): Promise<AboutInfo | undefined> {
    if (this.refreshing) await this.refreshing;
    if (!this.cli || this.status.state !== 'ready') return undefined;
    const version = this.status.version ?? '';
    if (!force && this.aboutCache?.version === version) return this.aboutCache.info;
    if (this.aboutPending) return this.aboutPending;
    const cli = this.cli;
    this.aboutPending = probeAbout(cli, tmpdir())
      .then((info) => {
        this.aboutCache = { version, info };
        if (!info) this.log('[cli] about --format json failed; plan tier unavailable');
        return info;
      })
      .finally(() => (this.aboutPending = undefined));
    return this.aboutPending;
  }

  /** `cursor-agent logout`, then re-probe. Returns an error message on failure. */
  async logout(): Promise<string | undefined> {
    if (!this.cli) return this.status.message ?? 'cursor-agent CLI is not available.';
    const r = await runCliCapture(this.cli, ['logout'], tmpdir(), 30000);
    this.aboutCache = undefined;
    await this.refresh();
    return r.code === 0 ? undefined : (r.error ?? (r.stderr || r.stdout).trim().slice(0, 300)) || `logout exited ${r.code}`;
  }

  /** Run `cursor-agent <args>` to completion (MCP / plugin management). */
  async exec(args: string[], cwd: string, timeoutMs = 60000): Promise<{ ok: boolean; stdout: string; message?: string }> {
    if (this.refreshing) await this.refreshing;
    if (!this.cli) return { ok: false, stdout: '', message: this.status.message ?? 'cursor-agent CLI is not available.' };
    const r = await runCliCapture(this.cli, args, cwd, timeoutMs);
    if (r.code === 0) return { ok: true, stdout: r.stdout };
    const message = (r.error ?? (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400)) || `exited ${r.code}`;
    this.log(`[cli] ${args.join(' ')} failed: ${message}`);
    return { ok: false, stdout: r.stdout, message };
  }

  /** How to launch `cursor-agent <args>` in a terminal (shellPath + shellArgs, no quoting needed). */
  terminalLaunch(args: string[]): { shellPath: string; shellArgs: string[]; env?: Record<string, string> } | undefined {
    if (!this.cli || this.cli.shell) {
      return undefined; // caller falls back to typing the command into a normal terminal
    }
    return { shellPath: this.cli.command, shellArgs: [...this.cli.prefixArgs, ...args], env: this.cli.env };
  }

  /** A backend for the next run, or an error message for the UI. */
  backend(): CliBackend | string {
    if (!this.cli) return this.status.message ?? 'cursor-agent CLI is not available yet.';
    // Empty flag set (failed --help) means "unknown": don't filter flags.
    const caps = this.caps?.flags.size ? this.caps : undefined;
    return new CliBackend(this.cli, this.log, caps);
  }
}
