import { tmpdir } from 'node:os';
import type { CliStatus } from '../shared/protocol';
import { CliBackend, type Logger } from './CliBackend';
import { type CliCapabilities, probeAuth, probeCapabilities, probeVersion } from './cliCapabilities';
import { type CliInfo, locateCli } from './cliLocator';

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
    const auth = await probeAuth(this.cli, cwd);
    if (auth.state === 'ready') return this.set({ state: 'ready', version, email: auth.email });
    if (auth.state === 'notLoggedIn') {
      return this.set({ state: 'notLoggedIn', version, message: 'Not logged in. Run `cursor-agent login`.' });
    }
    return this.set({ state: 'error', version, message: auth.message });
  }

  /** A backend for the next run, or an error message for the UI. */
  backend(): CliBackend | string {
    if (!this.cli) return this.status.message ?? 'cursor-agent CLI is not available yet.';
    // Empty flag set (failed --help) means "unknown": don't filter flags.
    const caps = this.caps?.flags.size ? this.caps : undefined;
    return new CliBackend(this.cli, this.log, caps);
  }
}
