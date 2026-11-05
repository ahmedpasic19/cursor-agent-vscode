import { describe, expect, it } from 'vitest';
import { buildArgs } from '../src/backend/CliBackend';
import { parseFenceInfo, stripPathComment } from '../webview-ui/src/codeBlocks';

describe('parseFenceInfo', () => {
  it('language only', () => {
    expect(parseFenceInfo('ts', 'const a = 1;')).toEqual({ lang: 'ts', path: undefined });
    expect(parseFenceInfo('', 'x')).toEqual({ lang: undefined, path: undefined });
  });

  it('path hints in the info string', () => {
    expect(parseFenceInfo('ts src/a.ts', '')).toMatchObject({ lang: 'ts', path: 'src/a.ts' });
    expect(parseFenceInfo('ts:src/a.ts', '')).toMatchObject({ lang: 'ts', path: 'src/a.ts' });
    expect(parseFenceInfo('python path=tools/run.py', '')).toMatchObject({ lang: 'python', path: 'tools/run.py' });
    expect(parseFenceInfo('tsx title="src/App.tsx"', '')).toMatchObject({ lang: 'tsx', path: 'src/App.tsx' });
    expect(parseFenceInfo('src/util.ts', '')).toMatchObject({ lang: 'ts', path: 'src/util.ts' });
  });

  it('path hint in a first-line comment', () => {
    expect(parseFenceInfo('ts', '// filepath: src/b.ts\nexport {}')).toMatchObject({ lang: 'ts', path: 'src/b.ts' });
    expect(parseFenceInfo('python', '# file: app/main.py\nprint(1)')).toMatchObject({ path: 'app/main.py' });
    expect(parseFenceInfo('html', '<!-- path: web/index.html -->\n<p/>')).toMatchObject({ path: 'web/index.html' });
  });

  it('Cursor-style citations open instead of apply', () => {
    expect(parseFenceInfo('12:20:src/booking/api.ts', 'code')).toEqual({
      lang: 'ts',
      citation: { path: 'src/booking/api.ts', startLine: 12, endLine: 20 },
    });
  });

  it('does not mistake words for paths', () => {
    expect(parseFenceInfo('bash title=Install', 'npm i')).toMatchObject({ lang: 'bash', path: undefined });
    expect(parseFenceInfo('json copy', '{}')).toMatchObject({ lang: 'json', path: undefined });
  });

  it('strips the path comment before inserting/applying', () => {
    expect(stripPathComment('// filepath: src/b.ts\nexport {}')).toBe('export {}');
    expect(stripPathComment('export {}')).toBe('export {}');
  });
});

describe('worktree args', () => {
  const base = { cwd: 'C:\\ws', prompt: 'x', mode: 'agent' as const, partialOutput: true, extraArgs: [], postResultGraceMs: 1, timeoutMs: 1 };
  it('adds --worktree <name> only when requested and supported', () => {
    expect(buildArgs({ ...base, worktreeName: 'cursor-agent-abc' })).toEqual(expect.arrayContaining(['--worktree', 'cursor-agent-abc']));
    expect(buildArgs(base)).not.toContain('--worktree');
    expect(buildArgs({ ...base, worktreeName: 'x' }, { version: 'v', flags: new Set(['-p']) })).not.toContain('--worktree');
  });
});
