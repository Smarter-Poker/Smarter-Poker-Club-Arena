/**
 * THE CANCEL REFUND PASSES THE GROSS ENTITLEMENT (phase 1.5, 2026-09-02)
 * ===========================================================================
 *
 * `fn_settle_tournament_obligation` takes the TOTAL owed for an obligation and
 * pays the difference. The first time it meets a `refund` row it seeds
 * `amount_paid` from the player's prior refund credits for that tournament
 * (live body, "Legacy seeding": sum of wallet_transactions credits in
 * ('refund','tournament_refund') for that user + tournament).
 *
 * `refundAndCloseCancelledTournament` used to subtract those same credits
 * before calling, and pass the NET as the total. The two subtractions stacked:
 *
 *     gross 20 (buy-in 10 + rebuy 10), one earlier partial refund of 5
 *     engine passes 15;  DB: owed = max(15, 5) = 15, paid seeded 5, pays 10
 *     the player is 5 short, and a re-run pays nothing (15 - 15 = 0)
 *
 * Passing the gross (20) gives owed 20, paid 5, pays 15. The function already
 * knows what came back; the engine's job is to say what was paid in.
 *
 * These drive the real helper with a scripted supabase and a spied settle
 * path, so the amount the engine hands over is asserted directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Script = Record<string, { data: Row[] | Row | null; error: { message: string } | null }>;

const state = vi.hoisted(() => ({
  script: {} as Record<string, { data: unknown; error: unknown }>,
  settle: [] as Array<Record<string, unknown>>,
}));

/**
 * A supabase stand-in: `.from(table)` returns a chain where every filter method
 * returns the chain, and awaiting it (or `.maybeSingle()`) resolves to the
 * scripted answer for that table. Good enough for the reads this path makes.
 */
vi.mock('../services/supabase.js', () => {
  const chain = (table: string) => {
    const answer = () => state.script[table] ?? { data: [], error: null };
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'neq', 'contains', 'update', 'insert']) {
      c[m] = () => c;
    }
    c.maybeSingle = async () => answer();
    c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(answer()).then(resolve, reject);
    return c;
  };
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock('./settleObligation.js', () => ({
  settleTournamentObligation: vi.fn(async (_client: unknown, input: Record<string, unknown>) => {
    state.settle.push(input);
    return {
      ok: true,
      paid: input.amount,
      amount_paid: input.amount,
      fully_settled: true,
      already_paid: 0,
      refused_reason: null,
      obligation_id: 'ob-1',
      idempotency_key: 'k',
    };
  }),
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn(async () => ({ persisted: true, alertId: 'a' })),
}));

import { refundAndCloseCancelledTournament } from './tournamentRecovery.js';

const T = '11111111-2222-3333-4444-555555555555';
const U = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function script(s: Script) {
  state.script = {
    tournaments: {
      data: { buy_in_amount: 10, buy_in_fee: 1, club_id: null, name: 'Cancelled Event' },
      error: null,
    },
    tournament_players: { data: [{ id: 'tp-1', user_id: U, prize: 0 }], error: null },
    ...s,
  };
}

describe('the cancel refund passes the gross entitlement to the settle function', () => {
  beforeEach(() => {
    state.settle = [];
  });

  it('a player with an earlier partial refund is owed the GROSS, not the net', async () => {
    script({
      wallet_transactions: {
        data: [
          { type: 'debit', category: 'tournament_buyin', amount: 10 },
          { type: 'debit', category: 'rebuy', amount: 10 },
          { type: 'credit', category: 'refund', amount: 5 },
        ],
        error: null,
      },
    });
    await refundAndCloseCancelledTournament(T, 'Cancelled Event', 'test cancel');
    expect(state.settle).toHaveLength(1);
    expect(state.settle[0]).toMatchObject({ tournamentId: T, kind: 'refund', userId: U });
    // The negative control is the old behaviour: 15 here is the bug, and the
    // database would have seeded amount_paid = 5 against it and paid 10.
    expect(state.settle[0].amount).not.toBe(15);
    expect(state.settle[0].amount).toBe(20);
  });

  it('with no earlier refund, gross and net agree and the amount is unchanged', async () => {
    script({
      wallet_transactions: {
        data: [
          { type: 'debit', category: 'tournament_buyin', amount: 10 },
          { type: 'debit', category: 'addon', amount: 4.5 },
        ],
        error: null,
      },
    });
    await refundAndCloseCancelledTournament(T, 'Cancelled Event', 'test cancel');
    expect(state.settle).toHaveLength(1);
    expect(state.settle[0].amount).toBe(14.5);
  });

  it('a player already refunded in full is not settled again', async () => {
    script({
      wallet_transactions: {
        data: [
          { type: 'debit', category: 'tournament_buyin', amount: 10 },
          { type: 'credit', category: 'refund', amount: 10 },
        ],
        error: null,
      },
    });
    await refundAndCloseCancelledTournament(T, 'Cancelled Event', 'test cancel');
    expect(state.settle).toHaveLength(0);
  });

  it('a player who never paid (legacy free entry) is not settled', async () => {
    script({ wallet_transactions: { data: [], error: null } });
    await refundAndCloseCancelledTournament(T, 'Cancelled Event', 'test cancel');
    expect(state.settle).toHaveLength(0);
  });

  it('a player who already holds a prize is not refunded on top', async () => {
    script({
      tournament_players: { data: [{ id: 'tp-1', user_id: U, prize: 25 }], error: null },
      wallet_transactions: {
        data: [{ type: 'debit', category: 'tournament_buyin', amount: 10 }],
        error: null,
      },
    });
    await refundAndCloseCancelledTournament(T, 'Cancelled Event', 'test cancel');
    expect(state.settle).toHaveLength(0);
  });
});
