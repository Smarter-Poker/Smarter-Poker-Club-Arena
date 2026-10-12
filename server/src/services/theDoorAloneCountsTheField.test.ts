/**
 * THE DOOR ALONE COUNTS THE FIELD (2026-10-08).
 *
 * tournaments.current_players is published by the registration door in the
 * transaction that admits an entrant (the horse door, the person's door and
 * the ticket door each write before + 1 only when the row still holds the
 * value they expect), by trg_sync_tournament_current_players before the start
 * and on every bust, and for a seat-first format by the seat trigger.
 *
 * The engine used to write that column too, from its own tally, in a separate
 * statement after the doors had committed: topUpWithHorses re-read the roster
 * and wrote it back, and createTournament, createXMTT and the field SNG wrote
 * this pass's `registered`. A concurrent fill pass on the same event is
 * routine, so those writes landed a count from before a committed entry, and
 * every later door call refused with "Tournament roster cache diverged before
 * horse registration (cached N, actual M)". Measured 2026-10-04 22:00 to
 * 2026-10-08 02:30 UTC: 170 horse registrations refused in 25 fill passes.
 *
 * These drive the real methods with the database mocked and record every
 * update the service sends, so a returning second writer fails here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentRecurringService } from './TournamentRecurringService.js';
import { supabase } from './supabase.js';
import { MTT_BLIND_PRESETS } from '../tournament/mttStructurePolicy.js';
import { HEADS_UP_BLIND_STRUCTURE, HEADS_UP_PAYOUTS } from '../config/headsUpSpec.js';

vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => false }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

const T = 'fb8931b5-0000-4000-8000-000000000001';
type Update = { table: string; payload: Record<string, unknown> };

function countWrites(updates: Update[]): Update[] {
  return updates.filter((u) => u.table === 'tournaments' && 'current_players' in u.payload);
}

describe('a fill pass leaves the field count to the door', () => {
  function harness(ids: string[]) {
    const svc = new TournamentRecurringService() as any;
    const updates: Update[] = [];
    const population = ids.map((id) => ({
      id,
      display_name: id,
      username: id,
      use_real_name: false,
    }));
    const target = {
      variant: 'bounty',
      format_contract: 'mtt-v1',
      max_players: 200,
      club_id: null,
      start_time: new Date(Date.now() + 600000).toISOString(),
      created_at: new Date().toISOString(),
      prize_pool_finalized: false,
      buy_in_amount: 4.5,
      buy_in_fee: 0.5,
      current_players: 10,
    };
    vi.spyOn(svc, 'horseLoadMap').mockResolvedValue(new Map());
    vi.spyOn(svc, 'clubMemberIdsForTournament').mockResolvedValue(new Set(ids));
    const rpc = vi.fn(
      async (name: string): Promise<any> =>
        name === 'fn_horse_tournament_entry_ticket_hints'
          ? { data: { ok: true, holder_ids: [] }, error: null }
          : { data: { ok: true, registration_id: 'registered' }, error: null }
    );
    vi.spyOn(supabase, 'rpc').mockImplementation(rpc as never);
    vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
      const b: Record<string, any> = {};
      for (const m of ['select', 'eq', 'in', 'is', 'gt', 'order', 'limit', 'range']) b[m] = () => b;
      b.update = (payload: Record<string, unknown>) => {
        updates.push({ table, payload });
        return b;
      };
      // The roster reads 11 while the counter says 10: exactly the moment a
      // concurrent door call has committed and this pass has not caught up.
      const answer = () => ({
        data: table === 'tournaments' ? target : table === 'profiles' ? population : [],
        error: null,
        count: 11,
      });
      b.maybeSingle = async () => answer();
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve);
      return b as never;
    });
    const entries = () =>
      rpc.mock.calls.filter(([name]) => name === 'fn_register_horse_for_tournament');
    return { svc, updates, entries };
  }

  it('registers through the door and writes no count of its own', async () => {
    const { svc, updates, entries } = harness(['h1', 'h2', 'h3']);
    const added = await svc.topUpWithHorses(T, 14);
    expect(added).toBe(3);
    expect(entries()).toHaveLength(3);
    expect(countWrites(updates)).toEqual([]);
  });

  it('writes no count when every door call refused', async () => {
    const { svc, updates } = harness(['h1', 'h2']);
    vi.mocked(supabase.rpc).mockImplementation((async (name: string) =>
      name === 'fn_horse_tournament_entry_ticket_hints'
        ? { data: { ok: true, holder_ids: [] }, error: null }
        : { data: { ok: false, reason: 'already_registered' }, error: null }) as never);
    expect(await svc.topUpWithHorses(T, 14)).toBe(0);
    expect(countWrites(updates)).toEqual([]);
  });
});

describe('creating an event publishes its status, never the pass tally', () => {
  function creation(registered: number) {
    const updates: Update[] = [];
    let row: Record<string, unknown> | null = null;
    const chain: Record<string, any> = {
      insert: (value: Record<string, unknown>) => {
        row = value;
        return chain;
      },
      select: () => chain,
      maybeSingle: async () => ({
        data: { ...row, id: 'event', format_contract: 'mtt-v1' },
        error: null,
      }),
      update: (payload: Record<string, unknown>) => {
        updates.push({ table: 'tournaments', payload });
        return chain;
      },
      eq: async () => ({ error: null }),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(chain as never);
    vi.spyOn(supabase, 'rpc').mockImplementation((() =>
      Promise.resolve({
        data: {
          ok: true,
          admission_abi: 'legacy-capacity-v1',
          entries: [
            { tournament_id: 'event', format_contract: 'mtt-v1', effective_max_players: 100 },
          ],
        },
        error: null,
      })) as never);
    const service = new TournamentRecurringService() as any;
    vi.spyOn(service, 'registerHorses').mockResolvedValue(registered);
    return { service, updates, inserted: () => row };
  }

  const mtt = {
    name: 'Midnight Bounty (NLH)',
    type: 'bounty',
    gameVariant: 'nlh',
    buyIn: 5,
    bountyPercent: 30,
    guarantee: 0,
    startingStack: 10000,
    maxPlayers: 100,
    minPlayers: 8,
    horsesToRegister: 11,
    blindPreset: 'TURBO',
    payoutPreset: 'NINE',
    blindStructure: MTT_BLIND_PRESETS.TURBO,
    payoutStructure: [{ place: 1, percentage: 100 }],
  };

  it.each(['createTournament', 'createXMTT'])('%s', async (method) => {
    const { service, updates, inserted } = creation(11);
    const result = await service[method](mtt, 'union', 'club');
    expect(result).toMatchObject({ tournamentId: 'event', registered: 11 });
    // The row starts at zero and the doors count up from there.
    expect(inserted()).toMatchObject({ current_players: 0 });
    expect(updates).toEqual([{ table: 'tournaments', payload: { status: 'REGISTERING' } }]);
    expect(countWrites(updates)).toEqual([]);
  });

  it('createSNG (a field SNG)', async () => {
    const { service, updates } = creation(5);
    const result = await service.createSNG({
      name: 'Field',
      type: 'sng',
      gameVariant: 'nlh',
      buyIn: 5,
      maxPlayers: 6,
      minPlayers: 3,
      startingStack: 3000,
      horsesToRegister: 5,
      payoutPercent: 20,
      blindStructure: HEADS_UP_BLIND_STRUCTURE,
      payoutStructure: HEADS_UP_PAYOUTS,
    });
    expect(result).toMatchObject({ tournamentId: 'event', registered: 5 });
    expect(updates).toEqual([{ table: 'tournaments', payload: { status: 'REGISTERING' } }]);
  });
});
