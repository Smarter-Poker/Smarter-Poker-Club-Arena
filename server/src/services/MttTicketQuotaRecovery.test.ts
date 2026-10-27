import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TournamentRecurringService } from './TournamentRecurringService.js';
import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';
const state = vi.hoisted(() => ({ frozen: false }));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => state.frozen }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
beforeEach(() => vi.mocked(reportError).mockClear());
afterEach(() => {
  state.frozen = false;
  vi.restoreAllMocks();
});
const T = 'aaaaaaaa-1111-4111-8111-111111111111';
const horse = (id: string) => ({ id, display_name: id, username: id, use_real_name: false });

function harness(ids = ['ticket']) {
  const svc = new TournamentRecurringService() as any;
  const roster: Array<{ user_id: string; id: string }> = [];
  const population = ids.map(horse);
  const target = {
    variant: 'freezeout',
    format_contract: 'mtt-v1',
    max_players: 200,
    club_id: null,
    start_time: new Date(Date.now() + 600000).toISOString(),
    prize_pool_finalized: false,
    buy_in_amount: 20,
    buy_in_fee: 2,
  };
  const load = new Map<string, number>();
  vi.spyOn(svc, 'horseLoadMap').mockResolvedValue(load);
  // The MTT overlap cap's read (MttOverlapCap.test.ts): no other game held, so
  // the ticket rules under test are decided exactly as before.
  vi.spyOn(svc, 'horseTournamentCommitments').mockResolvedValue({
    tournamentSeats: [],
    pendingBookings: [],
  });
  vi.spyOn(svc, 'clubMemberIdsForTournament').mockResolvedValue(new Set(ids));
  const rpc = vi.fn(
    async (name: string, _args?: unknown): Promise<any> =>
      name === 'fn_horse_tournament_entry_ticket_hints'
        ? { data: { ok: true, holder_ids: ids }, error: null }
        : ({ data: { ok: true, registration_id: 'registered' }, error: null } as never)
  );
  vi.spyOn(supabase, 'rpc').mockImplementation(rpc as never);
  vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
    const b: Record<string, any> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'gt', 'order', 'limit', 'range', 'update'])
      b[m] = () => b;
    const answer = () => ({
      data: table === 'tournaments' ? target : table === 'profiles' ? population : roster,
      error: null,
      count: 24,
    });
    b.maybeSingle = async () => answer();
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve);
    return b as never;
  });
  const entries = () =>
    rpc.mock.calls
      .filter(([name]) => name === 'fn_register_horse_for_tournament')
      .map(([, args]) => args);
  return { svc, roster, target, load, population, rpc, entries };
}

