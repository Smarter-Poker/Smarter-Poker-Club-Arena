import { describe, expect, it } from 'vitest';
import { buildStatsIntelligenceBrief } from '../src/components/stats/statsIntelligenceBrief';

describe('buildStatsIntelligenceBrief', () => {
  it('anchors every strongest-segment claim to a qualified sample', () => {
    const brief = buildStatsIntelligenceBrief({
      overall: { total_hands: 8_200, cash_hands: 7_500 },
      positions: [
        { position: 'UTG', hands_played: 800, bb100: -2.4 },
        { position: 'BTN', hands_played: 1_200, bb100: 8.6 },
        { position: 'SB', hands_played: 12, bb100: 90 },
      ],
      variants: [
        { variant: 'holdem', hands: 4_000, bb100: 3.2 },
        { variant: 'omaha', hands: 22, bb100: 40 },
      ],
      daily: [
        { date: '2026-08-29', profit: -10 },
        { date: '2026-08-30', profit: 35 },
      ],
    });

    expect(brief).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'sample', value: 'Established' }),
        expect.objectContaining({
          id: 'position',
          value: 'BTN',
          detail: '+8.6 BB/100 across 1,200 hands.',
        }),
        expect.objectContaining({ id: 'game', value: 'HOLDEM' }),
        expect.objectContaining({
          id: 'trend',
          value: 'Positive',
          detail: '+25 over the latest 2 recorded days.',
        }),
      ])
    );
  });

  it('says it is building a sample instead of ranking noise', () => {
    const brief = buildStatsIntelligenceBrief({
      overall: { total_hands: 80, cash_hands: 80 },
      positions: [{ position: 'BTN', hands_played: 20, bb100: 100 }],
      variants: [{ variant: 'holdem', hands: 20, bb100: 100 }],
    });

    expect(brief.find((item) => item.id === 'sample')?.value).toBe('Early Read');
    expect(brief.find((item) => item.id === 'position')?.value).toBe('Building Sample');
    expect(brief.find((item) => item.id === 'game')?.value).toBe('Building Sample');
    expect(brief.find((item) => item.id === 'trend')?.value).toBe('No Results');
  });
});
