import type { AgentCommand } from '../shared/protocol';

/** First occurrence wins on name collision (project > user > plugin > Cursor built-in). */
export function mergeAgentCommandsByFirstWin(cmds: AgentCommand[]): AgentCommand[] {
  const seen = new Set<string>();
  const out: AgentCommand[] = [];
  for (const c of cmds) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}
