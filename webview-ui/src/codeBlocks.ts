/**
 * Code fence info parsing (pure; unit-tested from the host test suite).
 *
 * Recognized forms:
 *   ```ts                       language only
 *   ```ts src/a.ts              language + path hint  → Apply offered
 *   ```ts:src/a.ts              language:path
 *   ```ts path=src/a.ts         key=value (path / file / filename / title)
 *   ```12:20:src/a.ts           Cursor-style citation of existing code (start:end:path) → Open
 *   first line `// filepath: src/a.ts` (or `# file: …`, `<!-- path: … -->`) is also a path hint
 */
export interface FenceInfo {
  lang?: string;
  /** Target file for Apply (workspace-relative or absolute). */
  path?: string;
  /** Citation of existing code: open, don't apply. */
  citation?: { path: string; startLine: number; endLine: number };
}

const PATHY = /[\\/.]/;

export function parseFenceInfo(info: string, code: string): FenceInfo {
  const raw = info.trim();
  const cite = /^(\d+):(\d+):(.+)$/.exec(raw);
  if (cite) {
    const path = cite[3]!.trim();
    return { lang: langFromPath(path), citation: { path, startLine: Number(cite[1]), endLine: Number(cite[2]) } };
  }
  let lang: string | undefined;
  let path: string | undefined;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length) {
    const first = parts.shift()!;
    const colon = /^([\w+#-]+):(.+)$/.exec(first);
    if (colon && PATHY.test(colon[2]!)) {
      lang = colon[1];
      path = colon[2];
    } else {
      lang = first;
    }
  }
  for (const p of parts) {
    const kv = /^(path|file|filename|title)=["']?([^"']+)["']?$/i.exec(p);
    // title= is often prose ("title=Install"); only treat it as a path if it looks like one.
    if (kv && (kv[1]!.toLowerCase() !== 'title' || PATHY.test(kv[2]!))) path = kv[2];
    else if (!path && PATHY.test(p) && !p.includes('=')) path = p;
  }
  if (!path) {
    const firstLine = code.split('\n', 1)[0] ?? '';
    const m = /^\s*(?:\/\/|#|--|<!--|\/\*)\s*(?:file(?:path|name)?|path)\s*:\s*([^\s*]+?)\s*(?:-->|\*\/)?\s*$/i.exec(firstLine);
    if (m) path = m[1];
  }
  if (lang && PATHY.test(lang) && !path) {
    // ```src/a.ts — a bare path as the info string.
    path = lang;
    lang = langFromPath(lang);
  }
  return { lang: lang?.toLowerCase(), path };
}

export function langFromPath(path: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return ext;
}

/** Remove a leading `// filepath:` style comment so Apply writes only the code. */
export function stripPathComment(code: string): string {
  const [first, ...rest] = code.split('\n');
  if (first !== undefined && /^\s*(?:\/\/|#|--|<!--|\/\*)\s*(?:file(?:path|name)?|path)\s*:/i.test(first)) return rest.join('\n');
  return code;
}
