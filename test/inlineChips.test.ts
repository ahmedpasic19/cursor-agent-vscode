import { describe, expect, it } from 'vitest';
import { authFileCandidates, readCliToken, toPlanUsage } from '../src/account/planUsage';
import { buildPrompt, titleFrom } from '../src/session/promptBuilder';
import { chipIdsIn, chipLabel, chipToken, expandChipTokens, splitChipTokens } from '../src/shared/inlineChips';
import type { ContextChip } from '../src/shared/protocol';

const sel: ContextChip = {
  id: 'c1',
  kind: 'selection',
  path: 'src/main.rs',
  absPath: 'C:/ws/src/main.rs',
  startLine: 158,
  endLine: 167,
  language: 'rust',
  text: 'fn main() {}',
};
const file: ContextChip = { id: 'c2', kind: 'file', path: 'src/main.rs', absPath: 'C:/ws/src/main.rs', isFolder: false };
const text = `Some test text is written ${chipToken('c1')} and then the code is added and ${chipToken('c2')} files`;

describe('inline chip tokens', () => {
  it('finds chip ids in order', () => {
    expect(chipIdsIn(text)).toEqual(['c1', 'c2']);
  });

  it('labels chips like the composer shows them', () => {
    expect(chipLabel(sel)).toBe('main.rs (158-167)');
    expect(chipLabel(file)).toBe('main.rs');
  });

  it('expands tokens to @mentions, dropping unknown chips', () => {
    expect(expandChipTokens(text, [sel, file])).toBe('Some test text is written @src/main.rs:158-167 and then the code is added and @src/main.rs files');
    expect(expandChipTokens(`a ${chipToken('gone')} b`, [sel])).toBe('a  b');
    expect(expandChipTokens('no chips', undefined)).toBe('no chips');
  });

  it('splits text into strings and chips for rendering', () => {
    const parts = splitChipTokens(text, [sel, file]);
    expect(parts.map((p) => (typeof p === 'string' ? p : `[${p.id}]`))).toEqual([
      'Some test text is written ',
      '[c1]',
      ' and then the code is added and ',
      '[c2]',
      ' files',
    ]);
  });

  it('sends inline mentions plus the attached context to the model', () => {
    const prompt = buildPrompt({ text, mode: 'agent', chips: [sel, file], cwd: 'C:/ws' });
    expect(prompt).toContain('<selection path="src/main.rs" lines="158-167" language="rust">');
    expect(prompt).toContain('<user_message>\nSome test text is written @src/main.rs:158-167 and then');
    // Whole-file chip is omitted when a selection for the same path is attached (snippet is enough).
    expect(prompt).not.toContain('<file path="src/main.rs"');
    expect(prompt).not.toMatch(/[\uE000\uE001]/);
  });

  it('titles use readable labels', () => {
    expect(titleFrom(expandChipTokens(`fix ${chipToken('c1')}`, [sel], chipLabel), 60)).toBe('fix main.rs (158-167)');
  });
});

describe('plan usage', () => {
  it('maps GetCurrentPeriodUsage + GetPlanInfo', () => {
    const u = toPlanUsage(
      {
        billingCycleEnd: '1796101105000',
        planUsage: { totalPercentUsed: 20.27, autoPercentUsed: 16.76, apiPercentUsed: 90.58 },
        spendLimitUsage: { limitType: 'user' },
        autoModelSelectedDisplayMessage: "You've used 20% of your included total usage",
      },
      { planInfo: { planName: 'Pro' } },
    );
    expect(u).toEqual({
      planName: 'Pro',
      includedPct: 20.27,
      autoPct: 16.76,
      apiPct: 90.58,
      onDemand: { enabled: false },
      cycleEnd: 1796101105000,
      message: "You've used 20% of your included total usage",
    });
  });

  it('reports an on-demand limit when one is set', () => {
    expect(toPlanUsage({ spendLimitUsage: { individualLimit: 5000, individualUsed: 1234 } }).onDemand).toEqual({
      enabled: true,
      usedCents: 1234,
      limitCents: 5000,
    });
  });

  it('looks for the CLI login in the platform locations', () => {
    expect(authFileCandidates({ APPDATA: 'C:/Users/u/AppData/Roaming' }, 'win32', 'C:/Users/u')[0]!.replace(/\\/g, '/')).toBe(
      'C:/Users/u/AppData/Roaming/Cursor/auth.json',
    );
    expect(readCliToken(['/definitely/missing/auth.json'])).toBeUndefined();
  });
});
