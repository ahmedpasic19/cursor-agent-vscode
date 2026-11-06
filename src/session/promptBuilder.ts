import type { Mode } from '../shared/events';
import type { ContextChip } from '../shared/protocol';
import { expandChipTokens } from '../shared/inlineChips';

export interface PromptInput {
  text: string;
  mode: Mode;
  /** Mode the resumed CLI session is currently in, if we are resuming one. */
  sessionMode?: Mode;
  chips?: ContextChip[];
  /** The run's working directory: chip paths inside it are sent relative, others absolute. */
  cwd?: string;
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** `abs` relative to `root` (forward slashes), or undefined when it is not inside `root`. */
export function relativeTo(root: string, abs: string): string | undefined {
  const r = norm(root);
  const a = norm(abs);
  if (a.toLowerCase() === r.toLowerCase()) return '.';
  if (!a.toLowerCase().startsWith(r.toLowerCase() + '/')) return undefined;
  return a.slice(r.length + 1);
}

/** Path the agent should see for a chip: relative to the run's cwd when inside it, else absolute. */
function chipPath(c: { path: string; absPath: string }, cwd: string | undefined): string {
  if (!cwd) return c.path;
  return relativeTo(cwd, c.absPath) ?? norm(c.absPath);
}

/**
 * Extra roots for `--add-dir`: every other workspace folder, plus folders of attached files and
 * images that sit outside all of them. De-duplicated case-insensitively; the cwd is never listed.
 */
export function extraRoots(cwd: string, workspaceRoots: string[], chips: ContextChip[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>([norm(cwd).toLowerCase()]);
  const add = (d: string) => {
    const k = norm(d).toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(d);
    }
  };
  for (const r of workspaceRoots) add(r);
  const roots = [cwd, ...workspaceRoots];
  for (const c of chips) {
    if (c.kind !== 'file' && c.kind !== 'selection' && c.kind !== 'image') continue;
    if (roots.some((r) => relativeTo(r, c.absPath) !== undefined)) continue;
    const isDir = c.kind === 'file' && c.isFolder;
    const dir = isDir ? c.absPath : c.absPath.replace(/[\\/][^\\/]*$/, '');
    if (dir) add(dir);
  }
  return out;
}

/**
 * The CLI session keeps its mode across --resume and `--mode` only accepts plan|ask,
 * so going back to Agent mode needs an explicit instruction (docs/CLI_NOTES.md §7).
 */
// Tested in Phase 2: stronger wording did not prevent the one failed edit before the switch.
export const SWITCH_TO_AGENT_PREFIX = 'Switch to agent mode, then do the following.\n\n';

/** Tells the agent to look at attached images (the CLI only takes text, so images go by path). */
export const IMAGE_NOTE = 'The user attached image(s) listed as <image> above. Open each one with your file read tool to view it before answering.';

function attr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Serializes chips as `<attached_context>` (PLAN.md §5.4). */
export function serializeChips(chips: ContextChip[], cwd?: string): string {
  const parts: string[] = [];
  let images = 0;
  for (const c of chips) {
    switch (c.kind) {
      case 'selection': {
        const lines = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
        const lang = c.language ? ` language="${attr(c.language)}"` : '';
        const path = attr(chipPath(c, cwd));
        if (c.text === undefined) {
          parts.push(`<selection path="${path}" lines="${lines}"${lang} />`);
        } else {
          parts.push(`<selection path="${path}" lines="${lines}"${lang}>\n${c.text}\n</selection>`);
        }
        break;
      }
      case 'file': {
        const path = attr(chipPath(c, cwd));
        parts.push(c.isFolder ? `<folder path="${path}" />` : `<file path="${path}" />`);
        break;
      }
      case 'image':
        images++;
        // Always absolute: pasted images live in extension storage, outside the workspace.
        parts.push(`<image path="${attr(norm(c.absPath))}" name="${attr(c.name)}" />`);
        break;
      case 'terminal':
        parts.push(`<terminal_output name="${attr(c.name)}">\n${c.text}\n</terminal_output>`);
        break;
      case 'diagnostics': {
        // Group by file so each block has one path.
        const byPath = new Map<string, string[]>();
        for (const it of c.items) byPath.set(it.path, [...(byPath.get(it.path) ?? []), it.line]);
        for (const [path, lines] of byPath) parts.push(`<diagnostics path="${attr(path)}">\n${lines.join('\n')}\n</diagnostics>`);
        break;
      }
    }
  }
  const note = images ? `\n${IMAGE_NOTE}` : '';
  return `<attached_context>\n${parts.join('\n')}\n</attached_context>${note}`;
}

export function buildPrompt(input: PromptInput): string {
  const prefix = input.mode === 'agent' && input.sessionMode && input.sessionMode !== 'agent' ? SWITCH_TO_AGENT_PREFIX : '';
  // Inline chip tokens become `@path:lines` mentions that point at the <attached_context> entries.
  const text = expandChipTokens(input.text, input.chips);
  if (!input.chips?.length) return prefix + text;
  return `${prefix}${serializeChips(input.chips, input.cwd)}\n\n<user_message>\n${text}\n</user_message>`;
}

export function titleFrom(text: string, max = 30): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one || 'New chat';
}
