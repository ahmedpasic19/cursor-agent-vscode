/**
 * Minimal front matter parsing for SKILL.md and command .md files (no yaml dependency).
 */
import { readFile } from 'node:fs/promises';

const READ_BYTES = 4096;

export interface SkillMeta {
  name?: string;
  description?: string;
  userOnly?: boolean;
}

export interface CommandMeta {
  description?: string;
}

function parseBlock(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    map.set(key, val);
  }
  return map;
}

/** Reads the first ~4 KB and returns front matter fields between --- lines, or undefined if unparseable. */
export async function parseSkillFrontMatter(file: string): Promise<SkillMeta | undefined> {
  let raw: string;
  try {
    const buf = await readFile(file, { encoding: 'utf8', flag: 'r' });
    raw = buf.length > READ_BYTES ? buf.slice(0, READ_BYTES) : buf;
  } catch {
    return undefined;
  }
  return parseSkillFrontMatterFromText(raw);
}

export function parseSkillFrontMatterFromText(text: string): SkillMeta | undefined {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*/.exec(text);
  if (!m) return {};
  const map = parseBlock(m[1]!);
  const name = map.get('name')?.trim();
  const description = map.get('description')?.trim();
  const disableRaw = map.get('disable-model-invocation') ?? map.get('disable_model_invocation');
  let userOnly: boolean | undefined;
  if (disableRaw !== undefined) {
    const v = disableRaw.toLowerCase();
    if (v === 'true' || v === 'yes' || v === '1') userOnly = true;
    else if (v === 'false' || v === 'no' || v === '0') userOnly = false;
  }
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), ...(userOnly !== undefined ? { userOnly } : {}) };
}

export async function parseCommandFrontMatter(file: string): Promise<CommandMeta | undefined> {
  const skill = await parseSkillFrontMatter(file);
  if (skill === undefined) return undefined;
  return { description: skill.description };
}

export async function readFileBodyAfterFrontMatter(file: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const stripped = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '');
  return stripped;
}
