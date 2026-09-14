import { describe, expect, it } from 'vitest';

import { HorseMind } from './HorseMind.js';

describe('HorseMind speculative decision effects', () => {
  it('rejects an entire malformed batch before any plan becomes visible', () => {
    const handKey = `atomic-effects-${Date.now()}`;
    HorseMind.runInSandbox(HorseMind.createSandbox(), () => {
      expect(() =>
        HorseMind.applyDecisionEffects([
          { type: 'plan', handKey, userId: 'horse-effects', barrelIntent: true },
          {
            type: 'outlook',
            handKey,
            userId: 'horse-effects',
            street: 'flop',
            good: null,
            scare: [],
          } as any,
        ])
      ).toThrow();
      expect(HorseMind.getPlan(handKey, 'horse-effects')).toBeUndefined();
    });
  });
  it('keeps plan writes invisible until the authoritative action commits them', () => {
    const handKey = `effects-${Date.now()}-${Math.random()}`;
    const captured = HorseMind.captureDecisionEffects(() => {
      HorseMind.notePlan(handKey, 'horse-effects', true);
      HorseMind.noteOutlook(handKey, 'horse-effects', 'flop', ['Ah'], ['Ks']);
      HorseMind.noteRaisePlan(handKey, 'horse-effects', 'flop', 'foldToRaise');
      return 'decision';
    });

    expect(captured.value).toBe('decision');
    expect(captured.effects).toHaveLength(3);
    expect(HorseMind.getPlan(handKey, 'horse-effects')).toBeUndefined();
    expect(HorseMind.outlookOf(handKey, 'horse-effects', 'flop', 'Ah')).toBeUndefined();
    expect(HorseMind.getRaisePlan(handKey, 'horse-effects', 'flop')).toBeUndefined();

    HorseMind.applyDecisionEffects(captured.effects);
    expect(HorseMind.getPlan(handKey, 'horse-effects')).toBe(true);
    expect(HorseMind.outlookOf(handKey, 'horse-effects', 'flop', 'Ah')).toBe('good');
    expect(HorseMind.outlookOf(handKey, 'horse-effects', 'flop', 'Ks')).toBe('scare');
    expect(HorseMind.getRaisePlan(handKey, 'horse-effects', 'flop')).toBe('foldToRaise');
  });

  it('always closes a failed capture and never applies partial effects', () => {
    const handKey = `failed-effects-${Date.now()}-${Math.random()}`;
    expect(() =>
      HorseMind.captureDecisionEffects(() => {
        HorseMind.notePlan(handKey, 'horse-effects', true);
        throw new Error('decision failed');
      })
    ).toThrow('decision failed');
    expect(HorseMind.getPlan(handKey, 'horse-effects')).toBeUndefined();

    expect(() => HorseMind.captureDecisionEffects(() => 'next decision')).not.toThrow();
  });

  it('rejects nested capture instead of mixing two decisions', () => {
    expect(() =>
      HorseMind.captureDecisionEffects(() => HorseMind.captureDecisionEffects(() => undefined))
    ).toThrow('capture already active');
  });
});
