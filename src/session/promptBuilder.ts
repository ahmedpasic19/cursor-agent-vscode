import type { Mode } from '../shared/events';

export interface PromptInput {
  text: string;
  mode: Mode;
  /** Mode the resumed CLI session is currently in, if we are resuming one. */
  sessionMode?: Mode;
}

/**
 * The CLI session keeps its mode across --resume and `--mode` only accepts plan|ask,
 * so going back to Agent mode needs an explicit instruction (docs/CLI_NOTES.md §7).
 */
export const SWITCH_TO_AGENT_PREFIX = 'Switch to agent mode, then do the following.\n\n';

export function buildPrompt(input: PromptInput): string {
  let prompt = input.text;
  if (input.mode === 'agent' && input.sessionMode && input.sessionMode !== 'agent') {
    prompt = SWITCH_TO_AGENT_PREFIX + prompt;
  }
  return prompt;
}

export function titleFrom(text: string, max = 30): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one || 'New chat';
}
