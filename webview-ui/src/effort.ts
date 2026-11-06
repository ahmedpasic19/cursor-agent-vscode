import type { ModelOption } from '../../src/shared/protocol';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** The five steps Claude Code shows on its effort slider, lowest first. */
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** How each step is written in the UI (pill and slider), as Claude Code writes it. */
export const EFFORT_LABEL: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

const EFFORT_KEY = 'cursorAgent.effort';

/** Longest-first so e.g. extra-high wins over high. */
const EFFORT_TOKEN_SPECS: { token: string; rank: number }[] = [
  { token: 'extra-high', rank: 5 },
  { token: 'xhigh', rank: 5 },
  { token: 'max', rank: 6 },
  { token: 'high', rank: 4 },
  { token: 'medium', rank: 3 },
  { token: 'low', rank: 2 },
  { token: 'minimal', rank: 1 },
  { token: 'none', rank: 0 },
];

const RANK_BY_TOKEN = new Map(EFFORT_TOKEN_SPECS.map(({ token, rank }) => [token, rank]));

export interface ParsedModel {
  /** Id with effort token removed; modifiers kept for recomposition. */
  family: string;
  /** Raw CLI token, e.g. xhigh | extra-high; undefined when the id has none. */
  token?: string;
  rank?: number;
  fast: boolean;
  /**
   * True for legacy `…-<effort>-thinking` (recompose `family-<token>-thinking`).
   * False for infix `…-thinking-<effort>` (recompose `family-<token>` with family ending in -thinking).
   */
  legacyThinkingLast: boolean;
}

const TOKENS_LONGEST_FIRST = [...EFFORT_TOKEN_SPECS].sort((a, b) => b.token.length - a.token.length);

export function parseModelId(id: string): ParsedModel {
  let rest = id;
  let fast = false;
  if (rest.endsWith('-fast')) {
    fast = true;
    rest = rest.slice(0, -'-fast'.length);
  }

  /** Infix: `…-thinking-<effort>` (e.g. claude-opus-5-thinking-max). */
  for (const { token, rank } of TOKENS_LONGEST_FIRST) {
    const suf = `-thinking-${token}`;
    if (rest.endsWith(suf)) {
      const family = rest.slice(0, -suf.length);
      return { family, token, rank, fast, legacyThinkingLast: false };
    }
  }

  /** Legacy: `…-<effort>-thinking`. */
  if (rest.endsWith('-thinking')) {
    const beforeThinking = rest.slice(0, -'-thinking'.length);
    for (const { token, rank } of TOKENS_LONGEST_FIRST) {
      const suf = `-${token}`;
      if (beforeThinking.endsWith(suf)) {
        const family = beforeThinking.slice(0, -suf.length);
        return { family, token, rank, fast, legacyThinkingLast: true };
      }
    }
    return { family: beforeThinking, fast, legacyThinkingLast: true };
  }

  for (const { token, rank } of TOKENS_LONGEST_FIRST) {
    const suf = `-${token}`;
    if (rest.endsWith(suf)) {
      const family = rest.slice(0, -suf.length);
      return { family, token, rank, fast, legacyThinkingLast: false };
    }
  }

  return { family: rest, fast, legacyThinkingLast: false };
}

/** Stable key for grouping list rows: same logical family + fast lane. */
export function familyGroupKey(parsed: ParsedModel): string {
  return `${parsed.family}\0${parsed.fast ? '1' : '0'}`;
}

export function tokenRank(token: string): number | undefined {
  return RANK_BY_TOKEN.get(token);
}

const TARGET_RANK: Record<Effort, number> = {
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

function nearestToken(tokens: string[], targetRank: number): string | undefined {
  if (!tokens.length) return undefined;
  let best: { token: string; d: number; rank: number } | undefined;
  for (const token of tokens) {
    const rank = RANK_BY_TOKEN.get(token);
    if (rank === undefined) continue;
    const d = Math.abs(rank - targetRank);
    /** On tie, prefer lower rank (e.g. kimi-k3: Medium→low when choosing between low and high). */
    if (!best || d < best.d || (d === best.d && rank < best.rank)) best = { token, d, rank };
  }
  return best?.token;
}

/** Effort tokens that exist for this family (same group key), sorted by rank ascending. */
export function familyTokens(models: ModelOption[], family: string, fast: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    const p = parseModelId(m.id);
    if (p.family !== family || p.fast !== fast) continue;
    if (!p.token) continue;
    if (seen.has(p.token)) continue;
    seen.add(p.token);
    out.push(p.token);
  }
  out.sort((a, b) => (RANK_BY_TOKEN.get(a) ?? 99) - (RANK_BY_TOKEN.get(b) ?? 99));
  return out;
}

/** Map UI steps to concrete tokens for this family's variants. */
export function effortLadder(tokens: string[]): Record<Effort, string | undefined> {
  const uniq = [...new Set(tokens)].filter((t) => RANK_BY_TOKEN.has(t));
  return {
    low: nearestToken(uniq, TARGET_RANK.low),
    medium: nearestToken(uniq, TARGET_RANK.medium),
    high: nearestToken(uniq, TARGET_RANK.high),
    xhigh: nearestToken(uniq, TARGET_RANK.xhigh),
    max: nearestToken(uniq, TARGET_RANK.max),
  };
}

function composeId(parsed: ParsedModel, token: string): string {
  const base = parsed.legacyThinkingLast ? `${parsed.family}-${token}-thinking` : `${parsed.family}-${token}`;
  return parsed.fast ? `${base}-fast` : base;
}

/** One catalog row per family: mid-effort variant id (for grouping the unfiltered list). */
export function familyRepresentativeId(models: ModelOption[], family: string, fast: boolean): string | undefined {
  const sample = models.find((m) => {
    const p = parseModelId(m.id);
    return p.family === family && p.fast === fast && p.token !== undefined;
  });
  if (!sample) return undefined;
  return modelForEffort(models, sample.id, 'medium') ?? sample.id;
}

export function modelForEffort(models: ModelOption[], id: string | undefined, e: Effort): string | undefined {
  if (!id) return undefined;
  const parsed = parseModelId(id);
  const tokens = familyTokens(models, parsed.family, parsed.fast);
  if (tokens.length <= 1) return undefined;
  const ladder = effortLadder(tokens);
  const token = ladder[e];
  if (!token) return undefined;
  const next = composeId(parsed, token);
  return models.some((m) => m.id === next) ? next : undefined;
}

export function effortOf(models: ModelOption[], id: string | undefined): Effort | undefined {
  if (!id) return undefined;
  const parsed = parseModelId(id);
  if (!parsed.token) return undefined;
  const tokens = familyTokens(models, parsed.family, parsed.fast);
  if (tokens.length <= 1) return undefined;
  const ladder = effortLadder(tokens);
  for (const step of EFFORTS) {
    if (ladder[step] === parsed.token) return step;
  }
  return undefined;
}

export function preferredEffort(): Effort {
  try {
    const v = localStorage.getItem(EFFORT_KEY);
    if (v && (EFFORTS as string[]).includes(v)) return v as Effort;
  } catch {
    /* ignore */
  }
  return 'medium';
}

export function rememberEffort(e: Effort): void {
  try {
    localStorage.setItem(EFFORT_KEY, e);
  } catch {
    /* ignore */
  }
}

/** Strip a trailing effort word from a display label (family row). */
const LABEL_EFFORT_RE = /\s+(none|minimal|low|medium|high|extra-?high|xhigh|max)$/i;

export function familyLabelFromVariantLabel(label: string): string {
  return label.replace(LABEL_EFFORT_RE, '').trim() || label;
}
