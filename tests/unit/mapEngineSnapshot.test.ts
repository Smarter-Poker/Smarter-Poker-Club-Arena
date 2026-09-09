/**
 * Phase X6 — net-profit float verification (FE-037 P0).
 *
 * The "+N" yellow floating text rendered above a winning seat (SeatSlot.tsx
 * `seat__net-win`) is driven by tableState.engineWinners[].netAmount, which
 * is computed in mapEngineSnapshot.ts:282 as `Math.max(0, w.amount - invested)`.
 *
 * The PokerBros spec (POKERBROS_CLONE_SPEC.md §6 FE-037) requires this to
 * show NET PROFIT (= pot share received minus hero contribution to pot),
 * NOT the gross pot. These tests pin that contract.
 */
import { describe, it, expect } from 'vitest';
import { mapEngineSnapshot } from '@/utils/mapEngineSnapshot';

// Minimal valid EngineSnapshot — only the fields the mapper inspects matter.
function makeSnapshot(overrides: Partial<Parameters<typeof mapEngineSnapshot>[0]> = {}) {
  return {
    table_id: 't-1',
    pot: 100,
    current_bet: 0,
    stage: 'showdown',
    dealer_seat: 1,
    big_blind: 2,
    small_blind: 1,
    players: [],
    action_history: [],
    community_cards: [],
    side_pots: [],
    winners: [],
    disconnect_states: {},
    ...overrides,
  } as Parameters<typeof mapEngineSnapshot>[0];
}

describe('mapEngineSnapshot.winners[].netAmount (Phase X6 FE-037 P0)', () => {
  it('maps publicly exposed dead cards for reconnect and late-join snapshots', () => {
    const exposed = [{ rank: 'T', suit: 'h' }] as never;
    const out = mapEngineSnapshot(makeSnapshot({ revealed_dead_cards: exposed }), 'hero', 9);
    expect(out.revealedDeadCards).toEqual(exposed);
  });

  it('hero wins solo → netAmount = winnings - invested', () => {
    const snap = makeSnapshot({
      players: [
        { seat: 1, user_id: 'hero', stack: 980, totalInvested: 50 } as never,
        { seat: 2, user_id: 'opp1', stack: 950, totalInvested: 50 } as never,
      ],
      winners: [{ user_id: 'hero', amount: 95 } as never], // post-rake share
    });
    const out = mapEngineSnapshot(snap, 'hero', 9);
    const heroWin = out.winners.find((w) => w.userId === 'hero');
    expect(heroWin).toBeDefined();
    expect(heroWin!.netAmount).toBe(45); // 95 - 50
  });

  it('a losing hero produces no winners row at all, so there is nothing to net', () => {
    const snap = makeSnapshot({
      players: [
        { seat: 1, user_id: 'hero', stack: 950, totalInvested: 50 } as never,
        { seat: 2, user_id: 'opp1', stack: 1045, totalInvested: 50 } as never,
      ],
      winners: [{ user_id: 'opp1', amount: 95 } as never],
    });
    const out = mapEngineSnapshot(snap, 'hero', 9);
    // Hero is not in winners[] at all — an outright loser has no row, so the
    // seat renders no float and nothing needs clamping. The signed formula
    // only ever bites where a row DOES exist but came back short, which is the
    // chopped-and-raked case covered by the split-pot test below.
    expect(out.winners.find((w) => w.userId === 'hero')).toBeUndefined();
    const oppWin = out.winners.find((w) => w.userId === 'opp1');
    expect(oppWin!.netAmount).toBe(45);
  });

  it('split pot → each winner shows their own contribution-adjusted net', () => {
    const snap = makeSnapshot({
      players: [
        { seat: 1, user_id: 'a', stack: 1000, totalInvested: 50 } as never,
        { seat: 2, user_id: 'b', stack: 1000, totalInvested: 50 } as never,
      ],
      winners: [{ user_id: 'a', amount: 47.5 } as never, { user_id: 'b', amount: 47.5 } as never],
    });
    const out = mapEngineSnapshot(snap, 'hero', 9);
    const a = out.winners.find((w) => w.userId === 'a');
    const b = out.winners.find((w) => w.userId === 'b');
    // Each invested 50 and got 47.5 back after rake. That is a real 2.5 loss on
    // a pot they "won", and it is the exact case Dan named on 2026-08-23:
    // "+XXX or -XXX if the pot was chopped and rake was removed". This used to
    // assert 0 because the mapper clamped with Math.max(0, ...) — which then
    // also failed the render's `> 0` gate, so the float showed nothing at all.
    expect(a!.netAmount).toBe(-2.5);
    expect(b!.netAmount).toBe(-2.5);
  });

  it('totalInvested missing → invested treated as 0 (defensive)', () => {
    const snap = makeSnapshot({
      players: [{ seat: 1, user_id: 'hero', stack: 0 } as never],
      winners: [{ user_id: 'hero', amount: 100 } as never],
    });
    const out = mapEngineSnapshot(snap, 'hero', 9);
    expect(out.winners[0]!.netAmount).toBe(100);
  });

  it('all-in run-it-twice (server emits two winner rows) → both netAmounts populated', () => {
    const snap = makeSnapshot({
      players: [
        { seat: 1, user_id: 'hero', stack: 0, totalInvested: 100 } as never,
        { seat: 2, user_id: 'opp', stack: 100, totalInvested: 100 } as never,
      ],
      winners: [
        { user_id: 'hero', amount: 95 } as never, // run #1
        { user_id: 'opp', amount: 95 } as never, // run #2
      ],
    });
    const out = mapEngineSnapshot(snap, 'hero', 9);
    const hero = out.winners.find((w) => w.userId === 'hero');
    const opp = out.winners.find((w) => w.userId === 'opp');
    // -5 each, and that is CORRECT — charging the full totalInvested against
    // one run's winnings is the right accounting here, not a rounding error.
    // Work it through: 100 in from each is a 200 pot, 10 comes off as rake, and
    // the remaining 190 runs twice at 95. Each player takes one run: 95 back on
    // 100 in. The two -5s sum to -10, which is the rake, exactly.
    //
    // The old assertion was 0, with a comment calling the mapper "conservative"
    // and citing "PokerBros never shows negative on RIT". Both halves were
    // wrong. The mapper was already right; Math.max(0, ...) was flattening a
    // TRUE -5 into a false 0, and the `> 0` render gate then dropped the float
    // entirely. Split a raked pot any number of ways and somebody is down — the
    // rake has to come from somewhere, and refusing to display that does not
    // stop it happening, it just stops the player being told.
    //
    // Dan 2026-08-23: "+XXX or -XXX if the pot was chopped and rake was
    // removed." This is that hand.
    expect(hero!.netAmount).toBe(-5);
    expect(opp!.netAmount).toBe(-5);
  });
});

