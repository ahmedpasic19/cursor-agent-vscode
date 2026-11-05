import * as vscode from 'vscode';
import type { CliStatus } from './shared/protocol';

/** "Cursor: ●" plus the number of running tabs; click focuses the chat (PLAN.md §5.9). */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private cli: CliStatus = { state: 'checking' };
  private running = 0;

  constructor() {
    this.item.command = 'cursorAgent.focusChat';
    this.render();
    this.item.show();
  }

  setCli(cli: CliStatus): void {
    this.cli = cli;
    this.render();
  }

  setRunning(n: number): void {
    if (n === this.running) return;
    this.running = n;
    this.render();
  }

  private render(): void {
    const { state } = this.cli;
    const problem = state === 'notFound' || state === 'notLoggedIn' || state === 'error' || state === 'sdkNotInstalled' || state === 'noApiKey';
    const label = this.cli.backend === 'sdk' ? 'Cursor SDK' : 'Cursor';
    if (this.running > 0) {
      this.item.text = `$(sync~spin) ${label}: ● ${this.running}`;
    } else if (problem) {
      this.item.text = `$(warning) ${label}`;
    } else if (state === 'checking') {
      this.item.text = `${label}: ○`;
    } else {
      this.item.text = `${label}: ●`;
    }
    this.item.backgroundColor = problem ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const lines = [
      state === 'ready'
        ? `Cursor Agent ready${this.cli.version ? ` (${this.cli.backend === 'sdk' ? this.cli.version : `CLI ${this.cli.version}`})` : ''}${this.cli.email ? ` — ${this.cli.email}` : ''}`
        : state === 'checking'
          ? 'Checking Cursor Agent CLI…'
          : (this.cli.message ?? `Cursor Agent: ${state}`),
      this.running ? `${this.running} run${this.running === 1 ? '' : 's'} in progress` : '',
      'Click to focus the chat',
    ].filter(Boolean);
    this.item.tooltip = lines.join('\n');
  }

  dispose(): void {
    this.item.dispose();
  }
}
