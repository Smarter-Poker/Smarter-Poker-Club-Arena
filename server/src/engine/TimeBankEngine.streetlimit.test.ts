/**
 * TIME BANK RULES — Bible V8 §6.2, as ruled by the owner on 2026-08-18.
 *
 *   Standard decision clock ... 15 seconds  (action_time_seconds, unchanged)
 *   One time bank grants ...... 20 seconds  (was 15)
 *   Limit ..................... 2 activations PER STREET, never more (was 2 per hand)
 *
 * The two numbers are easy to conflate and have been conflated before: FIX 200
 * set the grant to 15 with the note "was incorrectly 20". 15 is the decision
 * clock; 20 is what a bank adds on top of it. Both live here now so the next
 * person changing one has to look at the other.
 *
 * The per-street limit is the part with teeth. It used to be per HAND, so a
 * player who spent both banks preflop had none for the flop, turn or river no
 * matter how much time they still owned. Two things must therefore be true:
 * the counter resets on a new street, and the seconds pool still caps everything
 * — a fresh street must not conjure a bank the player has not got.
 */

import { describe, it, expect } from 'vitest';
import { TimeBankEngine } from './TimeBankEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const noop = () => {};

/** A player with a deliberately deep pool, so only the street limit binds. */
function deepPool() {
  const timer = new PreciseActionTimer();
  const tbe = new TimeBankEngine(timer);
  tbe.initializePlayer(TABLE, 'u1', { remainingSeconds: 1000, usesRemaining: 50 });
  return { tbe, timer };
}

/** Activate and immediately settle, so the bank is idle for the next attempt. */
function consumeOne(tbe: TimeBankEngine): boolean {
  const ok = tbe.activate(TABLE, 'u1', noop);
  if (ok) tbe.playerActed(TABLE, 'u1');
  return ok;
}

describe('a time bank grants 20 seconds', () => {
  it('adds 20s, not the 15s decision clock', () => {
    const { tbe, timer } = deepPool();
    const spy: number[] = [];
    const orig = timer.startTimer.bind(timer);
    timer.startTimer = (t, p, ms, cb) => {
      if (String(p).startsWith('timebank:')) spy.push(ms);
      return orig(t, p, ms, cb);
    };

    expect(tbe.activate(TABLE, 'u1', noop)).toBe(true);
    expect(tbe.getPlayerBank(TABLE, 'u1')!.currentUseSeconds).toBe(20);
    expect(spy[0]).toBe(20_000);
    tbe.playerActed(TABLE, 'u1');
  });

  it('spends 20s of the pool per use, so a 40s base is exactly two whole banks', () => {
    const timer = new PreciseActionTimer();
    const tbe = new TimeBankEngine(timer);
    // The free session base every player starts with.
    tbe.initializePlayer(TABLE, 'u1', { remainingSeconds: 40, usesRemaining: 2 });

    expect(consumeOne(tbe)).toBe(true);
    expect(tbe.getRemainingSeconds(TABLE, 'u1')).toBe(20);
    expect(consumeOne(tbe)).toBe(true);
    expect(tbe.getRemainingSeconds(TABLE, 'u1')).toBe(0);

    // Nothing left to spend — and no partial third bank.
    expect(consumeOne(tbe)).toBe(false);
  });
});

describe('2 per street, never more', () => {
  it('allows exactly two on a street and refuses the third', () => {
    const { tbe } = deepPool();
    expect(consumeOne(tbe)).toBe(true);
    expect(consumeOne(tbe)).toBe(true);
    expect(consumeOne(tbe)).toBe(false); // third on the same street
    expect(consumeOne(tbe)).toBe(false); // still refused
  });

  it('a new street restores the allowance - this is the per-STREET part', () => {
    const { tbe } = deepPool();
    expect(consumeOne(tbe)).toBe(true);
    expect(consumeOne(tbe)).toBe(true);
    expect(consumeOne(tbe)).toBe(false);

    tbe.resetStreetActivations(TABLE); // flop is dealt

    expect(consumeOne(tbe)).toBe(true);
    expect(consumeOne(tbe)).toBe(true);
    expect(consumeOne(tbe)).toBe(false);
  });

  it('four streets give at most eight activations, never a ninth on one street', () => {
    const { tbe } = deepPool();
    let used = 0;
    for (const _street of ['preflop', 'flop', 'turn', 'river']) {
      tbe.resetStreetActivations(TABLE);
      while (consumeOne(tbe)) used++;
    }
    expect(used).toBe(8);
  });

  it('a fresh street cannot conjure a bank the player does not own', () => {
    const timer = new PreciseActionTimer();
    const tbe = new TimeBankEngine(timer);
    tbe.initializePlayer(TABLE, 'u1', { remainingSeconds: 20, usesRemaining: 1 });

    expect(consumeOne(tbe)).toBe(true); // their only bank
    tbe.resetStreetActivations(TABLE); // new street
    expect(consumeOne(tbe)).toBe(false); // pool is empty, street limit is irrelevant
  });

  it('the reset is per table and does not touch another table', () => {
    const timer = new PreciseActionTimer();
    const tbe = new TimeBankEngine(timer);
    const OTHER = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    tbe.initializePlayer(TABLE, 'u1', { remainingSeconds: 1000, usesRemaining: 50 });
    tbe.initializePlayer(OTHER, 'u1', { remainingSeconds: 1000, usesRemaining: 50 });

    for (const t of [TABLE, OTHER]) {
      expect(tbe.activate(t, 'u1', noop)).toBe(true);
      tbe.playerActed(t, 'u1');
      expect(tbe.activate(t, 'u1', noop)).toBe(true);
      tbe.playerActed(t, 'u1');
      expect(tbe.activate(t, 'u1', noop)).toBe(false);
    }

    tbe.resetStreetActivations(TABLE);

    expect(tbe.activate(TABLE, 'u1', noop)).toBe(true);
    tbe.playerActed(TABLE, 'u1');
    expect(tbe.activate(OTHER, 'u1', noop)).toBe(false); // untouched
  });
});
