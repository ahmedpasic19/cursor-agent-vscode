import { describe, expect, it } from 'vitest';
import { parseSkillFrontMatterFromText } from '../src/context/skillFrontMatter';
import { mergeAgentCommandsByFirstWin } from '../src/context/skillMerge';
import { buildPrompt } from '../src/session/promptBuilder';
import { expandSlashForPrompt } from '../src/session/commandExpansion';
import { filterCommands, slashListOptionCount, type BuiltinSlashCommand } from '../src/shared/commandFilter';
import type { AgentCommand } from '../src/shared/protocol';

describe('parseSkillFrontMatterFromText', () => {
  it('parses name, description, disable-model-invocation', () => {
    const fm = parseSkillFrontMatterFromText(`---
name: my-skill
description: Does a thing
disable-model-invocation: true
---
body`);
    expect(fm).toEqual({ name: 'my-skill', description: 'Does a thing', userOnly: true });
  });

  it('returns empty object when no front matter', () => {
    expect(parseSkillFrontMatterFromText('no dash block')).toEqual({});
  });

  it('omits description when absent', () => {
    const fm = parseSkillFrontMatterFromText('---\nname: x\n---');
    expect(fm).toEqual({ name: 'x' });
  });
});

describe('expandSlashForPrompt', () => {
  it('prepends skill instruction and keeps user text after command', () => {
    const r = expandSlashForPrompt('/frontend-design bold hero', {
      kind: 'skill',
      name: 'frontend-design',
      file: '/abs/SKILL.md',
    });
    expect(r.command?.kind).toBe('skill');
    expect(r.sendText).toContain('Use the "frontend-design" skill ("/abs/SKILL.md")');
    expect(r.sendText).toContain('bold hero');
  });

  it('substitutes $ARGUMENTS in command body', () => {
    const r = expandSlashForPrompt('/ship fix login', {
      kind: 'command',
      name: 'ship',
      file: '/x.md',
      body: 'Deploy $ARGUMENTS to prod',
    });
    expect(r.sendText).toBe('Deploy fix login to prod');
  });

  it('appends args when no placeholder', () => {
    const r = expandSlashForPrompt('/note hello world', {
      kind: 'command',
      name: 'note',
      file: '/n.md',
      body: 'Static prompt line',
    });
    expect(r.sendText).toBe('Static prompt line\nhello world');
  });

  it('substitutes $1 $2', () => {
    const r = expandSlashForPrompt('/t a b', {
      kind: 'command',
      name: 't',
      file: '/t.md',
      body: 'First $1 second $2',
    });
    expect(r.sendText).toBe('First a second b');
  });
});

describe('buildPrompt with send path', () => {
  it('uses expanded text as the prompt body', () => {
    const p = buildPrompt({
      text: 'Use the "x" skill ("/p/SKILL.md") for this request.\n\nhello',
      mode: 'ask',
    });
    expect(p).toContain('Use the "x" skill');
    expect(p).toContain('hello');
  });
});

describe('filterCommands', () => {
  const builtins: BuiltinSlashCommand[] = [{ name: 'help', hint: 'h' }];
  const cmds: AgentCommand[] = [
    { kind: 'skill', name: 'frontend-design', file: '/a', source: 'User', description: 'UI polish' },
    { kind: 'command', name: 'deploy', file: '/d.md', source: 'Project', description: 'Ship it' },
  ];

  it('matches hyphenated names when filtering discovered', () => {
    const rows = filterCommands('front', builtins, cmds);
    expect(slashListOptionCount(rows)).toBeGreaterThan(0);
    expect(rows.some((r) => r.type === 'discover' && r.cmd.name === 'frontend-design')).toBe(true);
  });

  it('finds by description substring', () => {
    const rows = filterCommands('polish', builtins, cmds);
    expect(rows.some((r) => r.type === 'discover' && r.cmd.name === 'frontend-design')).toBe(true);
  });
});

describe('mergeAgentCommandsByFirstWin', () => {
  it('project skill wins over same-named user skill', () => {
    const project: AgentCommand = { kind: 'skill', name: 'dup', file: '/p', source: 'Project', description: 'project' };
    const home: AgentCommand = { kind: 'skill', name: 'dup', file: '/h', source: 'User', description: 'home' };
    const merged = mergeAgentCommandsByFirstWin([project, home]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.description).toBe('project');
  });
});
