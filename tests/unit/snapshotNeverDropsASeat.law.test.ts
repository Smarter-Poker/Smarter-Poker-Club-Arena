/**
 * ═══ LAW: A SNAPSHOT NEVER DROPS A SEAT THE ENGINE SAYS EXISTS (Dan 2026-08-30) ═══
 *
 * Production incident, 2026-08-31 00:27 UTC, table 08746c1a "NLH 2.00/5.00 #2"
 * (9-max), seat 7. The engine did everything right: released the wait-for-BB
 * hold the moment the big blind reached the seat, dealt the player in, posted
 * their big blind, even paid them a pot. The player's client showed NONE of it,
 * because `tableState.maxPlayers` boots at 6 (a mount without navigation state
 * keeps that default) and mapEngineSnapshot dropped every seat above it —
 * including the hero's own. No hole cards, no action bar, the footer stuck on
 * "Seat Reserved, You'll Be Dealt In Next Hand"; the engine timed out their
 * turns, force-sat them out after three strikes, and evicted the seat at the
 * five-minute mark. The player's report: "IT NEVER POSTS YOU IN THE BB."
 *
 * The law: the engine's snapshot is authoritative about which seats exist.
 * mapEngineSnapshot must size its per-seat arrays to the highest seat the
 * snapshot carries, whatever the caller believes maxPlayers is. Weakening this
 * re-ships that incident.
 */
import { describe, it, expect } from 'vitest';
import { mapEngineSnapshot } from '@/utils/mapEngineSnapshot';

function makeSnapshot(overrides: Partial<Parameters<typeof mapEngineSnapshot>[0]> = {}) {
  return {
    table_id: 't-1',
    pot: 0,
    current_bet: 0,
    stage: 'preflop',
    dealer_seat: 1,
    big_blind: 5,
    small_blind: 2,
    players: [],
    action_history: [],
    community_cards: [],
    side_pots: [],
    winners: [],
    disconnect_states: {},
    ...overrides,
  } as Parameters<typeof mapEngineSnapshot>[0];
}

describe('LAW — snapshot never drops a seat (Dan 2026-08-30)', () => {
  it('a hero in seat 7 survives a stale maxSeats of 6', () => {
    const snap = makeSnapshot({
      players: [
        { seat: 1, user_id: 'h1', stack: 581 } as never,
        { seat: 5, user_id: 'h2', stack: 330 } as never,
        { seat: 7, user_id: 'hero', stack: 1000, bet: 5 } as never,
      ],
    });
    const out = mapEngineSnapshot(snap, 'hero', 6);
    expect(out.players.length).toBe(7);
    const hero = out.players[6];
    expect(hero).not.toBeNull();
    expect(hero!.isHero).toBe(true);
    // The blind chips in front of the seat survive too.
    expect(out.lastBetAmounts[6]).toBe(5);
  });

  it('seat 9 on a 9-max table survives even when the caller believes 6', () => {
    const snap = makeSnapshot({
      players: [
        { seat: 2, user_id: 'a', stack: 100 } as never,
        { seat: 9, user_id: 'b', stack: 200 } as never,
      ],
    });
    const out = mapEngineSnapshot(snap, 'x', 6);
    expect(out.players.length).toBe(9);
    expect(out.players[8]?.id).toBe('b');
  });

  it('a correct maxSeats is untouched — arrays keep their full length', () => {
    const snap = makeSnapshot({
      players: [{ seat: 3, user_id: 'a', stack: 100 } as never],
    });
    const out = mapEngineSnapshot(snap, 'x', 9);
    expect(out.players.length).toBe(9);
    expect(out.positions.length).toBe(9);
    expect(out.lastActions.length).toBe(9);
    expect(out.lastBetAmounts.length).toBe(9);
  });
});
