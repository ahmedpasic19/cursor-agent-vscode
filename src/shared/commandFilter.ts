import type { AgentCommand } from './protocol';

export interface BuiltinSlashCommand {
  name: string;
  args?: string;
  hint: string;
}

export type SlashListRow =
  | { type: 'header'; label: string }
  | { type: 'builtin'; cmd: BuiltinSlashCommand }
  | { type: 'discover'; cmd: AgentCommand };

const MAX_OPTIONS = 12;

/** Lowercase subsequence fuzzy match (ordered). */
function fuzzyMatch(hay: string, needle: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) {
      i++;
      if (i === needle.length) return true;
    }
  }
  return false;
}

function scoreDiscovered(cmd: AgentCommand, q: string): number | undefined {
  const name = cmd.name.toLowerCase();
  const desc = (cmd.description ?? '').toLowerCase();
  const hay = `${name} ${desc}`;
  if (!q) return 0;
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  if (desc.includes(q)) return 2;
  if (fuzzyMatch(hay, q)) return 3;
  return undefined;
}

function filterDiscovered(commands: AgentCommand[], query: string): AgentCommand[] {
  const q = query.trim().toLowerCase();
  const scored = commands
    .map((c) => ({ c, s: scoreDiscovered(c, q) }))
    .filter((x): x is { c: AgentCommand; s: number } => x.s !== undefined)
    .sort((a, b) => a.s - b.s || a.c.name.localeCompare(b.c.name));
  return scored.map((x) => x.c).slice(0, MAX_OPTIONS);
}

/** Flat list with section headers for the `/` popup. Built-ins first; then skills; then custom commands. */
export function filterCommands(query: string, builtins: BuiltinSlashCommand[], commands: AgentCommand[]): SlashListRow[] {
  const q = query.trim().toLowerCase();
  const built = !q ? builtins : builtins.filter((b) => b.name.toLowerCase().startsWith(q));
  const disc = filterDiscovered(commands, q);
  const skills = disc.filter((c) => c.kind === 'skill');
  const cmds = disc.filter((c) => c.kind === 'command');

  const rows: SlashListRow[] = [];
  if (built.length) {
    rows.push({ type: 'header', label: 'Slash Commands' });
    for (const cmd of built) rows.push({ type: 'builtin', cmd });
  }
  if (skills.length) {
    rows.push({ type: 'header', label: 'Skills' });
    for (const cmd of skills) rows.push({ type: 'discover', cmd });
  }
  if (cmds.length) {
    rows.push({ type: 'header', label: 'Commands' });
    for (const cmd of cmds) rows.push({ type: 'discover', cmd });
  }
  return rows;
}

export function slashListOptionCount(rows: SlashListRow[]): number {
  return rows.filter((r) => r.type !== 'header').length;
}
