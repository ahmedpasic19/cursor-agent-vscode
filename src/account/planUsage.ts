/**
 * Cursor plan usage, the same numbers the CLI's interactive `/usage` screen shows (Included,
 * Auto, API, On-Demand). The CLI has no headless command for it, so we call the endpoint it uses,
 * `aiserver.v1.DashboardService/GetCurrentPeriodUsage`, with the token the CLI stored at login.
 * This is an undocumented API: every field is optional and any failure falls back to a
 * dashboard link in the UI.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PlanUsage } from '../shared/protocol';

const ENDPOINT = 'https://api2.cursor.sh/aiserver.v1.DashboardService';
const CACHE_MS = 60_000;

/** Where the CLI keeps `auth.json` ({ accessToken, refreshToken }) on each platform. */
export function authFileCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string[] {
  const out: string[] = [];
  if (platform === 'win32' && env.APPDATA) out.push(join(env.APPDATA, 'Cursor', 'auth.json'));
  if (platform === 'darwin') out.push(join(home, 'Library', 'Application Support', 'Cursor', 'auth.json'));
  out.push(join(env.XDG_CONFIG_HOME || join(home, '.config'), 'cursor', 'auth.json'));
  out.push(join(home, '.cursor', 'auth.json'));
  return out;
}

/** The CLI's access token, or undefined when it has not logged in (or stores it elsewhere). */
export function readCliToken(files = authFileCandidates()): string | undefined {
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8')) as { accessToken?: unknown };
      if (typeof j.accessToken === 'string' && j.accessToken) return j.accessToken;
    } catch {
      // missing or unreadable: try the next one
    }
  }
  return undefined;
}

type Json = Record<string, unknown>;
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

/** Map the RPC responses to what the panel shows. Exported for tests. */
export function toPlanUsage(period: Json, plan?: Json): PlanUsage {
  const pu = (period.planUsage ?? {}) as Json;
  const sl = (period.spendLimitUsage ?? {}) as Json;
  const limit = num(sl.individualLimit) ?? num(sl.pooledLimit);
  const used = num(sl.individualUsed) ?? num(sl.pooledUsed);
  const info = (plan?.planInfo ?? {}) as Json;
  return {
    planName: typeof info.planName === 'string' ? info.planName : undefined,
    includedPct: num(pu.totalPercentUsed),
    autoPct: num(pu.autoPercentUsed),
    apiPct: num(pu.apiPercentUsed),
    onDemand: limit && limit > 0 ? { enabled: true, usedCents: used ?? 0, limitCents: limit } : { enabled: false },
    cycleEnd: num(period.billingCycleEnd),
    message: typeof period.autoModelSelectedDisplayMessage === 'string' ? period.autoModelSelectedDisplayMessage : undefined,
  };
}

async function call(method: string, token: string, signal: AbortSignal): Promise<Json> {
  const r = await fetch(`${ENDPOINT}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    body: '{}',
    signal,
  });
  if (r.status === 401 || r.status === 403) throw new Error('auth');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as Json;
}

export type PlanUsageResult = { ok: true; usage: PlanUsage } | { ok: false; reason: 'noToken' | 'auth' | 'error'; message?: string };

export class PlanUsageService {
  private cache?: { at: number; result: PlanUsageResult };
  private pending?: Promise<PlanUsageResult>;

  /** `apiKey` is tried when the CLI has no stored login (CLI + API key setup). */
  constructor(private readonly apiKey: () => Promise<string | undefined>, private readonly log: (m: string) => void) {}

  async get(force = false): Promise<PlanUsageResult> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.result;
    this.pending ??= this.fetch().finally(() => (this.pending = undefined));
    const result = await this.pending;
    this.cache = { at: Date.now(), result };
    return result;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private async fetch(): Promise<PlanUsageResult> {
    const tokens = [readCliToken(), await this.apiKey()].filter((t): t is string => !!t);
    if (!tokens.length) return { ok: false, reason: 'noToken' };
    let last: PlanUsageResult = { ok: false, reason: 'error' };
    for (const token of tokens) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10_000);
      try {
        const [period, plan] = await Promise.all([
          call('GetCurrentPeriodUsage', token, ctl.signal),
          call('GetPlanInfo', token, ctl.signal).catch(() => undefined),
        ]);
        return { ok: true, usage: toPlanUsage(period, plan) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        last = msg === 'auth' ? { ok: false, reason: 'auth' } : { ok: false, reason: 'error', message: msg };
        this.log(`[usage] plan usage request failed: ${msg}`);
      } finally {
        clearTimeout(timer);
      }
    }
    return last;
  }
}
