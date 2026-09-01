/**
 * PINEAPPLE — a missed discard FOLDS the hand (Dan 2026-08-21).
 *
 * "FOR PINEAPPLE, THIS NEEDS TO BE A FULL ROUND OF DISCARDS. IF A PLAYER
 *  DOESN'T DISCARD IN THE AMOUNT OF TIME GIVEN, THEIR HAND IS FOLDED."
 *
 * The old expiry path called autoDiscard(), which threw away the LAST card -
 * a random discard the player never chose, that then kept playing their hand.
 * These tests pin the new rule and the properties that make it safe: the
 * discard round is a real round (every active seat owes one), a fold removes
 * exactly one player, chips are conserved, and folding everyone but one ends
 * the hand instead of stranding the table at pineapple_discard.
 */
import { describe, it, expect, vi } from 'vitest';
import { HandController } from './HandController.js';
import { HAND_COMPLETION } from '../config/handCompletionSpec.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

function mkPlayers(stacks: number[]): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
}

function mkConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: 'pineapple-t1',
    handNumber: 1,
    gameVariant: 'pineapple',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

/** Drive a 3-handed pineapple hand to the discard round. */
function toDiscardRound(stacks = [200, 200, 200]) {
  const events: HandEvent[] = [];
  const hc = new HandController(mkConfig(), mkPlayers(stacks), 1);
  hc.onEvent((e) => events.push(e));
  const st = () => (hc as unknown as { state: any }).state;
  hc.start(); // deal, post blinds, open preflop
  // Preflop: everyone calls/checks to see a flop.
  let guard = 0;
  while (st().stage === 'preflop' && guard++ < 20) {
    const seat = st().currentPlayerSeat;
    if (seat <= 0) break;
    const p = st().players.find((x: SeatPlayer) => x.seat === seat);
    const toCall = st().currentBet - (p?.bet ?? 0);
    hc.performAction(seat, (toCall > 0 ? 'call' : 'check') as any, 0);
  }
  return { hc, st, events };
}

const chips = (st: () => any) =>
  st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0) + st().pot;

