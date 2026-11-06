import { describe, expect, it } from 'vitest';
import type { ModelOption } from '../src/shared/protocol';
import { familyRepresentativeId, parseModelId, representativeIdForFamilyGroup } from '../webview-ui/src/modelId';

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

describe('representativeIdForFamilyGroup', () => {
  it('picks variant closest to medium rank (ties → lower rank)', () => {
    const sparse: ModelOption[] = [
      { id: 'kimi-k3-low', label: 'kimi-k3-low' },
      { id: 'kimi-k3-high', label: 'kimi-k3-high' },
      { id: 'kimi-k3-max', label: 'kimi-k3-max' },
    ];
    // low and high are equally close to "medium" (rank 3); implementation prefers the lower rank.
    expect(representativeIdForFamilyGroup(sparse)).toBe('kimi-k3-low');

    const withMedium: ModelOption[] = [
      { id: 'demo-low', label: 'demo-low' },
      { id: 'demo-medium', label: 'demo-medium' },
      { id: 'demo-high', label: 'demo-high' },
    ];
    expect(representativeIdForFamilyGroup(withMedium)).toBe('demo-medium');
  });
});

describe('familyRepresentativeId', () => {
  it('returns undefined when family has no variants', () => {
    const models: ModelOption[] = [{ id: 'auto', label: 'Auto' }];
    expect(familyRepresentativeId(models, 'auto', false)).toBeUndefined();
  });
});
