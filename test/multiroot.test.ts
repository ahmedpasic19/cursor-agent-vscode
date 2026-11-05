import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArgs } from '../src/backend/CliBackend';
import type { RunOptions } from '../src/backend/AgentBackend';
import { imageChipForPath, saveImage } from '../src/context/Attachments';
import { addChip } from '../src/context/chips';
import { fuzzyFilter, withFolders } from '../src/context/fuzzy';
import type { ContextChip } from '../src/shared/protocol';
import { buildPrompt, extraRoots, IMAGE_NOTE, relativeTo, serializeChips } from '../src/session/promptBuilder';

const base: RunOptions = { cwd: 'C:\\ws\\app', prompt: 'hi', mode: 'ask', partialOutput: false, extraArgs: [], postResultGraceMs: 0, timeoutMs: 1000 };

describe('multi-root: --add-dir', () => {
  it('passes each extra root', () => {
    const args = buildArgs({ ...base, addDirs: ['C:\\ws\\lib', 'D:\\other'] });
    expect(args.join(' ')).toContain('--add-dir C:\\ws\\lib --add-dir D:\\other');
  });

  it('skips the flag when the CLI does not support it', () => {
    const args = buildArgs({ ...base, addDirs: ['C:\\ws\\lib'] }, { flags: new Set(['--mode']) } as never);
    expect(args).not.toContain('--add-dir');
  });

  it('extraRoots: other folders, never the cwd, de-duplicated case-insensitively', () => {
    expect(extraRoots('C:\\ws\\app', ['C:\\ws\\app', 'c:\\WS\\lib', 'C:\\ws\\lib\\'], [])).toEqual(['c:\\WS\\lib']);
  });

  it('extraRoots: adds folders of attachments outside every root', () => {
    const img: ContextChip = { id: 'i', kind: 'image', name: 'a.png', absPath: 'C:\\store\\att\\t1\\a.png', mime: 'image/png', bytes: 3 };
    const inside: ContextChip = { id: 'f', kind: 'file', path: 'x.ts', absPath: 'C:\\ws\\lib\\x.ts', isFolder: false };
    expect(extraRoots('C:\\ws\\app', ['C:\\ws\\lib'], [img, inside])).toEqual(['C:\\ws\\lib', 'C:\\store\\att\\t1']);
  });
});

describe('multi-root: prompt paths', () => {
  it('relativeTo', () => {
    expect(relativeTo('C:\\ws\\app', 'c:\\ws\\app\\src\\a.ts')).toBe('src/a.ts');
    expect(relativeTo('C:\\ws\\app', 'C:\\ws\\application\\a.ts')).toBeUndefined();
    expect(relativeTo('C:\\ws\\app\\', 'C:\\ws\\app')).toBe('.');
  });

  it('chips inside the cwd are relative, others absolute', () => {
    const a: ContextChip = { id: 'a', kind: 'file', path: 'app/src/a.ts', absPath: 'C:\\ws\\app\\src\\a.ts', isFolder: false };
    const b: ContextChip = { id: 'b', kind: 'file', path: 'lib/b.ts', absPath: 'C:\\ws\\lib\\b.ts', isFolder: false };
    const out = serializeChips([a, b], 'C:\\ws\\app');
    expect(out).toContain('<file path="src/a.ts" />');
    expect(out).toContain('<file path="C:/ws/lib/b.ts" />');
  });

  it('without a cwd the display path is kept (old behaviour)', () => {
    const a: ContextChip = { id: 'a', kind: 'file', path: 'src/a.ts', absPath: 'C:\\ws\\app\\src\\a.ts', isFolder: false };
    expect(serializeChips([a])).toContain('<file path="src/a.ts" />');
  });

  it('file chips de-duplicate by absolute path, so same-named files in two folders both stay', () => {
    const a: ContextChip = { id: 'a', kind: 'file', path: 'index.ts', absPath: 'C:\\ws\\app\\index.ts', isFolder: false };
    const b: ContextChip = { id: 'b', kind: 'file', path: 'index.ts', absPath: 'C:\\ws\\lib\\index.ts', isFolder: false };
    expect(addChip(addChip([], a, 10).chips, b, 10).chips).toHaveLength(2);
  });

  it('candidates carry their root and folder name through fuzzy filtering', () => {
    const items = [...withFolders(['src/a.ts'], { root: 'C:\\ws\\app', folder: 'app' }), ...withFolders(['src/a.ts'], { root: 'C:\\ws\\lib', folder: 'lib' })];
    const hits = fuzzyFilter('a.ts', items, 10);
    expect(hits.map((h) => h.folder)).toEqual(['app', 'lib']);
    expect(hits[0]!.root).toBe('C:\\ws\\app');
  });
});

describe('images', () => {
  it('serializes images with an absolute path and the viewing note', () => {
    const img: ContextChip = { id: 'i', kind: 'image', name: 'shot.png', absPath: 'C:\\s\\a.png', mime: 'image/png', bytes: 3 };
    const p = buildPrompt({ text: 'what is wrong?', mode: 'ask', chips: [img], cwd: 'C:\\ws' });
    expect(p).toContain('<image path="C:/s/a.png" name="shot.png" />');
    expect(p).toContain(IMAGE_NOTE);
    expect(buildPrompt({ text: 'x', mode: 'ask', chips: [{ id: 'f', kind: 'file', path: 'a', absPath: 'C:\\ws\\a', isFolder: false }] })).not.toContain(IMAGE_NOTE);
  });

  it('saveImage writes the bytes once per content and rejects unknown types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-img-'));
    try {
      const data = Buffer.from('fake-png').toString('base64');
      const a = saveImage(dir, 'tab1', { name: '', mime: 'image/png', data });
      const b = saveImage(dir, 'tab1', { name: 'x.png', mime: 'image/png', data });
      expect(a.absPath).toBe(b.absPath);
      expect(a.absPath.startsWith(join(dir, 'attachments', 'tab1'))).toBe(true);
      expect(readFileSync(a.absPath, 'utf8')).toBe('fake-png');
      expect(a.bytes).toBe(8);
      expect(() => saveImage(dir, 'tab1', { name: 'x', mime: 'image/svg+xml', data })).toThrow(/Unsupported/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imageChipForPath accepts image extensions only', () => {
    expect(imageChipForPath('C:\\a\\b.JPEG', 5)?.mime).toBe('image/jpeg');
    expect(imageChipForPath('C:\\a\\b.ts', 5)).toBeUndefined();
  });
});
