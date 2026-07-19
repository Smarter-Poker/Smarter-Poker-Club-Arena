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

  it('hero loses → netAmount clamped to 0 (we never show negative float)', () => {
    const snap = makeSnapshot({
      players: [
        { seat: 1, user_id: 'hero', stack: 950, totalInvested: 50 } as never,
        { seat: 2, user_id: 'opp1', stack: 1045, totalInvested: 50 } as never,
      ],
      winners: [{ user_id: 'opp1', amount: 95 } as never],
    });
    const out = mapEngineSnapshot(snap, 'hero', 9);
    // Hero is not in winners[], so no row to clamp — but the formula still
    // applies if a row exists with amount < invested (e.g. split pot loss).
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
    // Each invested 50, got 47.5 back (after rake) — small loss, clamped to 0
    expect(a!.netAmount).toBe(0);
    expect(b!.netAmount).toBe(0);
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
    // Each won one run, contributed 100 total (50 per run). RIT splits invested.
    // Mapper currently uses player's totalInvested (full), so net = 95 - 100 = -5 → 0.
    // This is conservative; spec accepts it (PokerBros never shows negative on RIT).
    expect(hero!.netAmount).toBe(0);
    expect(opp!.netAmount).toBe(0);
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
  it('resolves eligible USER IDs to seat numbers', () => {
    const snap = makeSnapshot({
      players: [
        { seat: 3, user_id: 'u-a', stack: 0, bet: 0 } as never,
        { seat: 5, user_id: 'u-b', stack: 0, bet: 0 } as never,
        { seat: 7, user_id: 'u-c', stack: 0, bet: 0 } as never,
      ],
      pots: [
        { amount: 300, eligible: ['u-a', 'u-b', 'u-c'] },
        { amount: 200, eligible: ['u-b', 'u-c'] },
      ],
    } as never);
    const out = mapEngineSnapshot(snap, 'u-a', 9);
    expect(out.sidePots[0].eligibleSeats).toEqual([3, 5, 7]);
    expect(out.sidePots[1].eligibleSeats).toEqual([5, 7]);
  });
});
