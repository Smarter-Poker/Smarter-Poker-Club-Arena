/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * OVERLAY ANNOUNCEMENTS — running events only, and only late in late reg
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-26, overruling the previous 7-day pre-start window: "YOU NEVER
 * ANNOUNCE AN OVERLAY FOR EVENTS IN THE FUTURE, ONLY FOR EVENTS THAT ARE
 * CURRENTLY RUNNING. AND YOU SHOULDN'T MAKE ANY ANNOUNCEMENT OF ANY TOURNAMENT
 * UNTIL IT'S 75% OF THE WAY DOWN WITH LATE REGISTRATION."
 *
 * The whole value of this feature is that players BELIEVE it. A Sunday event
 * flagged on Wednesday is not an overlay, it is a field that has not arrived
 * yet. The only moment a shortfall is both real and actionable is the last
 * quarter of late registration on a running event — so that is the only
 * moment the ticker speaks.
 */

import { describe, it, expect } from 'vitest';
import {
  overlayFor,
  rankOverlayAnnouncements,
  overlayMessage,
  LATE_REG_ANNOUNCE_FRACTION,
  MIN_OVERLAY_FRACTION,
  MIN_OVERLAY_CHIPS,
  type OverlayCandidate,
} from '../../src/utils/overlayAnnouncements';

