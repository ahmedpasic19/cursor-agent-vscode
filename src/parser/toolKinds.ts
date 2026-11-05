import type { ToolUiKind } from '../shared/events';

/**
 * Maps the raw tool name (the `<name>ToolCall` key with the suffix removed) to a UI kind.
 * Seen in Phase 0: read, glob, grep, edit, shell, createPlan, switchMode. The rest are guesses
 * that degrade to the generic card if wrong.
 */
const MAP: Record<string, ToolUiKind> = {
  read: 'read',
  edit: 'edit',
  write: 'edit',
  applyPatch: 'edit',
  delete: 'delete',
  shell: 'shell',
  terminal: 'shell',
  glob: 'search',
  grep: 'search',
  ls: 'search',
  list: 'search',
  semSearch: 'search',
  codebaseSearch: 'search',
  webSearch: 'search',
  createPlan: 'plan',
  switchMode: 'mode',
  todo: 'todo',
  updateTodos: 'todo',
  todoWrite: 'todo',
  mcp: 'mcp',
};

export function toolUiKind(name: string): ToolUiKind {
  if (MAP[name]) return MAP[name];
  if (/mcp/i.test(name)) return 'mcp';
  if (/todo/i.test(name)) return 'todo';
  return 'unknown';
}
