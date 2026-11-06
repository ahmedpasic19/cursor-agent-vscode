import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { CliInfo } from './cliLocator';
import { quoteCmdArg } from './cliLocator';

/** Kill a process and all its descendants. Resolves when the kill command finishes. */
export function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return Promise.resolve();
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      resolve();
    }
  });
}

/**
 * Extra environment for every CLI process. The "CLI + API key" setup puts CURSOR_API_KEY here
 * (env, not --api-key, so the key never shows up in process listings or logs).
 */
let authEnv: Record<string, string> = {};
export function setCliAuthEnv(env: Record<string, string>): void {
  authEnv = env;
}

export function spawnCli(cli: CliInfo, args: string[], cwd: string): ChildProcess {
  const env = { ...process.env, ...(cli.env ?? {}), ...authEnv };
  if (cli.shell) {
    const line = [cli.command, ...cli.prefixArgs, ...args].map(quoteCmdArg).join(' ');
    return spawn(line, { cwd, env, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return spawn(cli.command, [...cli.prefixArgs, ...args], {
    cwd,
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Run the CLI to completion and capture output (for --version, status, models). */
export function runCliCapture(
  cli: CliInfo,
  args: string[],
  cwd: string,
  timeoutMs = 30000,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnCli(cli, args, cwd);
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', error: String(e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.stdin?.end();
    const timer = setTimeout(() => void killTree(child.pid), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