describe('prestart ticket entry survives a satisfied ordinary funding quota', () => {
  it('redeems the eligible ticket through the existing door with zero ordinary shortfall', async () => {
    const { svc, entries } = harness();
    expect(await svc.topUpWithHorses(T, 0, { redeemTickets: true })).toBe(1);
    expect(entries()).toEqual([
      { p_tournament_id: T, p_user_id: 'ticket', p_allow_wallet_charge: false },
    ]);
  });
  it('leaves ordinary zero-shortfall calls unchanged', async () => {
    const { svc, rpc } = harness();
    expect(await svc.topUpWithHorses(T, 24)).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('never uses the wallet pool to fill a ticket-only recovery pass', async () => {
    const { svc, population, entries } = harness([]);
    population.push(horse('wallet-horse'));
    expect(await svc.topUpWithHorses(T, 0, { redeemTickets: true })).toBe(0);
    expect(entries()).toEqual([]);
  });
  it('keeps the four-game and existing-entry exclusions', async () => {
    const { svc, load, roster, entries } = harness(['busy', 'entered', 'ready']);
    load.set('busy', 4);
    roster.push({ user_id: 'entered', id: 'registration' });
    expect(await svc.topUpWithHorses(T, 0, { redeemTickets: true })).toBe(1);
    expect(entries().map((a: any) => a.p_user_id)).toEqual(['ready']);
  });
  it('keeps recovery bounded at 25 ticket offers per existing pass', async () => {
    const { svc, entries } = harness(Array.from({ length: 40 }, (_, i) => `ticket-${i}`));
    expect(await svc.topUpWithHorses(T, 0, { redeemTickets: true })).toBe(25);
    expect(entries()).toHaveLength(25);
    expect(entries().every((a: any) => a.p_allow_wallet_charge === false)).toBe(true);
  });
  it.each(['not-an-array', null, ['valid', null]])(
    'refuses malformed holder hints %j before any entry',
    async (holder_ids) => {
      const { svc, rpc, entries } = harness();
      rpc.mockResolvedValue({ data: { ok: true, holder_ids }, error: null } as never);
      expect(await svc.topUpWithHorses(T, 30, { redeemTickets: true })).toBe(0);
      expect(entries()).toEqual([]);
      expect(reportError).toHaveBeenCalled();
    }
  );
  it('does not turn a disappeared ticket into a wallet retry', async () => {
    const { svc, rpc, entries } = harness();
    rpc.mockImplementation(
      async (name: string) =>
        ({
          data:
            name === 'fn_horse_tournament_entry_ticket_hints'
              ? { ok: true, holder_ids: ['ticket'] }
              : { ok: false, reason: 'hinted_tournament_ticket_no_longer_available' },
          error: null,
        }) as never
    );
    expect(await svc.topUpWithHorses(T, 0, { redeemTickets: true })).toBe(0);
    expect(entries()).toEqual([
      { p_tournament_id: T, p_user_id: 'ticket', p_allow_wallet_charge: false },
    ]);
  });
  it.each(['finalized', 'freeze'])('keeps the %s refusal', async (kind) => {
    const { svc, target, entries } = harness();
    if (kind === 'finalized') target.prize_pool_finalized = true;
    else state.frozen = true;
    expect(await svc.topUpWithHorses(T, 0, { redeemTickets: true })).toBe(0);
    expect(entries()).toEqual([]);
  });
  it('cannot launch another entry after its generation retires during the hint read', async () => {
    const { svc, rpc, entries } = harness();
    rpc.mockImplementation(async () => {
      svc.lifecycleGeneration++;
      return { data: { ok: true, holder_ids: ['ticket'] }, error: null } as never;
    });
    expect(await svc.topUpWithHorses(T, 30, { redeemTickets: true })).toBe(0);
    expect(entries()).toEqual([]);
  });
  it('keeps the ordinary ticket priority when the existing quota exceeds the recovery allowance', async () => {
    const { svc, entries } = harness(Array.from({ length: 40 }, (_, i) => `ticket-${i}`));
    expect(await svc.topUpWithHorses(T, 54, { redeemTickets: true })).toBe(30);
    expect(entries()).toHaveLength(30);
    expect(entries().every((a: any) => a.p_allow_wallet_charge === false)).toBe(true);
  });
  it('retains an unresolved ticket request through stop and does not launch its successor', async () => {
    const { svc, rpc, entries } = harness(['one', 'two']);
    let resolveEntry!: (value: any) => void;
    const entry = new Promise((resolve) => {
      resolveEntry = resolve;
    });
    rpc.mockImplementation(async (name: string) =>
      name === 'fn_horse_tournament_entry_ticket_hints'
        ? { data: { ok: true, holder_ids: ['one', 'two'] }, error: null }
        : entry
    );
    const topUp = svc.topUpWithHorses(T, 0, { redeemTickets: true });
    await vi.waitFor(() => expect(entries()).toHaveLength(1));
    let stopped = false;
    const stop = svc.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveEntry({ data: { ok: true, registration_id: 'registered' }, error: null });
    expect(await topUp).toBe(1);
    await stop;
    expect(stopped).toBe(true);
    expect(entries()).toHaveLength(1);
  });
});
