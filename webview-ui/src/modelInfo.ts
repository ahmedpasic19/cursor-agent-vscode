/**
 * One-line descriptions for the model picker. The CLI only reports `<id> - <label>`, so these are
 * keyed by id pattern (first match wins). Unknown ids get no description.
 */
const RULES: [RegExp, string][] = [
  [/^auto$/i, 'Cursor picks the best model for each request'],
  [/^composer.*fast/i, "Cursor's own coding model, tuned for speed"],
  [/^composer/i, "Cursor's own agentic coding model"],
  [/opus.*thinking/i, 'Deepest reasoning for the hardest problems'],
  [/opus/i, 'For complex work and everyday tasks'],
  [/sonnet.*thinking/i, 'Balanced model with extended reasoning'],
  [/sonnet/i, 'Efficient for routine tasks'],
  [/haiku/i, 'Fastest for quick answers'],
  [/fable/i, 'For your toughest challenges'],
  [/codex.*(high|max)/i, 'OpenAI coding model, maximum effort'],
  [/codex/i, 'OpenAI model tuned for coding agents'],
  [/gpt.*(mini|nano)/i, 'Small, fast OpenAI model'],
  [/gpt.*high/i, 'OpenAI flagship with more reasoning'],
  [/gpt/i, 'OpenAI flagship model'],
  [/^o\d/i, 'OpenAI reasoning model'],
  [/gemini.*flash/i, 'Fast Google model with a long context'],
  [/gemini/i, 'Google model with a very long context'],
  [/grok.*fast/i, 'Fast xAI model'],
  [/grok/i, 'xAI reasoning model'],
  [/deepseek/i, 'Open-weights reasoning model'],
  [/kimi/i, 'Moonshot open model for agentic coding'],
  [/qwen/i, 'Alibaba open coding model'],
  [/thinking/i, 'Extended reasoning'],
];

export function modelDescription(id: string | undefined): string | undefined {
  if (!id) return 'Uses the CLI default model';
  for (const [re, text] of RULES) if (re.test(id)) return text;
  return undefined;
}

const RECENT_KEY = 'cursorAgent.recentModels';

/** Most recently picked model ids (per webview origin; best effort). */
export function recentModels(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function rememberModel(id: string | undefined): void {
  if (!id) return;
  try {
    const next = [id, ...recentModels().filter((x) => x !== id)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}
