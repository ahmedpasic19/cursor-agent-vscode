import { createContext, useContext } from 'react';

export interface TabCtx {
  tabId: string;
  cwd?: string;
  running: boolean;
}
export const TabContext = createContext<TabCtx>({ tabId: '', running: false });
export const useTab = () => useContext(TabContext);

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** Workspace-relative display path with forward slashes. */
export function relPath(p: string | undefined, cwd: string | undefined): string {
  if (!p) return '';
  let path = p.replace(/\\/g, '/');
  // CLI glob results look like ".\math.ts" or "../.\math.ts".
  path = path.replace(/^(\.\.\/)?\.\//, '');
  if (cwd) {
    const root = cwd.replace(/\\/g, '/').replace(/\/$/, '');
    if (path.toLowerCase().startsWith(root.toLowerCase() + '/')) path = path.slice(root.length + 1);
  }
  return path;
}

/** Absolute path for opening: joins relative paths onto cwd. */
export function absPath(p: string, cwd: string | undefined): string {
  const clean = p.replace(/^(\.\.[\\/])?\.[\\/]/, '');
  if (/^([a-zA-Z]:[\\/]|\/)/.test(clean) || !cwd) return clean;
  return `${cwd.replace(/[\\/]$/, '')}/${clean.replace(/\\/g, '/')}`;
}

// eslint-disable-next-line no-control-regex
const ANSI = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

export function truncateLines(s: string, max: number): { text: string; cut: number } {
  const lines = s.split('\n');
  if (lines.length <= max) return { text: s, cut: 0 };
  return { text: lines.slice(0, max).join('\n'), cut: lines.length - max };
}