describe('pineapple discard round', () => {
  it('is a REAL round: every active seat is dealt 3 and owes a discard', () => {
    const { hc, st } = toDiscardRound();
    expect(st().stage).toBe('pineapple_discard');
    const remaining = (hc as unknown as { pineappleDiscardsRemaining: Set<number> })
      .pineappleDiscardsRemaining;
    const active = st().players.filter((p: SeatPlayer) => !p.is_folded);
    expect(remaining.size).toBe(active.length);
    for (const p of active) expect(p.cards.length).toBe(3);
  });

  it('a missed discard FOLDS that player and nobody else', () => {
    const { hc, st } = toDiscardRound();
    const victim = [
      ...(hc as unknown as { pineappleDiscardsRemaining: Set<number> }).pineappleDiscardsRemaining,
    ][0];
    const before = chips(st);

    expect(hc.foldForMissedDiscard(victim)).toBe(true);

    const folded = st().players.find((p: SeatPlayer) => p.seat === victim);
    expect(folded.is_folded).toBe(true);
    // It is a FOLD, not a discard: the hand was never trimmed to two cards.
    expect(folded.cards.length).toBe(3);
    // Everyone else is untouched and still owes their discard.
    for (const p of st().players.filter((x: SeatPlayer) => x.seat !== victim)) {
      expect(p.is_folded).toBe(false);
    }
    // Folding moves no money.
    expect(chips(st)).toBe(before);
  });

  it('announces the fold as a fold, so seats grey out and history is honest', () => {
    const { hc, st, events } = toDiscardRound();
    const victim = [
      ...(hc as unknown as { pineappleDiscardsRemaining: Set<number> }).pineappleDiscardsRemaining,
    ][0];
    events.length = 0;
    hc.foldForMissedDiscard(victim);
    const fold = events.find(
      (e) => (e as any).type === 'PLAYER_ACTION' && (e as any).action === 'fold'
    );
    expect(fold, 'a fold must be broadcast').toBeTruthy();
    expect((fold as any).seat).toBe(victim);
  });

  it('is idempotent and cannot fold a seat that already discarded', () => {
    const { hc, st } = toDiscardRound();
    const seats = [
      ...(hc as unknown as { pineappleDiscardsRemaining: Set<number> }).pineappleDiscardsRemaining,
    ];
    const discarder = seats[0];
    hc.performDiscard(discarder, 1); // acted in time
    expect(hc.foldForMissedDiscard(discarder)).toBe(false);
    expect(st().players.find((p: SeatPlayer) => p.seat === discarder).is_folded).toBe(false);

    const other = seats[1];
    expect(hc.foldForMissedDiscard(other)).toBe(true);
    expect(hc.foldForMissedDiscard(other), 'second call is a no-op').toBe(false);
  });

  it('folding everyone but one ENDS the hand instead of stranding the table', () => {
    const { hc, st, events } = toDiscardRound();
    const seats = [
      ...(hc as unknown as { pineappleDiscardsRemaining: Set<number> }).pineappleDiscardsRemaining,
    ];
    const before = chips(st);
    events.length = 0;
    // Everybody misses except the last seat.
    for (const s of seats.slice(0, -1)) hc.foldForMissedDiscard(s);

    // completeHand() ends a hand by EMITTING, not by moving the stage - so the
    // contract to pin is that the hand finished and nothing is still owed.
    expect(
      events.some((e) => (e as any).type === 'HAND_COMPLETE'),
      'the hand must complete, not park at pineapple_discard'
    ).toBe(true);
    const remaining = (hc as unknown as { pineappleDiscardsRemaining: Set<number> })
      .pineappleDiscardsRemaining;
    expect(remaining.size, 'no discard may still be owed').toBe(0);
    const survivors = st().players.filter((p: SeatPlayer) => !p.is_folded);
    expect(survivors.length).toBe(1);

    // Conservation, measured properly. `chips()` adds state.pot, which
    // completeHand() leaves populated for the history record after paying the
    // winner - so post-completion the honest sum is STACKS + rake + bbj fee.
    const done = events.find((e) => (e as any).type === 'HAND_COMPLETE') as any;
    const stacks = st().players.reduce((n: number, p: SeatPlayer) => n + p.stack, 0);
    const rake = Number(done?.rake) || 0;
    const bbj = Number(done?.bbjFee) || 0;
    expect(stacks + rake + bbj, 'no chips created or destroyed').toBeCloseTo(before, 6);
  });

  /**
   * MOVED, NOT WEAKENED - PHASE 3 2026-08-31.
   *
   * This pin used to read `expect(st().stage).not.toBe('pineapple_discard')`
   * on the same synchronous tick as the last discard, because the advance was
   * synchronous. It is not any more: the last discard buys a
   * HAND_COMPLETION.DISCARD_SETTLE_MS beat so the card leaving the hand
   * finishes its flight before a betting round opens over the top of it. The
   * assertion it was making - a full round of discards ADVANCES, and every
   * survivor is left holding two cards - is unchanged and is still made here.
   * What is added is the half that is now load-bearing: the round is still
   * held DURING the beat (so nothing downstream may read the advance as its
   * signal that the round is over), and it advances when the beat elapses.
   *
   * If this ever goes red on the first expect, the beat has become a stall.
   */
  it('a discard round where everyone acts advances once the settle beat elapses', () => {
    vi.useFakeTimers();
    try {
      const { hc, st } = toDiscardRound();
      for (const s of [
        ...(hc as unknown as { pineappleDiscardsRemaining: Set<number> })
          .pineappleDiscardsRemaining,
      ]) {
        hc.performDiscard(s, 0);
      }
      // Every card is in - and the cards are off the hands immediately, which
      // is what the client animates against.
      expect(hc.allPineappleDiscardsIn()).toBe(true);
      for (const p of st().players.filter((x: SeatPlayer) => !x.is_folded)) {
        expect(p.cards.length).toBe(2);
      }
      // ...but the street has NOT opened yet. This is the beat.
      expect(st().stage).toBe('pineapple_discard');

      vi.advanceTimersByTime(HAND_COMPLETION.DISCARD_SETTLE_MS);

      expect(st().stage).not.toBe('pineapple_discard');
      for (const p of st().players.filter((x: SeatPlayer) => !x.is_folded)) {
        expect(p.cards.length).toBe(2);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * PHASE 3 2026-08-31: the beat must never be able to park a hand. A hand
   * that ends inside the settle window (everyone else folds, a runout
   * completes) drops its pending advance rather than firing it into a hand
   * that is already over.
   */
  it('a hand that ends inside the settle window does not advance afterwards', () => {
    vi.useFakeTimers();
    try {
      const { hc, st } = toDiscardRound();
      for (const s of [
        ...(hc as unknown as { pineappleDiscardsRemaining: Set<number> })
          .pineappleDiscardsRemaining,
      ]) {
        hc.performDiscard(s, 0);
      }
      hc.cancelPineappleSettle();
      vi.advanceTimersByTime(HAND_COMPLETION.DISCARD_SETTLE_MS * 4);
      expect(st().stage).toBe('pineapple_discard');
    } finally {
      vi.useRealTimers();
    }
  });
});
