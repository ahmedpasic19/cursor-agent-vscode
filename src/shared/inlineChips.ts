/**
 * Inline context chips. The composer places chips inside the message text; the text stores each
 * one as a token `<chipId>` (Unicode private-use marks, never typed by a user).
 * Everything that shows or sends the text expands the tokens: the transcript renders them as
 * chips, the prompt and titles get a readable `@file (lines)` mention.
 */
import type { ContextChip } from './protocol';

export const CHIP_OPEN = '';
export const CHIP_CLOSE = '';
/** Matches one token; group 1 is the chip id. Global: reset lastIndex or use with replace/split. */
export const CHIP_TOKEN_RE = /([^]+)/g;

export const chipToken = (id: string): string => `${CHIP_OPEN}${id}${CHIP_CLOSE}`;

/** Chip ids referenced in `text`, in order. */
export function chipIdsIn(text: string): string[] {
  return [...text.matchAll(CHIP_TOKEN_RE)].map((m) => m[1]!);
}

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Short display label, e.g. `main.rs (158-167)`. */
export function chipLabel(c: ContextChip): string {
  switch (c.kind) {
    case 'selection':
      return `${base(c.path)} (${c.startLine === c.endLine ? c.startLine : `${c.startLine}-${c.endLine}`})`;
    case 'file':
      return c.isFolder ? `${base(c.path)}/` : base(c.path);
    case 'image':
      return c.name;
    case 'terminal':
      return `${c.name} (${c.lineCount} line${c.lineCount === 1 ? '' : 's'})`;
    case 'diagnostics':
      return `${c.items.length} problem${c.items.length === 1 ? '' : 's'}${c.path ? ` in ${base(c.path)}` : ''}`;
  }
}

/** Mention the model sees in the message text; it matches the `<attached_context>` entry. */
export function chipMention(c: ContextChip): string {
  switch (c.kind) {
    case 'selection':
      return `@${c.path}:${c.startLine === c.endLine ? c.startLine : `${c.startLine}-${c.endLine}`}`;
    case 'file':
      return `@${c.path}${c.isFolder ? '/' : ''}`;
    default:
      return `@${chipLabel(c)}`;
  }
}

/** Replace tokens with `fmt(chip)`; tokens of unknown chips are dropped. */
export function expandChipTokens(text: string, chips: ContextChip[] | undefined, fmt: (c: ContextChip) => string = chipMention): string {
  if (!text.includes(CHIP_OPEN)) return text;
  const byId = new Map((chips ?? []).map((c) => [c.id, c]));
  return text.replace(CHIP_TOKEN_RE, (_, id: string) => {
    const c = byId.get(id);
    return c ? fmt(c) : '';
  });
}

/** Split text into plain strings and chips (for rendering). */
export function splitChipTokens(text: string, chips: ContextChip[] | undefined): Array<string | ContextChip> {
  const byId = new Map((chips ?? []).map((c) => [c.id, c]));
  const out: Array<string | ContextChip> = [];
  let last = 0;
  for (const m of text.matchAll(CHIP_TOKEN_RE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const c = byId.get(m[1]!);
    if (c) out.push(c);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
