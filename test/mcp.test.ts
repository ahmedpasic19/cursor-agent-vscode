import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildArgs } from '../src/backend/CliBackend';
import {
  classifyStatus,
  globalMcpPath,
  lineOfServer,
  listServers,
  parseJsonc,
  parseMarketplaces,
  parseMcpList,
  parseMcpTools,
  projectMcpPath,
  removeServer,
  scanPlugins,
  upsertServer,
} from '../src/mcp/mcpConfig';

vi.mock('vscode', () => ({}));
const { fromEntry, toConfig } = await import('../src/mcp/McpServerForm');

let home: string;
let ws: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ca-mcp-home-'));
  ws = mkdtempSync(join(tmpdir(), 'ca-mcp-ws-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe('CLI output parsing', () => {
  it('mcp list (recorded 2026-11-05)', () => {
    const m = parseMcpList('mysql-eko: ready\r\ngithub: disabled\nlinear: needs authentication\nbroken: error: spawn npx ENOENT\n\n');
    expect([...m.entries()].map(([k, v]) => [k, v.state])).toEqual([
      ['mysql-eko', 'ready'],
      ['github', 'disabled'],
      ['linear', 'needsAuth'],
      ['broken', 'error'],
    ]);
    expect(m.get('broken')!.text).toBe('error: spawn npx ENOENT');
  });

  it('strips ANSI colours and ignores non-status lines', () => {
    expect([...parseMcpList('\x1b[32mgh\x1b[0m: ready\nNo more servers\n').keys()]).toEqual(['gh']);
  });

  it('classifies approval and loading states', () => {
    expect(classifyStatus('needs approval')).toBe('needsApproval');
    expect(classifyStatus('connecting…')).toBe('loading');
    expect(classifyStatus('something new')).toBe('unknown');
  });

  it('mcp list-tools (recorded 2026-11-05)', () => {
    expect(parseMcpTools('Tools for mysql-eko (2):\n- mysql_query (sql)\n- describe (table, schema)\n- ping\n')).toEqual([
      { name: 'mysql_query', args: ['sql'] },
      { name: 'describe', args: ['table', 'schema'] },
      { name: 'ping', args: [] },
    ]);
  });

  it('plugin marketplace list --format json', () => {
    const out = '[\n  {"name":"cursor-public","displayName":"Cursor Plugin Marketplace","gitUrl":"","scope":"global"}\n]';
    expect(parseMarketplaces(out)[0]!.name).toBe('cursor-public');
    expect(parseMarketplaces('oops')).toEqual([]);
  });
});

describe('mcp.json', () => {
  it('parses JSONC (comments, trailing commas) without touching strings', () => {
    expect(parseJsonc('{ // c\n "a": "http://x//y", /* b */ "b": [1,], }')).toEqual({ a: 'http://x//y', b: [1] });
  });

  it('lists global then project servers, and reports broken files', () => {
    mkdirSync(join(home, '.cursor'));
    writeFileSync(globalMcpPath(home), JSON.stringify({ mcpServers: { g: { command: 'npx' } } }));
    mkdirSync(join(ws, '.cursor'));
    writeFileSync(projectMcpPath(ws), '{ "mcpServers": { "p": { "url": "https://x" } ');
    const r = listServers([ws], home);
    expect(r.servers.map((s) => `${s.scope}:${s.name}`)).toEqual(['global:g']);
    expect(r.errors).toHaveLength(1);
    writeFileSync(projectMcpPath(ws), '{ "mcpServers": { "p": { "url": "https://x" } } }');
    expect(listServers([ws], home).servers.map((s) => `${s.scope}:${s.name}`)).toEqual(['global:g', 'project:p']);
  });

  it('upsert keeps other keys and order; rename stays in place; remove', () => {
    const f = projectMcpPath(ws);
    upsertServer(f, 'a', { command: 'one' });
    upsertServer(f, 'b', { command: 'two' });
    writeFileSync(f, JSON.stringify({ other: 1, ...JSON.parse(readFileSync(f, 'utf8')) }));
    upsertServer(f, 'a2', { command: 'uno' }, 'a');
    const j = JSON.parse(readFileSync(f, 'utf8'));
    expect(j.other).toBe(1);
    expect(Object.keys(j.mcpServers)).toEqual(['a2', 'b']);
    expect(lineOfServer(f, 'b')).toBeGreaterThan(1);
    expect(removeServer(f, 'b')).toBe(true);
    expect(removeServer(f, 'nope')).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(f, 'utf8')).mcpServers)).toEqual(['a2']);
  });

  it('refuses to overwrite an invalid file', () => {
    const f = projectMcpPath(ws);
    mkdirSync(join(ws, '.cursor'));
    writeFileSync(f, '{ broken');
    expect(() => upsertServer(f, 'x', { command: 'y' })).toThrow(/not valid JSON/);
    expect(readFileSync(f, 'utf8')).toBe('{ broken');
  });
});