describe('mapEngineSnapshot — per-seat chips in front (AUDIT FIX client-1)', () => {
  it('maps blind posters chips from players[].bet, not action_history', () => {
    // Preflop, unraised: SB=1 (seat 2) and BB=2 (seat 3) posted blinds. No
    // action_history entries exist for blinds — the OLD mapper showed $0 in
    // front of both and made the BB see a call instead of a check.
    const snap = makeSnapshot({
      stage: 'preflop',
      current_bet: 2,
      players: [
        { seat: 1, user_id: 'btn', stack: 200, bet: 0 } as never,
        { seat: 2, user_id: 'sb', stack: 199, bet: 1 } as never,
        { seat: 3, user_id: 'hero', stack: 198, bet: 2 } as never,
      ],
      action_history: [],
    });
    const out = mapEngineSnapshot(snap, 'hero', 9);
    expect(out.lastBetAmounts[1]).toBe(1); // SB seat 2
    expect(out.lastBetAmounts[2]).toBe(2); // BB seat 3 (hero)
    // Hero (BB) is not facing a bet: currentBet(2) - heroBet(2) === 0 → check.
    expect(out.currentBet - out.lastBetAmounts[2]).toBe(0);
  });

  it('folded seats show no chips in front', () => {
    const snap = makeSnapshot({
      stage: 'flop',
      current_bet: 10,
      players: [
        { seat: 1, user_id: 'a', stack: 100, bet: 10 } as never,
        { seat: 2, user_id: 'b', stack: 90, bet: 0, is_folded: true } as never,
      ],
    });
    const out = mapEngineSnapshot(snap, 'a', 9);
    expect(out.lastBetAmounts[0]).toBe(10);
    expect(out.lastBetAmounts[1]).toBe(0);
  });
});

