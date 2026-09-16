import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTournamentService } from '../services/ScheduledTournamentService.js';
import { TournamentRecurringService, isSeatFirstFormat, startsOnBoughtSeats } from '../services/TournamentRecurringService.js';
import { supabase } from '../services/supabase.js';
import { MTT_BLIND_PRESETS } from './mttStructurePolicy.js';
import { mayTakeSynchronizedBreak } from './breakEligibility.js';
import { seatsAtOneTable } from '../services/TournamentBrainContext.js';
import { isSpinTournament } from './payoutStructure.js';
import { rakeRateFor } from '../config/buyIn.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const schedule = { id: 'schedule-1', club_id: 'club-1', union_id: null, name: 'Unlimited' };
const config = { type: 'mtt', buyIn: 20, startingStack: 10000, blindPreset: 'STANDARD', payoutPreset: 'NINE' };

describe('unlimited MTT source wiring', () => {
  it.each([null, 2, 100, 10000])('scheduled creation ignores legacy cap %j', async (maxPlayers) => {
    const service = new ScheduledTournamentService() as any;
    const row = await service.buildInsertRow(schedule, { ...config, maxPlayers }, new Date());
    expect(row).toMatchObject({ max_players: null, table_size: 9, min_players: 3, buy_in_amount: 18, buy_in_fee: 2 });
    expect(row.blind_structure).toEqual(MTT_BLIND_PRESETS.STANDARD);
  });

  it.each(['sng', 'spin'])('linked %s schedule becomes an unlimited satellite with the full selected ladder', async (type) => {
    const service = new ScheduledTournamentService() as any;
    vi.spyOn(service, 'resolveSatelliteTarget').mockResolvedValue('target-1');
    const row = await service.buildInsertRow(schedule, { ...config, type, maxPlayers: 2, satelliteTargetId: 'target-1' }, new Date());
    expect(row).toMatchObject({ tournament_type: 'SATELLITE', variant: 'satellite', max_players: null, table_size: 9, satellite_target_id: 'target-1', buy_in_fee: 2 });
    expect(row.blind_structure).toEqual(MTT_BLIND_PRESETS.STANDARD);
    expect(service.resolveSatelliteTarget).toHaveBeenCalledWith(schedule, '', 'target-1', expect.any(Date));
  });

  it('does not erase a bounty contract to turn it into a satellite', async () => {
    const service = new ScheduledTournamentService() as any;
    const row = await service.buildInsertRow(schedule, { ...config, type: 'progressive_bounty', satelliteTargetId: 'target-1' }, new Date());
    expect(row).toBeNull();
  });

  it.each([
    ['rebuy', true, true],
    ['mtt_rebuy', true, true],
    ['reentry', false, true],
    ['mtt_reentry', false, true],
  ] as const)('keeps the %s entry rules without redundant draft flags', async (type, rebuy, reentry) => {
    const service = new ScheduledTournamentService() as any;
    const row = await service.buildInsertRow(schedule, { ...config, type, maxPlayers: 2 }, new Date());
    expect(row).toMatchObject({ max_players: null, is_rebuy: rebuy, is_reentry: reentry });
    expect(row).toMatchObject({ rebuy_cost: 20, rebuy_chips: 10000, rebuy_levels: rebuy ? 6 : null });
  });

  it('keeps configured re-entry economics and the feeder-relative target cutoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    const service = new ScheduledTournamentService() as any;
    const feederStart = new Date('2026-09-15T17:00:00Z');
    const row = await service.buildInsertRow(schedule, {
      ...config, type: 'reentry', rebuyCost: 50, rebuyChips: 20000,
    }, feederStart);
    expect(row).toMatchObject({ is_rebuy: false, is_reentry: true, rebuy_cost: 50, rebuy_chips: 20000 });
    const query = {
      select: vi.fn(() => query), in: vi.fn(() => query), gt: vi.fn(() => query),
      order: vi.fn(() => query), limit: vi.fn(() => query), eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: {
        id: 'target-1', tournament_type: 'MTT', variant: 'freezeout',
        is_bounty: false, is_pko: false, is_mystery_bounty: false, is_premium_spin: false,
      }, error: null })),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(query as never);
    expect(await service.resolveSatelliteTarget(schedule, '', 'target-1', feederStart)).toBe('target-1');
    expect(query.gt).toHaveBeenCalledWith('start_time', feederStart.toISOString());
  });

  it.each(['satellite_target_id', 'satellite_target'])('restarts a legacy feeder with %s intact and a durable source identity', async (targetField) => {
    const service = new ScheduledTournamentService() as any;
    const old = {
      id: '46460000-0000-4000-8000-000000000010', club_id: 'club-1', union_id: null,
      name: 'Repeated qualifier', tournament_type: 'SNG', variant: 'sng', max_players: 2,
      min_players: 2, starting_chips: 10000, blind_structure: MTT_BLIND_PRESETS.TURBO,
      buy_in_amount: 19, buy_in_fee: 1, restart_every_minutes: 5,
      is_bounty: false, is_pko: false, is_mystery_bounty: false, is_premium_spin: false,
      ended_at: new Date(Date.now() - 60000).toISOString(), [targetField]: 'target-1',
      restart_source_id: 'grandparent-must-not-be-copied',
    };
    const before = structuredClone(old);
    const query = {
      select: vi.fn(() => query), eq: vi.fn(() => query), in: vi.fn(() => query),
      gt: vi.fn(() => query), insert: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: { id: 'next' }, error: null })),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ count: 0, error: null }).then(resolve),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(query as never);
    const target = vi.spyOn(service, 'resolveSatelliteTarget').mockResolvedValue('target-1');
    await service.maybeRestartTournament(old);
    expect(query.insert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      restart_source_id: old.id, satellite_target_id: 'target-1',
      tournament_type: 'SATELLITE', variant: 'satellite', max_players: null, min_players: 3,
      buy_in_amount: 19, buy_in_fee: 1,
    }));
    expect(target).toHaveBeenCalledWith(expect.objectContaining({ club_id: 'club-1' }), '', 'target-1', expect.any(Date));
    expect(old).toEqual(before);
    query.insert.mockClear();
    target.mockResolvedValue(null);
    await service.maybeRestartTournament(old);
    expect(query.insert).not.toHaveBeenCalled();
  });

  it.each([
    { tournament_type: 'SNG', variant: 'sng', max_players: 2 },
    { tournament_type: 'SPIN', variant: 'spin', max_players: 3 },
  ])('a fixed seat-first event cannot restart as a scheduled clone: %j', async (format) => {
    const service = new ScheduledTournamentService() as any;
    const read = vi.spyOn(supabase, 'from').mockImplementation(() => { throw new Error('Unexpected clone work'); });
    await service.maybeRestartTournament({
      id: 'old', club_id: 'club', name: 'Fixed', ended_at: new Date().toISOString(),
      restart_every_minutes: 5, ...format,
    });
    expect(read).not.toHaveBeenCalled();
  });

  const satelliteId = '46460000-0000-4000-8000-000000000001';
  const targetId = '46460000-0000-4000-8000-000000000002';
  const owner = { clubId: '46460000-0000-4000-8000-000000000003', unionId: null, kind: 'club', maxStake: 1000 };
  const satelliteConfig = {
    name: 'Satellite', gameVariant: 'nlh', buyIn: 20, startingStack: 10000,
    maxPlayers: 2, minPlayers: 3, targetId, targetName: 'Target',
    blindStructure: MTT_BLIND_PRESETS.TURBO,
    payoutStructure: [{ place: 1, percentage: 100 }],
  };
  const satelliteReceipt = {
    ok: true, outcome: 'created', tournament_id: satelliteId, target_id: targetId,
    club_id: owner.clubId, union_id: owner.unionId,
  };

  it.each(['created', 'existing_active'])('uses atomic recurring creation and reports %s accurately', async (outcome) => {
    const service = new TournamentRecurringService() as any;
    const directWrite = vi.spyOn(supabase, 'from').mockImplementation(() => { throw new Error('Unexpected direct write'); });
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: { ...satelliteReceipt, outcome }, error: null } as never);
    const result = await service.createSatelliteHeadsUp(satelliteConfig, owner);
    expect(result).toEqual({ tournamentId: satelliteId, registered: 0, created: outcome === 'created' });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('fn_ensure_scheduled_mtt_satellite', { p_config: expect.objectContaining({
      tournament_type: 'SATELLITE', variant: 'satellite', max_players: null,
      table_size: 9, min_players: 3, synchronized_breaks: true, satellite_target_id: targetId,
      buy_in_amount: 18, buy_in_fee: 2,
    }) });
    expect(directWrite).not.toHaveBeenCalled();
  });

  it.each([
    null, { ok: false, reason: 'platform_frozen' },
    { ...satelliteReceipt, target_id: 'wrong-target' },
    { ...satelliteReceipt, club_id: 'wrong-owner' },
    { ...satelliteReceipt, union_id: 'wrong-union' },
    { ...satelliteReceipt, tournament_id: 'invalid-id' },
    { ...satelliteReceipt, outcome: 'unknown' },
  ])('refuses an incomplete or mismatched creation receipt without fallback: %j', async (data) => {
    const service = new TournamentRecurringService() as any;
    const directWrite = vi.spyOn(supabase, 'from').mockImplementation(() => { throw new Error('Unexpected direct write'); });
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data, error: null } as never);
    expect(await service.createSatelliteHeadsUp(satelliteConfig, owner)).toEqual({ tournamentId: null, registered: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(directWrite).not.toHaveBeenCalled();
  });

  it('does not retry or fall back after an uncertain creation response', async () => {
    const service = new TournamentRecurringService() as any;
    const directWrite = vi.spyOn(supabase, 'from').mockImplementation(() => { throw new Error('Unexpected direct write'); });
    const rpc = vi.spyOn(supabase, 'rpc').mockRejectedValue(new Error('Response lost after possible commit'));
    expect(await service.createSatelliteHeadsUp(satelliteConfig, owner)).toEqual({ tournamentId: null, registered: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(directWrite).not.toHaveBeenCalled();
  });

  it('checks target identity and reaches later targets when earlier feeders already exist', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    const service = new TournamentRecurringService() as any;
    const targets = ['Morning', 'Afternoon', 'Evening'].map((name, index) => ({
      id: `46460000-0000-4000-8000-00000000001${index}`, name,
      start_time: '2026-09-15T17:00:00Z', buy_in_amount: 180, buy_in_fee: 20,
      tournament_type: 'MTT', variant: 'freezeout', game_type: 'NLH', max_players: null,
      is_bounty: false, is_pko: false, is_mystery_bounty: false, is_premium_spin: false,
    }));
    const query = {
      select: vi.fn(() => query), eq: vi.fn(() => query), is: vi.fn(() => query),
      gt: vi.fn(() => query), lt: vi.fn(() => query), gte: vi.fn(() => query),
      order: vi.fn(() => query), limit: vi.fn(() => query),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: targets, error: null }).then(resolve),
    };
    const from = vi.spyOn(supabase, 'from').mockReturnValue(query as never);
    const create = vi.spyOn(service, 'createSatelliteHeadsUp')
      .mockResolvedValueOnce({ tournamentId: satelliteId, registered: 0, created: false })
      .mockResolvedValueOnce({ tournamentId: satelliteId, registered: 0, created: false })
      .mockResolvedValueOnce({ tournamentId: satelliteId, registered: 0, created: true });
    await service.ensureSatelliteHeadsUps(owner, 1);
    expect(create).toHaveBeenCalledTimes(3);
    expect(create).toHaveBeenNthCalledWith(3, expect.objectContaining({ targetId: targets[2].id }), owner);
    // Only target discovery reads a board; no name-based feeder query can
    // suppress this target due to a previous day's same-named satellite.
    expect(from).toHaveBeenCalledExactlyOnceWith('tournaments');
  });

  it('stale satellite labels and caps do not select fixed-format lifecycle branches', () => {
    const satellite = { tournament_type: 'SATELLITE', variant: 'sng', max_players: 2, table_size: 9 };
    expect(isSeatFirstFormat('sng', 2, 'SATELLITE')).toBe(false);
    expect(startsOnBoughtSeats('sng', 2, 'SATELLITE')).toBe(false);
    expect(isSeatFirstFormat('spin', 3, 'SPIN', 'target-1')).toBe(false);
    expect(mayTakeSynchronizedBreak(satellite)).toBe(true);
    expect(seatsAtOneTable(satellite)).toBe(9);
    expect(isSpinTournament({ ...satellite, variant: 'spin' })).toBe(false);
    expect(rakeRateFor({ tournamentType: 'SATELLITE', maxPlayers: 2 })).toBe(0.1);
    expect(isSeatFirstFormat('sng', 2, 'SNG')).toBe(true);
    expect(rakeRateFor({ tournamentType: 'SNG', maxPlayers: 2 })).toBe(0.05);
  });
});
