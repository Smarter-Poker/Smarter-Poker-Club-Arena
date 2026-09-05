/**
 * A BARRED HORSE IS NOT A BUYER (2026-09-05).
 *
 * The door rules the fleet reads before it tries a seat: the VPIP bar
 * (fn_cash_rejoin_floor raises VPIP_BARRED) and the rejoin floor
 * (BUYIN_BELOW_FLOOR). Measured before the fleet read them: 341 of 349
 * buy-in refusals in one hour were VPIP_BARRED, from 35 horses holding 57
 * active bars, every one counted as a buyer first.
 */
import { describe, it, expect } from 'vitest';
import {
  applyRejoinFloor,
  buildRejoinConstraints,
  rejoinPlayerKey,
  rejoinTableKey,
} from './HorseRejoinConstraints.js';

const NOW = Date.parse('2026-09-05T08:00:00Z');
const later = (mins: number) => new Date(NOW + mins * 60_000).toISOString();

const row = (over: Partial<Parameters<typeof buildRejoinConstraints>[0][number]> = {}) => ({
  player_id: 'horse-1',
  club_id: 'club-1',
  variant: 'nlh',
  sb: '0.50',
  bb: '1.00',
  required_stack: '0.01',
  barred_until: null,
  expires_at: later(60),
  ...over,
});

describe('the key is the SQL key', () => {
  it('numeric blinds from Postgres ("0.50") and numbers from the table row (0.5) meet', () => {
    const fromRow = rejoinTableKey({
      club_id: 'club-1',
      game_variant: 'nlh',
      small_blind: '0.50',
      big_blind: '1.00',
    });
    const fromTable = rejoinTableKey({
      club_id: 'club-1',
      game_variant: 'nlh',
      small_blind: 0.5,
      big_blind: 1,
    });
    expect(fromRow).toBe(fromTable);
    expect(fromRow).toBe('club-1|nlh|0.5|1');
  });

  it('a different stake, variant or club is a different game', () => {
    const base = { club_id: 'c', game_variant: 'nlh', small_blind: 1, big_blind: 2 };
    const k = rejoinTableKey(base);
    expect(rejoinTableKey({ ...base, big_blind: 3 })).not.toBe(k);
    expect(rejoinTableKey({ ...base, game_variant: 'plo4' })).not.toBe(k);
    expect(rejoinTableKey({ ...base, club_id: 'd' })).not.toBe(k);
  });
});

describe('buildRejoinConstraints', () => {
  it('a bar still in force bars exactly that horse in exactly that game', () => {
    const c = buildRejoinConstraints([row({ barred_until: later(90) })], NOW);
    const game = rejoinTableKey({
      club_id: 'club-1',
      game_variant: 'nlh',
      small_blind: 0.5,
      big_blind: 1,
    });
    expect(c.barred.has(rejoinPlayerKey('horse-1', game))).toBe(true);
    // a different horse at the same table is unaffected
    expect(c.barred.has(rejoinPlayerKey('horse-2', game))).toBe(false);
    // the same horse in the next stake up is unaffected
    const nextStake = rejoinTableKey({
      club_id: 'club-1',
      game_variant: 'nlh',
      small_blind: 1,
      big_blind: 2,
    });
    expect(c.barred.has(rejoinPlayerKey('horse-1', nextStake))).toBe(false);
  });

  it('a bar that has lifted does not bar, even while the floor row is still alive', () => {
    const c = buildRejoinConstraints(
      [row({ barred_until: later(-1), required_stack: '250', expires_at: later(60) })],
      NOW
    );
    expect(c.barred.size).toBe(0);
    expect(c.rejoinFloor.get(rejoinPlayerKey('horse-1', 'club-1|nlh|0.5|1'))).toBe(250);
  });

  it('an expired row is ignored entirely', () => {
    const c = buildRejoinConstraints(
      [row({ barred_until: later(90), required_stack: '250', expires_at: later(-1) })],
      NOW
    );
    expect(c.barred.size).toBe(0);
    expect(c.rejoinFloor.size).toBe(0);
  });

  it('two floors for one game keep the higher', () => {
    const c = buildRejoinConstraints(
      [row({ required_stack: '120' }), row({ required_stack: '300' }), row({ required_stack: 80 })],
      NOW
    );
    expect(c.rejoinFloor.get(rejoinPlayerKey('horse-1', 'club-1|nlh|0.5|1'))).toBe(300);
  });

  it('a bar-only row (the one-cent floor) bars but does not meaningfully raise a buy-in', () => {
    const c = buildRejoinConstraints([row({ barred_until: later(30) })], NOW);
    const key = rejoinPlayerKey('horse-1', 'club-1|nlh|0.5|1');
    expect(c.barred.has(key)).toBe(true);
    expect(applyRejoinFloor(100, c.rejoinFloor.get(key), 200)).toBe(100);
  });
});

describe('applyRejoinFloor - what the buy-in modal shows a human', () => {
  it('raises a buy-in below the floor to the floor', () => {
    expect(applyRejoinFloor(100, 180, 200)).toBe(180);
  });
  it('leaves a buy-in already at or above the floor alone', () => {
    expect(applyRejoinFloor(190, 180, 200)).toBe(190);
    expect(applyRejoinFloor(180, 180, 200)).toBe(180);
  });
  it('clamps at the table max, exactly as fn_cash_effective_buyin does', () => {
    expect(applyRejoinFloor(100, 450, 200)).toBe(200);
  });
  it('no floor, no change', () => {
    expect(applyRejoinFloor(100, undefined, 200)).toBe(100);
    expect(applyRejoinFloor(100, Number.NaN, 200)).toBe(100);
  });
  it('never lowers a buy-in', () => {
    expect(applyRejoinFloor(250, 100, 200)).toBe(250);
  });
});
