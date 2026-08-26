/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * OVERLAY ANNOUNCEMENTS — the ticker must not cry wolf
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-26: "alerting players if there is an overlay or potential overlay
 * to jump in and play!"
 *
 * The whole value of this feature is that players BELIEVE it. Every guaranteed
 * event is technically "short" from the moment it is created - the Sunday $200
 * Deep Stack opens six days early with a 20,000 guarantee and a pool of zero -
 * so a naive `prize_pool < guaranteed_prize` would put a 20,000 overlay on the
 * bar all week and train everyone to ignore the flag by Sunday.
 *
 * These pin the two conditions that stop that: the shortfall has to be NEAR
 * and MATERIAL. And they pin the one case worth shouting about, which is a
 * running event with late registration still open.
 */

import { describe, it, expect } from 'vitest';
import {
  overlayFor,
  rankOverlayAnnouncements,
  overlayMessage,
  ANNOUNCE_WITHIN_MS,
  MIN_OVERLAY_FRACTION,
  MIN_OVERLAY_CHIPS,
  type OverlayCandidate,
} from '../../src/utils/overlayAnnouncements';

const NOW = Date.parse('2026-08-30T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const HOUR = 60 * 60 * 1000;

/** The real Sunday $200 Deep Stack shape. */
const deepStack = (over: Partial<OverlayCandidate> = {}): OverlayCandidate => ({
  id: 't1',
  name: 'Sunday $200 Deep Stack',
  status: 'REGISTERING',
  start_time: at(2 * HOUR),
  guaranteed_prize: 20000,
  prize_pool: 900,
  current_players: 5,
  buy_in_amount: 180,
  late_reg_levels: 12,
  current_level: 0,
  max_players: 1000,
  ...over,
});

describe('any short guaranteed event on the board announces', () => {
  /* Dan 2026-08-26 overruled the original 12-hour window: "IT SHOULD BE
     ANNOUNCING OVERLAY ALERTS FOR ANY TOURNAMENT THAT DOESN'T APPEAR TO BE
     MEETING THE GUARANTEE."

     So distance no longer silences an announcement. What still does is
     MATERIALITY (next describe) - and what stops the flag being permanent is
     the horse ramp, which fills a guaranteed event to whatever covers it in
     the last hour. The announcement is a window that genuinely closes rather
     than a standing complaint. */
  it('announces a guarantee six days out, which is the whole publish window', () => {
    const a = overlayFor(deepStack({ start_time: at(6 * 24 * HOUR) }), NOW);
    expect(a).not.toBeNull();
    expect(a!.tier).toBe('potential');
    expect(a!.overlay).toBe(19100);
  });

  it('covers the full board: the window is at least the 6-day publish horizon', () => {
    // A 200+ buy-in publishes 6 days ahead, so anything shorter would leave
    // the flagship silent on the very day it appears.
    expect(ANNOUNCE_WITHIN_MS).toBeGreaterThanOrEqual(6 * 24 * HOUR);
  });

  it('still ignores something absurdly far out, so the window is a window', () => {
    expect(overlayFor(deepStack({ start_time: at(30 * 24 * HOUR) }), NOW)).toBeNull();
  });
});

describe('an announcement has to be MATERIAL', () => {
  it('ignores a rounding-sized gap on a big guarantee', () => {
    // 20,000 guaranteed, 19,900 collected. Technically short; not news.
    expect(overlayFor(deepStack({ prize_pool: 19900 }), NOW)).toBeNull();
  });

  it('speaks the moment the gap crosses the fraction', () => {
    const justUnder = 20000 * (1 - MIN_OVERLAY_FRACTION) + 1; // gap just under 10%
    const justOver = 20000 * (1 - MIN_OVERLAY_FRACTION) - 1; // gap just over 10%
    expect(overlayFor(deepStack({ prize_pool: justUnder }), NOW)).toBeNull();
    expect(overlayFor(deepStack({ prize_pool: justOver }), NOW)).not.toBeNull();
  });

  it('ignores a trivial absolute gap even on a tiny guarantee', () => {
    // 500 guaranteed, 450 in. That is 10% - past the fraction - but 50 chips
    // is not something to interrupt anybody for.
    expect(MIN_OVERLAY_CHIPS).toBe(100);
    expect(overlayFor(deepStack({ guaranteed_prize: 500, prize_pool: 450 }), NOW)).toBeNull();
  });

  it('never announces an event with no guarantee at all', () => {
    expect(overlayFor(deepStack({ guaranteed_prize: 0 }), NOW)).toBeNull();
    expect(overlayFor(deepStack({ guaranteed_prize: null }), NOW)).toBeNull();
  });

  it('never announces once the field has covered the guarantee', () => {
    expect(overlayFor(deepStack({ prize_pool: 20000 }), NOW)).toBeNull();
    expect(overlayFor(deepStack({ prize_pool: 25000 }), NOW)).toBeNull();
  });
});

describe('a LIVE overlay is the one worth shouting about', () => {
  it('announces a running event while late registration is open', () => {
    const a = overlayFor(
      deepStack({
        status: 'RUNNING',
        start_time: at(-30 * 60 * 1000), // started half an hour ago
        current_level: 3, // late reg runs through level 12
        prize_pool: 8000,
      }),
      NOW
    );
    expect(a).not.toBeNull();
    expect(a!.tier).toBe('live');
    expect(a!.overlay).toBe(12000);
  });

  it('goes quiet the moment late registration closes', () => {
    // current_level 12 with late_reg_levels 12 means the door has shut.
    expect(
      overlayFor(
        deepStack({
          status: 'RUNNING',
          start_time: at(-3 * HOUR),
          current_level: 12,
          prize_pool: 8000,
        }),
        NOW
      )
    ).toBeNull();
  });

  it('says nothing about a finished event', () => {
    expect(
      overlayFor(deepStack({ status: 'COMPLETED', start_time: at(-5 * HOUR) }), NOW)
    ).toBeNull();
  });
});

describe('how many more players would close it', () => {
  it('counts against the PRIZE side of the buy-in, not the total', () => {
    /* 180 of every 200 reaches the pool; the 20 fee is rake and never does.
       Using the total would understate the entries needed and overstate how
       close the event is to covering itself. */
    const a = overlayFor(deepStack({ prize_pool: 2000 }), NOW)!;
    expect(a.overlay).toBe(18000);
    expect(a.entriesToClose).toBe(100); // 18000 / 180, not 18000 / 200 = 90
  });

  it('reports zero rather than infinity on a freeroll', () => {
    const a = overlayFor(deepStack({ buy_in_amount: 0 }), NOW)!;
    expect(a.entriesToClose).toBe(0);
  });
});

describe('ranking: live first, then the biggest number', () => {
  it('puts a live overlay above a larger potential one', () => {
    const rows: OverlayCandidate[] = [
      deepStack({ id: 'potential-big', prize_pool: 0, guaranteed_prize: 50000 }),
      deepStack({
        id: 'live-small',
        status: 'RUNNING',
        start_time: at(-20 * 60 * 1000),
        current_level: 2,
        guaranteed_prize: 10000,
        prize_pool: 1000,
      }),
    ];
    const ranked = rankOverlayAnnouncements(rows, NOW);
    expect(ranked.map((r) => r.id)).toEqual(['live-small', 'potential-big']);
  });

  it('orders equal tiers by the size of the overlay', () => {
    const rows: OverlayCandidate[] = [
      deepStack({ id: 'small', guaranteed_prize: 5000, prize_pool: 0 }),
      deepStack({ id: 'big', guaranteed_prize: 40000, prize_pool: 0 }),
    ];
    expect(rankOverlayAnnouncements(rows, NOW).map((r) => r.id)).toEqual(['big', 'small']);
  });

  it('drops everything that does not qualify, rather than padding the bar', () => {
    /* `far` now QUALIFIES - Dan's rule is any short guaranteed event on the
       board. What is still dropped is a covered event and one with no
       guarantee at all, which is the difference between a useful flag and a
       permanent one. */
    const rows: OverlayCandidate[] = [
      deepStack({ id: 'far', start_time: at(5 * 24 * HOUR) }),
      deepStack({ id: 'covered', prize_pool: 20000 }),
      deepStack({ id: 'no-guarantee', guaranteed_prize: 0 }),
      deepStack({ id: 'immaterial', prize_pool: 19900 }),
      deepStack({ id: 'real' }),
    ];
    const ids = rankOverlayAnnouncements(rows, NOW, 10).map((r) => r.id);
    expect(ids).toContain('real');
    expect(ids).toContain('far');
    expect(ids).not.toContain('covered');
    expect(ids).not.toContain('no-guarantee');
    expect(ids).not.toContain('immaterial');
  });

  it('survives junk without throwing', () => {
    expect(rankOverlayAnnouncements([], NOW)).toEqual([]);
    expect(
      rankOverlayAnnouncements(
        [deepStack({ start_time: 'not a date' }), deepStack({ id: '' })],
        NOW
      )
    ).toEqual([]);
  });
});

describe('the copy leads with the money', () => {
  it('a potential overlay tells the player what would close it', () => {
    const msg = overlayMessage(overlayFor(deepStack({ prize_pool: 2000 }), NOW)!);
    expect(msg.startsWith('18,000 Potential Overlay')).toBe(true);
    expect(msg).toContain('20,000 Guaranteed');
    expect(msg).toContain('100 More To Cover It');
    expect(msg).toContain('Jump In');
    expect(msg).not.toContain('—'); // house rule: no em dashes in player copy
  });

  it('a live overlay says the door is still open', () => {
    const a = overlayFor(
      deepStack({
        status: 'RUNNING',
        start_time: at(-20 * 60 * 1000),
        current_level: 2,
        prize_pool: 8000,
      }),
      NOW
    )!;
    const msg = overlayMessage(a);
    expect(msg.startsWith('12,000 Overlay Right Now')).toBe(true);
    expect(msg).toContain('Late Registration Open');
    expect(msg).toContain('Jump In Now');
  });
});
