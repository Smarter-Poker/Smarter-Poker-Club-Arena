import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTournamentService } from '../services/ScheduledTournamentService.js';
import { supabase } from '../services/supabase.js';
import { MTT_BLIND_PRESETS } from './mttStructurePolicy.js';

afterEach(() => vi.restoreAllMocks());
const schedule = { id: 'schedule-1', club_id: 'club-1', union_id: null, name: 'MTT' };
const config = {
  type: 'mtt',
  buyIn: 20,
  startingStack: 10000,
  blindPreset: 'STANDARD',
  payoutPreset: 'NINE',
};

describe('scheduled creation preserves the authored write contract until DB activation', () => {
  it.each([2, 100, 10000])(
    'does not infer HU or clamp paid depth from old MTT cap %s',
    async (maxPlayers) => {
      const row = await (new ScheduledTournamentService() as any).buildInsertRow(
        schedule,
        { ...config, maxPlayers },
        new Date()
      );
      expect(row).toMatchObject({
        max_players: maxPlayers,
        min_players: 3,
        table_size: 9,
        buy_in_amount: 18,
        buy_in_fee: 2,
      });
      expect(row.blind_structure).toEqual(MTT_BLIND_PRESETS.STANDARD);
      expect(row).not.toHaveProperty('format_contract');
    }
  );
  it.each([
    ['sng', 2, 'satellite'],
    ['spin', 2, 'satellite'],
    ['satellite', 100, 'satellite'],
    ['mtt', 100, 'freezeout'],
  ])(
    'a target-linked %s draft retains the MTT writer contract with capacity %s',
    async (type, maxPlayers, variant) => {
      const service = new ScheduledTournamentService() as any;
      vi.spyOn(service, 'resolveSatelliteTarget').mockResolvedValue('target-1');
      const row = await service.buildInsertRow(
        schedule,
        {
          ...config,
          type,
          maxPlayers,
          satelliteTarget: { tournamentId: 'target-1', seatsAwarded: 1 },
        },
        new Date()
      );
      expect(row).toMatchObject({
        tournament_type: 'MTT',
        variant,
        max_players: maxPlayers,
        min_players: 3,
        table_size: 9,
        satellite_target_id: 'target-1',
        satellite_seats: 1,
        buy_in_fee: 2,
      });
      expect(row.blind_structure).toEqual(MTT_BLIND_PRESETS.STANDARD);
    }
  );
  it('does not silently remove a bounty financial contract from a satellite draft', async () => {
    const row = await (new ScheduledTournamentService() as any).buildInsertRow(
      schedule,
      { ...config, type: 'progressive_bounty', satelliteTargetId: 'target' },
      new Date()
    );
    expect(row).toBeNull();
  });
  it.each(['rebuy', 'mtt_rebuy', 'reentry', 'mtt_reentry'])(
    'preserves %s purchase terms',
    async (type) => {
      const row = await (new ScheduledTournamentService() as any).buildInsertRow(
        schedule,
        { ...config, type, rebuyCost: 50, rebuyChips: 20000 },
        new Date()
      );
      expect(row).toMatchObject({ is_reentry: true, rebuy_cost: 50, rebuy_chips: 20000 });
      expect(row.is_rebuy).toBe(type.includes('rebuy'));
    }
  );
  it.each(['sng', 'spin'])('does not schedule a genuine seat-first %s', async (type) => {
    expect(
      await (new ScheduledTournamentService() as any).buildInsertRow(
        schedule,
        { ...config, type, maxPlayers: type === 'spin' ? 3 : 2 },
        new Date()
      )
    ).toBeNull();
  });
});

describe('restart identity is bound to the immediate source', () => {
  function old() {
    return {
      id: 'c3000000-0000-4000-8000-000000000001',
      club_id: 'club-1',
      union_id: null,
      name: 'Qualifier',
      format_contract: 'mtt-v1',
      tournament_type: 'MTT',
      variant: 'satellite',
      max_players: 100,
      min_players: 3,
      starting_chips: 10000,
      blind_structure: MTT_BLIND_PRESETS.TURBO,
      buy_in_amount: 19,
      buy_in_fee: 1,
      restart_every_minutes: 5,
      is_bounty: false,
      is_pko: false,
      is_mystery_bounty: false,
      is_premium_spin: false,
      ended_at: new Date(Date.now() - 60000).toISOString(),
      satellite_target_id: 'target-1',
      restart_source_id: 'grandparent',
    };
  }
  it('keeps parent economics and target while sending the new source identity', async () => {
    const service = new ScheduledTournamentService() as any;
    const source = old();
    const before = structuredClone(source);
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      in: vi.fn(() => query),
      gt: vi.fn(() => query),
      insert: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: { id: 'child' }, error: null })),
      then: (resolve: any) => Promise.resolve({ count: 0, error: null }).then(resolve),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(query);
    const target = vi.spyOn(service, 'resolveSatelliteTarget').mockResolvedValue('target-1');
    await service.maybeRestartTournament(source);
    expect(query.eq).toHaveBeenCalledWith('restart_source_id', source.id);
    expect(query.insert).toHaveBeenCalledOnce();
    expect(query.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        restart_source_id: source.id,
        satellite_target_id: 'target-1',
        max_players: 100,
        min_players: 3,
        buy_in_amount: 19,
        buy_in_fee: 1,
      })
    );
    expect(query.insert.mock.calls[0][0]).not.toHaveProperty('format_contract');
    expect(source).toEqual(before);
    query.insert.mockClear();
    target.mockResolvedValue(null);
    await service.maybeRestartTournament(source);
    expect(query.insert).not.toHaveBeenCalled();
  });
  it.each(['spin-v1', 'sng-v1', 'seat-first-satellite-v1'])(
    'does not turn a purchased %s into a timed clone',
    async (format_contract) => {
      const read = vi.spyOn(supabase, 'from');
      await (new ScheduledTournamentService() as any).maybeRestartTournament({
        ...old(),
        format_contract,
        max_players: format_contract === 'spin-v1' ? 3 : 2,
      });
      expect(read).not.toHaveBeenCalled();
    }
  );
  it('does not guess an admission format for unqualified terminal history', async () => {
    const read = vi.spyOn(supabase, 'from');
    await expect(
      (new ScheduledTournamentService() as any).maybeRestartTournament({
        ...old(),
        format_contract: null,
      })
    ).rejects.toThrow('TOURNAMENT_FORMAT_CONTRACT_INVALID');
    expect(read).not.toHaveBeenCalled();
  });
});
