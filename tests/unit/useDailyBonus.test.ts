/**
 * useDailyBonus.applyClaim - what the sheet shows after a claim is what the
 * ledger said, and every other diamond tile re-reads the cap it now faces.
 */
import { describe, expect, it } from 'vitest';
import { applyClaim } from '../../src/components/daily-bonus/useDailyBonus';
import type { DailyBonusStatus, DailyBonusTile } from '../../src/services/DailyBonusService';

const tile = (over: Partial<DailyBonusTile>): DailyBonusTile => ({
  slot: 1,
  kind: 'diamonds',
  label: 'Diamonds',
  vip_only: false,
  quantity: 0,
  base_diamonds: 50,
  diamonds: 50,
  claimed: false,
  claimed_at: null,
  granted: null,
  locked: false,
  capped: false,
  ...over,
});

const status = (): DailyBonusStatus => ({
  eligible: true,
  today: '2026-09-08',
  reset_at: '2026-09-09T05:00:00+00:00',
  seconds_to_reset: 100,
  streak: 7,
  cycle_day: 7,
  streak_day: null,
  multiplier: 1.5,
  is_vip: true,
  claimed_today: false,
  shown_today: false,
  unclaimed: 3,
  tiles: [
    tile({ slot: 1, diamonds: 75 }),
    tile({
      slot: 2,
      kind: 'throwables',
      label: 'Throwables',
      quantity: 5,
      base_diamonds: 0,
      diamonds: 0,
    }),
    tile({ slot: 5, label: 'VIP Bonus', vip_only: true, base_diamonds: 10, diamonds: 15 }),
  ],
  week: [],
  tomorrow: [],
  shield: { held: 0, expires_at: null },
  boost: { active: false },
  streak_protected: false,
  caps: {
    daily_cap: 150,
    daily_used: 70,
    daily_remaining: 80,
    monthly_cap: 4500,
    monthly_used: 70,
    monthly_remaining: 4430,
    bonus_monthly_cap: 3750,
    bonus_monthly_used: 70,
    bonus_monthly_remaining: 3680,
    frozen: false,
  },
  cents_per_diamond: 1,
});

describe('applyClaim', () => {
  it('marks the tile with what was granted, moves the caps, and re-flags the other diamond tiles', () => {
    const next = applyClaim(status(), 1, {
      success: true,
      granted: { kind: 'diamonds', diamonds: 75, quantity: 0, balance_after: 1000 },
      streak: 7,
    });
    expect(next.tiles[0].claimed).toBe(true);
    expect(next.tiles[0].granted?.diamonds).toBe(75);
    expect(next.caps?.daily_used).toBe(145);
    expect(next.caps?.daily_remaining).toBe(5);
    // 15 > 5 remaining: the VIP tile would now be trimmed, and says so.
    expect(next.tiles[2].capped).toBe(true);
    expect(next.tiles[1].capped).toBe(false);
    expect(next.unclaimed).toBe(2);
    expect(next.claimed_today).toBe(true);
  });

  it('a trimmed grant is shown as granted, not as offered', () => {
    const next = applyClaim(status(), 1, {
      success: true,
      granted: { kind: 'diamonds', diamonds: 80, quantity: 0, balance_after: 1000 },
    });
    expect(next.tiles[0].granted?.diamonds).toBe(80);
    expect(next.caps?.daily_remaining).toBe(0);
  });

  it('a consumable grant leaves the diamond caps alone', () => {
    const next = applyClaim(status(), 2, {
      success: true,
      granted: { kind: 'throwables', diamonds: 0, quantity: 5, balance_after: 1000 },
    });
    expect(next.caps).toEqual(status().caps);
    expect(next.tiles[1].claimed).toBe(true);
    expect(next.tiles[2].capped).toBe(false);
  });

  it('a shield grant is held, with the expiry the ledger gave it', () => {
    const prev = status();
    prev.tiles.push(
      tile({
        slot: 3,
        kind: 'shield',
        label: 'Streak Shield',
        quantity: 1,
        base_diamonds: 0,
        diamonds: 0,
      })
    );
    const next = applyClaim(prev, 3, {
      success: true,
      slot: 3,
      granted: {
        kind: 'shield',
        feature: 'streak_shield',
        quantity: 1,
        diamonds: 0,
        expires_at: '2026-10-08T05:00:00+00:00',
        balance_after: 500,
      },
    });
    expect(next.shield).toEqual({ held: 1, expires_at: '2026-10-08T05:00:00+00:00' });
    expect(next.boost).toEqual({ active: false });
    expect(next.caps).toEqual(prev.caps);
    expect(next.tiles.find((t) => t.slot === 3)?.claimed).toBe(true);
  });

  it('a boost grant is running for the hours the ledger gave it, and moves no diamonds', () => {
    const prev = status();
    prev.tiles.push(
      tile({
        slot: 4,
        kind: 'boost',
        label: 'Mission Boost',
        quantity: 24,
        base_diamonds: 0,
        diamonds: 0,
      })
    );
    const next = applyClaim(prev, 4, {
      success: true,
      slot: 4,
      granted: {
        kind: 'boost',
        factor: 2,
        hours: 24,
        quantity: 24,
        diamonds: 0,
        ends_at: '2026-09-09T18:00:00+00:00',
        balance_after: 500,
      },
    });
    expect(next.boost.active).toBe(true);
    expect(next.boost.factor).toBe(2);
    expect(next.boost.seconds_left).toBe(24 * 3600);
    expect(next.boost.ends_at).toBe('2026-09-09T18:00:00+00:00');
    expect(next.caps).toEqual(prev.caps);
  });

  it('a mystery claim keeps what it revealed, lucky roll included, and moves the caps by what was paid', () => {
    const prev = status();
    prev.tiles.push(
      tile({
        slot: 2,
        kind: 'mystery',
        label: 'Mystery Tile',
        quantity: 0,
        base_diamonds: 0,
        diamonds: 0,
      })
    );
    const next = applyClaim(prev, 2, {
      success: true,
      slot: 2,
      granted: { kind: 'diamonds', diamonds: 20, quantity: 0, balance_after: 520, lucky: 2 },
      revealed: { kind: 'diamonds', diamonds: 20, quantity: 0, lucky: 2 },
    });
    const t = next.tiles.find((x) => x.slot === 2);
    expect(t?.revealed?.lucky).toBe(2);
    expect(t?.granted?.diamonds).toBe(20);
    expect(next.caps?.daily_used).toBe((prev.caps?.daily_used ?? 0) + 20);
  });

  it('is a no-op without a grant', () => {
    const prev = status();
    expect(applyClaim(prev, 1, { success: false, reason: 'daily_cap' })).toBe(prev);
  });
});