const NOW = Date.parse('2026-08-30T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

/** A running Sunday $200 Deep Stack, 50 minutes into a 60-minute late-reg
 *  window (83% elapsed — past the 75% announce point, door still open). */
const runningDeepStack = (over: Partial<OverlayCandidate> = {}): OverlayCandidate => ({
  id: 't1',
  name: 'Sunday $200 Deep Stack',
  status: 'RUNNING',
  start_time: at(-50 * MIN),
  started_at: at(-50 * MIN),
  late_reg_mins: 60,
  late_reg_levels: 0,
  guaranteed_prize: 20000,
  prize_pool: 900,
  current_players: 5,
  buy_in_amount: 180,
  current_level: 3,
  max_players: 1000,
  ...over,
});

describe('future events NEVER announce', () => {
  it('says nothing about a registering event, however short and however soon', () => {
    expect(
      overlayFor(
        runningDeepStack({ status: 'REGISTERING', start_time: at(2 * HOUR), started_at: null }),
        NOW
      )
    ).toBeNull();
  });

  it('says nothing about an announced event six days out', () => {
    expect(
      overlayFor(
        runningDeepStack({ status: 'ANNOUNCED', start_time: at(6 * 24 * HOUR), started_at: null }),
        NOW
      )
    ).toBeNull();
  });
});

describe('a running event announces only past 75% of late registration', () => {
  it('announces at 83% of the window with the door open', () => {
    const a = overlayFor(runningDeepStack(), NOW);
    expect(a).not.toBeNull();
    expect(a!.tier).toBe('live');
    expect(a!.overlay).toBe(19100);
  });

  it('stays quiet at 50% of the window', () => {
    expect(
      overlayFor(runningDeepStack({ start_time: at(-30 * MIN), started_at: at(-30 * MIN) }), NOW)
    ).toBeNull();
  });

  it('crosses over exactly at the announce fraction', () => {
    expect(LATE_REG_ANNOUNCE_FRACTION).toBe(0.75);
    const justBefore = -(45 * MIN - 1000); // 44:59 elapsed of 60:00 → under 75%
    const justAfter = -(45 * MIN + 1000); // 45:01 elapsed of 60:00 → over 75%
    expect(
      overlayFor(runningDeepStack({ start_time: at(justBefore), started_at: at(justBefore) }), NOW)
    ).toBeNull();
    expect(
      overlayFor(runningDeepStack({ start_time: at(justAfter), started_at: at(justAfter) }), NOW)
    ).not.toBeNull();
  });

  it('goes quiet the moment late registration closes', () => {
    expect(
      overlayFor(runningDeepStack({ start_time: at(-61 * MIN), started_at: at(-61 * MIN) }), NOW)
    ).toBeNull();
  });

  it('says nothing about a finished event', () => {
    expect(
      overlayFor(runningDeepStack({ status: 'COMPLETED', start_time: at(-5 * HOUR) }), NOW)
    ).toBeNull();
  });

  it('fails CLOSED when the row cannot prove where the window ends', () => {
    /* Level-gated late reg with no blind_structure / level_started_at: the
       75% point cannot be placed, so nothing is announced. Never announce on
       a guess. */
    expect(
      overlayFor(
        runningDeepStack({ late_reg_mins: 0, late_reg_levels: 12, current_level: 3 }),
        NOW
      )
    ).toBeNull();
  });
});

describe('an announcement has to be MATERIAL', () => {
  it('ignores a rounding-sized gap on a big guarantee', () => {
    expect(overlayFor(runningDeepStack({ prize_pool: 19900 }), NOW)).toBeNull();
  });

  it('speaks the moment the gap crosses the fraction', () => {
    const justUnder = 20000 * (1 - MIN_OVERLAY_FRACTION) + 1; // gap just under 10%
    const justOver = 20000 * (1 - MIN_OVERLAY_FRACTION) - 1; // gap just over 10%
    expect(overlayFor(runningDeepStack({ prize_pool: justUnder }), NOW)).toBeNull();
    expect(overlayFor(runningDeepStack({ prize_pool: justOver }), NOW)).not.toBeNull();
  });

  it('ignores a trivial absolute gap even on a tiny guarantee', () => {
    expect(MIN_OVERLAY_CHIPS).toBe(100);
    expect(
      overlayFor(runningDeepStack({ guaranteed_prize: 500, prize_pool: 450 }), NOW)
    ).toBeNull();
  });

  it('never announces an event with no guarantee at all', () => {
    expect(overlayFor(runningDeepStack({ guaranteed_prize: 0 }), NOW)).toBeNull();
    expect(overlayFor(runningDeepStack({ guaranteed_prize: null }), NOW)).toBeNull();
  });

  it('never announces once the field has covered the guarantee', () => {
    expect(overlayFor(runningDeepStack({ prize_pool: 20000 }), NOW)).toBeNull();
    expect(overlayFor(runningDeepStack({ prize_pool: 25000 }), NOW)).toBeNull();
  });
});

describe('how many more players would close it', () => {
  it('counts against the PRIZE side of the buy-in, not the total', () => {
    const a = overlayFor(runningDeepStack({ prize_pool: 2000 }), NOW)!;
    expect(a.overlay).toBe(18000);
    expect(a.entriesToClose).toBe(100); // 18000 / 180, not 18000 / 200 = 90
  });

  it('reports zero rather than infinity on a freeroll', () => {
    const a = overlayFor(runningDeepStack({ buy_in_amount: 0 }), NOW)!;
    expect(a.entriesToClose).toBe(0);
  });
});

describe('ranking: biggest live overlay first', () => {
  it('orders by the size of the overlay', () => {
    const rows: OverlayCandidate[] = [
      runningDeepStack({ id: 'small', guaranteed_prize: 5000, prize_pool: 0 }),
      runningDeepStack({ id: 'big', guaranteed_prize: 40000, prize_pool: 0 }),
    ];
    expect(rankOverlayAnnouncements(rows, NOW).map((r) => r.id)).toEqual(['big', 'small']);
  });

  it('drops everything that does not qualify, rather than padding the bar', () => {
    const rows: OverlayCandidate[] = [
      runningDeepStack({ id: 'future', status: 'REGISTERING', start_time: at(5 * 24 * HOUR) }),
      runningDeepStack({ id: 'early', start_time: at(-20 * MIN), started_at: at(-20 * MIN) }),
      runningDeepStack({ id: 'covered', prize_pool: 20000 }),
      runningDeepStack({ id: 'no-guarantee', guaranteed_prize: 0 }),
      runningDeepStack({ id: 'immaterial', prize_pool: 19900 }),
      runningDeepStack({ id: 'real' }),
    ];
    const ids = rankOverlayAnnouncements(rows, NOW, 10).map((r) => r.id);
    expect(ids).toEqual(['real']);
  });

  it('survives junk without throwing', () => {
    expect(rankOverlayAnnouncements([], NOW)).toEqual([]);
    expect(
      rankOverlayAnnouncements(
        [runningDeepStack({ start_time: 'not a date', started_at: 'not a date' }), runningDeepStack({ id: '' })],
        NOW
      )
    ).toEqual([]);
  });
});

describe('the copy leads with the money', () => {
  it('a live overlay says the door is still open', () => {
    const a = overlayFor(runningDeepStack({ prize_pool: 8000 }), NOW)!;
    const msg = overlayMessage(a);
    expect(msg.startsWith('12,000 Overlay Right Now')).toBe(true);
    expect(msg).toContain('20,000 Guaranteed');
    expect(msg).toContain('Late Registration Open');
    expect(msg).toContain('Jump In Now');
    expect(msg).not.toContain('—'); // house rule: no em dashes in player copy
  });
});
