/**
 * Small fuzzy matcher for @-mentions: subsequence match over the path, with bonuses for
 * matches in the file name, at word starts, and for consecutive characters.
 */

export function fuzzyScore(query: string, path: string): number | undefined {
  const q = query.toLowerCase().replace(/\\/g, '/');
  if (!q) return 0;
  const p = path.toLowerCase();
  const nameStart = p.lastIndexOf('/') + 1;

  // Fast path: substring of the file name is the best kind of match.
  const nameIdx = p.indexOf(q, nameStart);
  if (nameIdx >= 0) return 1000 - (p.length - nameStart) - (nameIdx - nameStart) * 2;
  const subIdx = p.indexOf(q);
  if (subIdx >= 0) return 600 - p.length - subIdx;

  let score = 0;
  let pi = 0;
  let prev = -2;
  for (const ch of q) {
    const found = p.indexOf(ch, pi);
    if (found < 0) return undefined;
    if (found === prev + 1) score += 8;
    const before = p[found - 1];
    if (found === 0 || before === '/' || before === '-' || before === '_' || before === '.') score += 6;
    if (found >= nameStart) score += 4;
    prev = found;
    pi = found + 1;
  }
  return score - p.length * 0.5;
}

export interface Candidate {
  /** Path relative to `root`, forward slashes. */
  path: string;
  isFolder: boolean;
  /** Absolute workspace folder the path is relative to (multi-root). */
  root?: string;
  /** Workspace folder name, set only when several folders are open. */
  folder?: string;
}

export function fuzzyFilter(query: string, items: Candidate[], limit: number): Candidate[] {
  if (!query) {
    // No query: shallow paths first (top-level folders and files).
    return [...items]
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
      .slice(0, limit);
  }
  const scored: { c: Candidate; s: number }[] = [];
  for (const c of items) {
    const s = fuzzyScore(query, c.path);
    if (s !== undefined) scored.push({ c, s: s + (c.isFolder ? -5 : 0) });
  }
  scored.sort((a, b) => b.s - a.s || a.c.path.length - b.c.path.length);
  return scored.slice(0, limit).map((x) => x.c);
}

/** Derive folder candidates from a file list. */
export function withFolders(files: string[], tag: Pick<Candidate, 'root' | 'folder'> = {}): Candidate[] {
  const folders = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  return [
    ...[...folders].map((path) => ({ path, isFolder: true, ...tag })),
    ...files.map((path) => ({ path, isFolder: false, ...tag })),
  ];
}
