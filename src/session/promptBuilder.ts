import type { Mode } from '../shared/events';
import type { ContextChip } from '../shared/protocol';

export interface PromptInput {
  text: string;
  mode: Mode;
  /** Mode the resumed CLI session is currently in, if we are resuming one. */
  sessionMode?: Mode;
  chips?: ContextChip[];
}

/**
 * The CLI session keeps its mode across --resume and `--mode` only accepts plan|ask,
 * so going back to Agent mode needs an explicit instruction (docs/CLI_NOTES.md §7).
 */
// Tested in Phase 2: stronger wording did not prevent the one failed edit before the switch.
export const SWITCH_TO_AGENT_PREFIX = 'Switch to agent mode, then do the following.\n\n';

function attr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Serializes chips as `<attached_context>` (PLAN.md §5.4). */
export function serializeChips(chips: ContextChip[]): string {
  const parts: string[] = [];
  for (const c of chips) {
    switch (c.kind) {
      case 'selection': {
        const lines = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
        const lang = c.language ? ` language="${attr(c.language)}"` : '';
        if (c.text === undefined) {
          parts.push(`<selection path="${attr(c.path)}" lines="${lines}"${lang} />`);
        } else {
          parts.push(`<selection path="${attr(c.path)}" lines="${lines}"${lang}>\n${c.text}\n</selection>`);
        }
        break;
      }
      case 'file':
        parts.push(c.isFolder ? `<folder path="${attr(c.path)}" />` : `<file path="${attr(c.path)}" />`);
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
  return `<attached_context>\n${parts.join('\n')}\n</attached_context>`;
}

export function buildPrompt(input: PromptInput): string {
  const prefix = input.mode === 'agent' && input.sessionMode && input.sessionMode !== 'agent' ? SWITCH_TO_AGENT_PREFIX : '';
  if (!input.chips?.length) return prefix + input.text;
  return `${prefix}${serializeChips(input.chips)}\n\n<user_message>\n${input.text}\n</user_message>`;
}

export function titleFrom(text: string, max = 30): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one || 'New chat';
}
