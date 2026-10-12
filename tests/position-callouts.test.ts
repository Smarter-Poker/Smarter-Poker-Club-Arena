import { describe, expect, it } from 'vitest';
import {
  POSITION_CALLOUT_MIN_HANDS,
  POSITION_NEUTRAL_COLOR,
  positionProgressPercent,
  positionRateColor,
  positionTrendLabel,
  selectPositionCallouts,
} from '../src/components/stats/positionCallouts';

describe('position performance callouts', () => {
  it('keeps low-sample positions visually and verbally neutral', () => {
    const hands = POSITION_CALLOUT_MIN_HANDS - 1;

    expect(positionTrendLabel(99, hands)).toBe('Building Sample');
    expect(positionTrendLabel(-99, hands)).toBe('Building Sample');
    expect(positionRateColor(99, hands)).toBe(POSITION_NEUTRAL_COLOR);
    expect(positionRateColor(-99, hands)).toBe(POSITION_NEUTRAL_COLOR);
    expect(positionProgressPercent(99, hands)).toBe(0);
    expect(positionProgressPercent(-99, hands)).toBe(0);
  });

  it('keeps an unmeasured rate distinct from a measured neutral rate', () => {
    expect(positionTrendLabel(null, POSITION_CALLOUT_MIN_HANDS)).toBe('Not Measured');
    expect(positionProgressPercent(null, POSITION_CALLOUT_MIN_HANDS)).toBe(0);
    expect(positionTrendLabel(0, POSITION_CALLOUT_MIN_HANDS)).toBe('Neutral');
  });

  it('ranks only known positions with enough hands', () => {
    const result = selectPositionCallouts([
      { position: 'UNK', handsPlayed: 2_000, winRate: 500 },
      { position: 'CO', handsPlayed: POSITION_CALLOUT_MIN_HANDS - 1, winRate: 80 },
      { position: 'BTN', handsPlayed: POSITION_CALLOUT_MIN_HANDS, winRate: 4.2 },
      { position: 'BB', handsPlayed: POSITION_CALLOUT_MIN_HANDS + 100, winRate: -3.1 },
    ]);

    expect(result.eligibleCount).toBe(2);
    expect(result.strongest?.position).toBe('BTN');
    expect(result.weakest?.position).toBe('BB');
  });

  it('never ranks an unmeasured rate as zero', () => {
    const result = selectPositionCallouts([
      { position: 'BTN', handsPlayed: 2_000, winRate: null },
      { position: 'CO', handsPlayed: POSITION_CALLOUT_MIN_HANDS, winRate: 3.2 },
      { position: 'BB', handsPlayed: POSITION_CALLOUT_MIN_HANDS, winRate: -2.4 },
    ]);

    expect(result.eligibleCount).toBe(2);
    expect(result.strongest?.position).toBe('CO');
    expect(result.weakest?.position).toBe('BB');
  });

  it('returns an honest no-ranking state until two positions qualify', () => {
    const result = selectPositionCallouts([
      { position: 'UNK', handsPlayed: 500, winRate: 100 },
      { position: 'BTN', handsPlayed: POSITION_CALLOUT_MIN_HANDS, winRate: 4.2 },
      { position: 'BB', handsPlayed: POSITION_CALLOUT_MIN_HANDS - 1, winRate: -20 },
    ]);

    expect(result.eligibleCount).toBe(1);
    expect(result.strongest).toBeNull();
    expect(result.weakest).toBeNull();
  });

  it('does not treat a blank position token as a known seat', () => {
    const result = selectPositionCallouts([
      { position: '   ', handsPlayed: 2_000, winRate: 99 },
      { position: 'BTN', handsPlayed: POSITION_CALLOUT_MIN_HANDS, winRate: 4.2 },
      { position: 'BB', handsPlayed: POSITION_CALLOUT_MIN_HANDS, winRate: -2.1 },
    ]);

    expect(result.eligibleCount).toBe(2);
    expect(result.strongest?.position).toBe('BTN');
    expect(result.weakest?.position).toBe('BB');
  });
});