describe('mapEngineSnapshot — side-pot eligibility (AUDIT FIX client-5)', () => {
  it('resolves eligible USER IDs to seat numbers and excludes the main pot', () => {
    // Three-way all-in producing a full settlement partition:
    //   pots[0] = main pot   300, everyone eligible      (seats 3, 5, 7)
    //   pots[1] = side pot 1 200, u-b + u-c eligible     (seats 5, 7)
    //   pots[2] = side pot 2 100, u-c only               (seat 7)
    const snap = makeSnapshot({
      players: [
        { seat: 3, user_id: 'u-a', stack: 0, bet: 0 } as never,
        { seat: 5, user_id: 'u-b', stack: 0, bet: 0 } as never,
        { seat: 7, user_id: 'u-c', stack: 0, bet: 0 } as never,
      ],
      pots: [
        { amount: 300, eligible: ['u-a', 'u-b', 'u-c'] },
        { amount: 200, eligible: ['u-b', 'u-c'] },
        { amount: 100, eligible: ['u-c'] },
      ],
    } as never);
    const out = mapEngineSnapshot(snap, 'u-a', 9);

    // UPDATED for LIVE E2E FIX 2026-08-15 (src/utils/mapEngineSnapshot.ts):
    // pots[0] IS the main pot and is now rendered as `pot`, not as a side pot
    // — mapping every entry double-rendered it ("POT 300 / SIDE POT 1: 300").
    // Only pots[1..] become sidePots, so two pots here, not three.
    expect(out.pot).toBe(300);
    expect(out.sidePots).toHaveLength(2);

    // The original point of this test: `pots[].eligible` holds USER IDs and the
    // mapper must resolve each to its seat number (client-5).
    expect(out.sidePots[0].amount).toBe(200);
    expect(out.sidePots[0].eligibleSeats).toEqual([5, 7]);
    expect(out.sidePots[1].amount).toBe(100);
    expect(out.sidePots[1].eligibleSeats).toEqual([7]);

    // Regression guard for the slice(1) fix: the main pot must not appear in
    // sidePots under any index (neither by amount nor by its eligibility set).
    expect(out.sidePots.map((p) => p.amount)).not.toContain(300);
    expect(out.sidePots.map((p) => p.eligibleSeats)).not.toContainEqual([3, 5, 7]);
  });
});

describe('fixed-limit completion metadata', () => {
  it('keeps the street bet distinct from the current completion increment', () => {
    const result = mapEngineSnapshot(
      makeSnapshot({
        betting_structure: 'fixed_limit',
        fixed_bet_size: 20,
        fixed_raise_size: 15,
        current_bet: 5,
        stage: 'flop',
      }),
      'hero',
      3
    );
    expect(result.fixedBetSize).toBe(20);
    expect(result.fixedRaiseSize).toBe(15);
  });
  it('leaves completion unspecified on older engine snapshots', () => {
    expect(
      mapEngineSnapshot(makeSnapshot({ fixed_bet_size: 20 }), 'hero', 3).fixedRaiseSize
    ).toBeUndefined();
  });
});

it('maps the pot-limit wager basis separately from the real pot', () => {
  const out = mapEngineSnapshot(
    makeSnapshot({
      stage: 'preflop',
      betting_structure: 'pot_limit',
      pot: 1.5,
      pot_limit_pot: 3,
    }),
    'hero',
    4
  );
  expect(out.pot).toBe(1.5);
  expect(out.potLimitPot).toBe(3);
  const later = mapEngineSnapshot(
    makeSnapshot({
      stage: 'flop',
      betting_structure: 'pot_limit',
      pot: 6.5,
      pot_limit_pot: 6.5,
    }),
    'hero',
    4
  );
  expect(later.potLimitPot).toBe(6.5);
  expect(mapEngineSnapshot(makeSnapshot(), 'hero', 4).potLimitPot).toBeUndefined();
});

describe('decision context from live and reconnect snapshots', () => {
  it('preserves the opaque server context without recreating it from client time', () => {
    expect(
      mapEngineSnapshot(makeSnapshot({ action_context: 'original-hand-turn' }), 'hero', 9)
        .actionContext
    ).toBe('original-hand-turn');
  });
  it('does not invent a context for an older engine', () => {
    expect(mapEngineSnapshot(makeSnapshot(), 'hero', 9).actionContext).toBeUndefined();
  });
});