describe('server form', () => {
  const base = { name: 'gh', scope: 'global', transport: 'stdio' as const, command: 'npx', args: '-y\n @mcp/github \n', env: 'TOKEN=${env:GH}\n', url: '', headers: '', enable: true };

  it('builds a stdio config and keeps unmanaged keys', () => {
    expect(toConfig(base, { envFile: '.env', command: 'old', env: { OLD: '1' } })).toEqual({
      envFile: '.env',
      command: 'npx',
      args: ['-y', '@mcp/github'],
      env: { TOKEN: '${env:GH}' },
    });
  });

  it('builds a remote config', () => {
    expect(toConfig({ ...base, transport: 'remote', url: 'https://mcp.x/mcp', headers: 'Authorization: Bearer a:b' })).toEqual({
      url: 'https://mcp.x/mcp',
      headers: { Authorization: 'Bearer a:b' },
    });
  });

  it('validates', () => {
    expect(toConfig({ ...base, name: 'bad name' })).toMatch(/Name/);
    expect(toConfig({ ...base, command: ' ' })).toMatch(/Command/);
    expect(toConfig({ ...base, env: 'NOEQUALS' })).toMatch(/KEY=VALUE/);
    expect(toConfig({ ...base, transport: 'remote', url: 'ftp://x' })).toMatch(/URL/);
  });

  it('round-trips an entry into form values', () => {
    const v = fromEntry({ name: 'gh', scope: 'project', folder: ws, file: projectMcpPath(ws), config: { command: 'npx', args: ['-y', 'x'], env: { A: '1' } } });
    expect(v).toMatchObject({ scope: ws, transport: 'stdio', args: '-y\nx', env: 'A=1', enable: false });
    expect(toConfig(v)).toEqual({ command: 'npx', args: ['-y', 'x'], env: { A: '1' } });
  });
});

describe('plugins', () => {
  it('scans cached (newest revision) and local plugins', () => {
    const rev = (name: string, version: string, t: number) => {
      const d = join(home, '.cursor', 'plugins', 'cache', 'cursor-public', 'vercel', name);
      mkdirSync(join(d, '.cursor-plugin'), { recursive: true });
      writeFileSync(join(d, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'vercel', version }));
      utimesSync(d, t, t);
    };
    rev('aaa', '0.1.0', 1000);
    rev('bbb', '0.2.0', 2000);
    mkdirSync(join(home, '.cursor', 'plugins', 'local', 'mine'), { recursive: true });
    const ps = scanPlugins(home);
    expect(ps.map((p) => `${p.name}@${p.version ?? '-'}:${p.source}`)).toEqual(['mine@-:local', 'vercel@0.2.0:cursor-public']);
  });

  it('passes --approve-mcps and --plugin-dir to the CLI', () => {
    const args = buildArgs({ cwd: 'C:\\w', prompt: '', mode: 'ask', partialOutput: false, extraArgs: [], postResultGraceMs: 0, timeoutMs: 1, approveMcps: true, pluginDirs: ['C:\\p'] });
    expect(args).toContain('--approve-mcps');
    expect(args.join(' ')).toContain('--plugin-dir C:\\p');
  });
});
