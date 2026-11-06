import type { ModelOption } from '../../src/shared/protocol';

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

/** Strip a trailing effort word from a display label (family row). */
const LABEL_EFFORT_RE = /\s+(none|minimal|low|medium|high|extra-?high|xhigh|max)$/i;

export function familyLabelFromVariantLabel(label: string): string {
  return label.replace(LABEL_EFFORT_RE, '').trim() || label;
}

/**
 * One id per family row: mid-rank variant when multiple tiers exist, otherwise the lone id.
 */
export function representativeIdForFamilyGroup(group: ModelOption[]): string {
  const withTok = group.filter((m) => parseModelId(m.id).token !== undefined);
  const rowModels = withTok.length > 0 ? withTok : group;
  const rep = rowModels.reduce<string | undefined>((best, m) => {
    const p = parseModelId(m.id);
    if (!p.token) return best;
    if (!best) return m.id;
    const bRank = parseModelId(best).rank ?? 99;
    return Math.abs((p.rank ?? 99) - 3) < Math.abs(bRank - 3) ? m.id : best;
  }, undefined);
  return rep ?? rowModels[0]!.id;
}

export function familyRepresentativeId(models: ModelOption[], family: string, fast: boolean): string | undefined {
  const group = models.filter((m) => {
    const q = parseModelId(m.id);
    return q.family === family && q.fast === fast;
  });
  if (group.length === 0) return undefined;
  return representativeIdForFamilyGroup(group);
}
