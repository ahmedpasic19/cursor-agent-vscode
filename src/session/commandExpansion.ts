import type { PromptCommandInput } from '../shared/protocol';
import type { ResolvedSlashCommand } from '../context/SkillIndex';

/** Prepends skill line and keeps user text; expands .md command bodies with $ARGUMENTS / $1..$9. */
export function expandSlashForPrompt(
  text: string,
  resolved: ResolvedSlashCommand | undefined,
): { displayText: string; sendText: string; command?: PromptCommandInput } {
  const trimmed = text.trimStart();
  const m = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m || !resolved) {
    return { displayText: text, sendText: text };
  }
  const rest = (m[2] ?? '').trimEnd();
  const cmdMeta: PromptCommandInput = {
    kind: resolved.kind,
    name: resolved.name,
    file: resolved.file,
    ...(resolved.body !== undefined ? { body: resolved.body } : {}),
    ...(rest ? { args: rest } : {}),
  };

  if (resolved.kind === 'skill') {
    const quotedName = JSON.stringify(resolved.name);
    const quotedPath = JSON.stringify(resolved.file);
    const line = `Use the ${quotedName} skill (${quotedPath}) for this request.`;
    const sendText = rest ? `${line}\n\n${rest}` : `${line}\n\n`;
    return { displayText: text, sendText, command: cmdMeta };
  }

  const expanded = expandCommandBody(resolved.body ?? '', rest);
  return { displayText: text, sendText: expanded, command: cmdMeta };
}

function expandCommandBody(body: string, args: string): string {
  const hasDollar = /\$(?:ARGUMENTS|[1-9])\b/.test(body);
  if (!hasDollar) {
    const base = body.replace(/\s+$/u, '');
    if (!args) return base;
    return base ? `${base}\n${args}` : args;
  }
  const tokens = args.trim() ? args.trim().split(/\s+/u) : [];
  let out = body.replace(/\$ARGUMENTS\b/g, () => args);
  for (let i = 1; i <= 9; i++) {
    const val = tokens[i - 1] ?? '';
    out = out.replace(new RegExp(`\\$${i}\\b`, 'g'), () => val);
  }
  return out.replace(/\s+$/u, '');
}
