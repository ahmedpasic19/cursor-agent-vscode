/**
 * CLI probing: version, supported flags (from --help), auth status, model list.
 * Results are cached per CLI version by the caller.
 */
import type { CliInfo } from './cliLocator';
import { runCliCapture } from './processUtil';

export interface CliCapabilities {
  version: string;
  flags: Set<string>;
}

export function parseHelpFlags(help: string): Set<string> {
  const flags = new Set<string>();
  for (const m of help.matchAll(/(?:^|[\s,])(--[a-z][a-z0-9-]*)/gm)) flags.add(m[1]!);
  for (const m of help.matchAll(/(?:^|\s)(-[a-zA-Z])(?=[,\s])/gm)) flags.add(m[1]!);
  return flags;
}

export interface ModelInfo {
  id: string;
  label: string;
  isDefault: boolean;
}

/** Parses `cursor-agent models` text output (docs/CLI_NOTES.md §4). */
export function parseModels(text: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[​-‍﻿]/g, '').trim();
    const m = /^(\S+) - (.+?)(\s+\((current(?:, default)?|default)\))?$/.exec(line);
    if (!m) continue;
    out.push({ id: m[1]!, label: m[2]!.trim(), isDefault: !!m[3] });
  }
  return out;
}

export async function probeVersion(cli: CliInfo, cwd: string): Promise<string | undefined> {
  const r = await runCliCapture(cli, ['--version'], cwd, 20000);
  return r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : undefined;
}

export async function probeCapabilities(cli: CliInfo, cwd: string, version: string): Promise<CliCapabilities> {
  const r = await runCliCapture(cli, ['--help'], cwd, 20000);
  return { version, flags: parseHelpFlags(r.stdout) };
}

export type AuthResult =
  | { state: 'ready'; email?: string }
  | { state: 'notLoggedIn'; message?: string }
  | { state: 'error'; message: string };

export async function probeAuth(cli: CliInfo, cwd: string): Promise<AuthResult> {
  const r = await runCliCapture(cli, ['status', '--format', 'json'], cwd, 30000);
  if (r.error) return { state: 'error', message: r.error };
  try {
    const j = JSON.parse(r.stdout) as { isAuthenticated?: boolean; userInfo?: { email?: string } };
    if (j.isAuthenticated === true) return { state: 'ready', email: j.userInfo?.email };
    return { state: 'notLoggedIn' };
  } catch {
    if (/not (logged|signed) in|login/i.test(r.stdout + r.stderr)) return { state: 'notLoggedIn' };
    return { state: 'error', message: (r.stderr || r.stdout).trim().slice(0, 500) || `status exited ${r.code}` };
  }
}

/** `about --format json` (docs/CLI_NOTES.md §4). Unknown or missing fields are left out. */
export interface AboutInfo {
  tier?: string;
  model?: string;
  email?: string;
  cliVersion?: string;
  latestVersion?: string;
  /** `up_to_date` or another status string from the CLI. */
  latestStatus?: string;
}

export function parseAbout(stdout: string): AboutInfo | undefined {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    const str = (k: string) => (typeof j[k] === 'string' && (j[k] as string).trim() ? (j[k] as string).trim() : undefined);
    return {
      tier: str('subscriptionTier'),
      model: str('model'),
      email: str('userEmail'),
      cliVersion: str('cliVersion'),
      latestVersion: str('latestVersion'),
      latestStatus: str('latestStatus'),
    };
  } catch {
    return undefined;
  }
}

export async function probeAbout(cli: CliInfo, cwd: string): Promise<AboutInfo | undefined> {
  const r = await runCliCapture(cli, ['about', '--format', 'json'], cwd, 30000);
  return r.code === 0 ? parseAbout(r.stdout) : undefined;
}

export async function probeModels(cli: CliInfo, cwd: string): Promise<ModelInfo[]> {
  const r = await runCliCapture(cli, ['models'], cwd, 30000);
  return r.code === 0 ? parseModels(r.stdout) : [];
}
