import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelOption } from '../src/shared/protocol';
import {
  effortLadder,
  familyTokens,
  modelForEffort,
  parseModelId,
  preferredEffort,
  rememberEffort,
} from '../webview-ui/src/effort';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixtureModelIds(): string[] {
  const raw = readFileSync(join(__dirname, 'fixtures', 'invalid-model.stderr.txt'), 'utf8');
  const m = raw.match(/Available models:\s*(.+)/);
  if (!m?.[1]) throw new Error('Could not parse invalid-model.stderr.txt');
  return m[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean);
}

const ALL_IDS = loadFixtureModelIds();
const ALL_MODELS: ModelOption[] = ALL_IDS.map((id) => ({ id, label: id }));

describe('parseModelId', () => {
  it('round-trips claude-opus-5-5-xhigh-fast', () => {
    const p = parseModelId('claude-opus-5-5-xhigh-fast');
    expect(p.family).toBe('claude-opus-5-5');
    expect(p.token).toBe('xhigh');
    expect(p.fast).toBe(true);
    expect(p.legacyThinkingLast).toBe(false);
  });

  it('preserves -thinking infix: claude-opus-5-thinking-max', () => {
    const p = parseModelId('claude-opus-5-thinking-max');
    expect(p.family).toBe('claude-opus-5');
    expect(p.token).toBe('max');
    expect(p.legacyThinkingLast).toBe(false);
  });

  it('legacy order: claude-4.6-sonnet-medium-thinking', () => {
    const p = parseModelId('claude-4.6-sonnet-medium-thinking');
    expect(p.family).toBe('claude-4.6-sonnet');
    expect(p.token).toBe('medium');
    expect(p.legacyThinkingLast).toBe(true);
  });
});

describe('extra-high vs high', () => {
  it('matches longest token: gpt-5.5-extra-high', () => {
    const p = parseModelId('gpt-5.5-extra-high');
    expect(p.token).toBe('extra-high');
    expect(p.family).toBe('gpt-5.5');
  });
});

describe('no effort token', () => {
  it('auto, composer-2.5, kimi-k2.7-code have no effort suffix', () => {
    for (const id of ['auto', 'composer-2.5', 'kimi-k2.7-code']) {
      expect(parseModelId(id).token, id).toBeUndefined();
    }
  });
});

describe('effortLadder', () => {
  it('kimi-k3 sparsity: medium maps to low', () => {
    const ids = ['kimi-k3-low', 'kimi-k3-high', 'kimi-k3-max'];
    const models = ids.map((id) => ({ id, label: id }));
    const toks = familyTokens(models, 'kimi-k3', false);
    const ladder = effortLadder(toks);
    expect(ladder.low).toBe('low');
    expect(ladder.medium).toBe('low');
    expect(ladder.high).toBe('high');
    expect(ladder.max).toBe('max');
  });
});

describe('modelForEffort', () => {
  it('returns undefined when target id is not in list (legacy sonnet + high)', () => {
    const id = 'claude-4.6-sonnet-medium-thinking';
    expect(ALL_IDS.includes('claude-4.6-sonnet-high-thinking')).toBe(false);
    expect(modelForEffort(ALL_MODELS, id, 'high')).toBeUndefined();
  });

  it('only returns ids that exist in the model list (spot-check + families)', () => {
    const set = new Set(ALL_IDS);
    const sample = ALL_IDS.filter((_, i) => i % 7 === 0);
    for (const start of sample) {
      for (const step of ['low', 'medium', 'high', 'max'] as const) {
        const next = modelForEffort(ALL_MODELS, start, step);
        if (next !== undefined) expect(set.has(next)).toBe(true);
      }
    }
    for (const fam of ['claude-opus-5-5', 'gpt-5.5', 'muse-wonder-1.0'] as const) {
      const start = ALL_IDS.find((id) => id.startsWith(`${fam}-`) && !id.endsWith('-fast'));
      if (!start) continue;
      for (const step of ['low', 'medium', 'high', 'max'] as const) {
        const next = modelForEffort(ALL_MODELS, start, step);
        if (next !== undefined) expect(set.has(next)).toBe(true);
      }
    }
  });

  it('at Max preference, sonnet 5.5 family resolves to -max variant', () => {
    const cur = 'claude-sonnet-5-5-medium';
    expect(modelForEffort(ALL_MODELS, cur, 'max')).toBe('claude-sonnet-5-5-max');
  });
});

describe('sticky preferred effort (localStorage)', () => {
  const store: Record<string, string> = {};

  beforeEach(() => {
    Object.keys(store).forEach((k) => delete store[k]);
    vi.stubGlobal(
      'localStorage',
      {
        getItem: (k: string) => (k in store ? store[k]! : null),
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
        removeItem: (k: string) => {
          delete store[k];
        },
        clear: () => {
          Object.keys(store).forEach((k) => delete store[k]);
        },
      } as Storage,
    );
  });

  it('default is medium; remember max round-trips', () => {
    expect(preferredEffort()).toBe('medium');
    rememberEffort('max');
    expect(preferredEffort()).toBe('max');
  });
});
