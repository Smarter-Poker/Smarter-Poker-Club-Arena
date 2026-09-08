import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  errorAt: '',
  missingTournament: false,
  refunded: 0,
  fee: 1,
  writes: [] as string[],
  settleCalls: 0,
  receipt: {} as Record<string, unknown>,
}));
vi.mock('../services/supabase.js', () => ({
  supabase: {
    from(table: string) {
      let op = 'read';
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'neq', 'contains']) c[m] = () => c;
      for (const m of ['update', 'insert'])
        c[m] = () => {
          op = m;
          return c;
        };
      const answer = () => {
        const key = table + '.' + op;
        if (state.errorAt === key) return { data: null, error: { message: 'injected failure' } };
        if (op !== 'read') {
          state.writes.push(key);
          if (key === 'rake_records.insert') state.fee = 0;
          return { data: null, error: null };
        }
        const data: Record<string, unknown> = {
          tournaments: state.missingTournament ? null : { name: 'Event', club_id: 'club' },
          tournament_players: [{ id: 'entry', user_id: 'player', prize: 0 }],
          wallet_transactions: [
            { type: 'debit', category: 'tournament_buyin', amount: 10 },
            { type: 'credit', category: 'refund', amount: state.refunded },
          ],
          rake_records: [{ rake_amount: state.fee }],
        };
        return { data: data[table], error: null };
      };
      c.maybeSingle = async () => answer();
      c.then = (resolve: (value: unknown) => unknown) => Promise.resolve(answer()).then(resolve);
      return c;
    },
  },
}));
vi.mock('./settleObligation.js', () => ({
  settleTournamentObligation: vi.fn(async () => {
    state.settleCalls++;
    if (state.receipt.fully_settled === true) state.refunded = 10;
    return state.receipt;
  }),
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn() }));
import { refundAndCloseCancelledTournament } from './tournamentRecovery.js';
const run = () => refundAndCloseCancelledTournament('event-id', 'Event', 'test');
const closes = () => state.writes.filter((k) => k.endsWith('.update'));
beforeEach(() => {
  Object.assign(state, {
    errorAt: '',
    missingTournament: false,
    refunded: 0,
    fee: 1,
    writes: [],
    settleCalls: 0,
    receipt: { ok: true, paid: 10, amount_paid: 10, fully_settled: true },
  });
});
describe('cancel refund closure follows all required financial work', () => {
  it.each([
    'tournaments.read',
    'wallet_transactions.read',
    'rake_records.read',
    'rake_records.insert',
  ])('retains open rows on %s failure', async (errorAt) => {
    state.errorAt = errorAt;
    await run();
    expect(closes()).toEqual([]);
  });
  it('retains open rows when the tournament is missing', async () => {
    state.missingTournament = true;
    await run();
    expect(closes()).toEqual([]);
  });
  it.each([
    { ok: false, paid: 0, refused_reason: 'escrow_short' },
    { ok: true, paid: 4, amount_paid: 4, fully_settled: false },
    { ok: true, paid: 0, already_paid: 4 },
  ])('retains open rows on incomplete receipt %j', async (receipt) => {
    state.receipt = receipt;
    await run();
    expect(state.writes).toEqual([]);
  });
  it('closes rows and tables only after full refund and fee reversal', async () => {
    await run();
    expect(state.writes).toEqual([
      'rake_records.insert',
      'tournament_players.update',
      'tables.update',
    ]);
  });
  it('retries fee work after a full refund without paying twice', async () => {
    state.errorAt = 'rake_records.insert';
    await run();
    state.errorAt = '';
    await run();
    expect(state.settleCalls).toBe(1);
    expect(state.writes).toEqual([
      'rake_records.insert',
      'tournament_players.update',
      'tables.update',
    ]);
  });
  it('revisits fees for an already fully refunded player', async () => {
    state.refunded = 10;
    await run();
    expect(state.settleCalls).toBe(0);
    expect(state.writes).toEqual([
      'rake_records.insert',
      'tournament_players.update',
      'tables.update',
    ]);
  });
  it('keeps tables open if closing registrations fails', async () => {
    state.errorAt = 'tournament_players.update';
    await run();
    expect(state.writes).not.toContain('tables.update');
  });
});
