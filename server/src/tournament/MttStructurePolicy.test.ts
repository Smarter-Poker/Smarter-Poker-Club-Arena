import { afterEach, describe, expect, it, vi } from 'vitest';
import { mttSpeedColumns, mttPayoutPercent, MTT_BLIND_PRESETS } from './mttStructurePolicy.js';
import {
  ScheduledTournamentService,
  SCHEDULE_BLIND_PRESETS,
} from '../services/ScheduledTournamentService.js';
import {
  BLIND_STRUCTURES,
  TournamentRecurringService,
} from '../services/TournamentRecurringService.js';
import { supabase } from '../services/supabase.js';
import { holeCardCount, isOmahaVariant } from '../engine/VariantRules.js';

afterEach(() => vi.restoreAllMocks());

describe('engine MTT structure policy', () => {
  const schedule = {
    id: 'schedule-1',
    club_id: 'club-1',
    union_id: null,
    name: 'Scheduled variant',
  };
  const scheduledConfig = {
    type: 'mtt',
    buyIn: 5.5,
    startingStack: 12000,
    maxPlayers: 300,
    minPlayers: 4,
    blindPreset: 'TURBO',
    payoutPreset: 'FIVE',
  };

  it.each([
    ['nlh', 'NLH', 2, false],
    ['plo', 'PLO4', 4, true],
    ['PLO', 'PLO4', 4, true],
    ['plo4', 'PLO4', 4, true],
    ['PLO5', 'PLO5', 5, true],
    ['plo6', 'PLO6', 6, true],
    ['PLO8', 'PLO8', 4, true],
    ['shortdeck', 'SHORT_DECK', 2, false],
    ['SHORT_DECK', 'SHORT_DECK', 2, false],
    ['flh', 'FLH', 2, false],
    ['FLO8', 'FLO8', 4, true],
  ])(
    'creates the scheduled %s game with its actual engine rules',
    async (gameVariant, gameType, cards, omaha) => {
      const service = new ScheduledTournamentService();
      const cfg = { ...scheduledConfig, gameVariant };
      const original = structuredClone(cfg);
      const row = await (service as any).buildInsertRow(schedule, cfg, new Date());
      expect(row).toMatchObject({
        game_type: gameType,
        variant: 'freezeout',
        // Preserve the existing whole-chip/price-ladder policy: 5.5 -> 6 -> 5.
        buy_in_amount: 4.5,
        buy_in_fee: 0.5,
      });
      expect(holeCardCount(row.game_type.toLowerCase())).toBe(cards);
      expect(isOmahaVariant(row.game_type.toLowerCase())).toBe(omaha);
      expect(cfg).toEqual(original);
    }
  );

  it.each([undefined, null])('keeps the scheduled NLH default when absent (%j)', async (value) => {
    const cfg = { ...scheduledConfig, gameVariant: value };
    const row = await (new ScheduledTournamentService() as any).buildInsertRow(
      schedule,
      cfg,
      new Date()
    );
    expect(row.game_type).toBe('NLH');
  });

  it.each(
    ['unknown-game', '', '__proto__', 'constructor', ['plo'], 123].map((gameVariant) => ({
      gameVariant,
    }))
  )(
    'refuses explicit unsupported scheduled variant $gameVariant before claiming or inserting',
    async ({ gameVariant }) => {
      const service = new ScheduledTournamentService();
      const claim = vi.spyOn(service as any, 'claimSpawn').mockResolvedValue(false);
      const from = vi.spyOn(supabase, 'from').mockImplementation(() => {
        throw new Error('An invalid scheduled variant must not reach the database');
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await (service as any).spawnInstance(
        schedule,
        { ...scheduledConfig, gameVariant },
        'scheduled-variant-refusal',
        new Date()
      );
      expect(claim).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        '[ScheduledTournaments.unknown_game_variant]',
        expect.any(Error)
      );
    }
  );

  it.each([10, 15, 20, '15', null, '', false, 'bad', '1.5e1', 25])(
    'the scheduled row retains supported paid depth or the database default (%j)',
    async (payoutPercent) => {
      const service = new ScheduledTournamentService();
      const cfg = {
        name: 'Paid Field',
        type: 'mtt',
        buyIn: 10,
        maxPlayers: 100,
        blindPreset: 'STANDARD',
        payoutPreset: 'NINE',
        payoutPercent,
      };
      const row = await (service as any).buildInsertRow(
        { id: 'schedule-1', club_id: 'club-1', union_id: null, name: cfg.name },
        cfg,
        new Date()
      );
      const expected =
        payoutPercent === 15 || payoutPercent === '15' ? 15 : payoutPercent === 20 ? 20 : 10;
      expect(row.payout_percent).toBe(expected);
      expect(mttPayoutPercent(payoutPercent)).toBe(expected);
    }
  );

  it('manual repeats copy paid depth with their advertised configuration', () => {
    expect((ScheduledTournamentService as any).RESTART_COPY_COLUMNS).toContain('payout_percent');
  });

  it('preserves an explicitly priced fractional bounty within the entry contribution', async () => {
    const service = new ScheduledTournamentService();
    const cfg = {
      name: 'Exact Bounty',
      type: 'progressive_bounty',
      buyIn: 15,
      startingStack: 10000,
      maxPlayers: 100,
      bountyAmount: 6.75,
      blindPreset: 'TURBO',
      payoutPreset: 'NINE',
    };
    const row = await (service as any).buildInsertRow(
      { id: 'schedule-1', club_id: 'club-1', union_id: null, name: cfg.name },
      cfg,
      new Date()
    );
    expect(row).toMatchObject({ buy_in_amount: 13.5, buy_in_fee: 1.5, bounty_amount: 6.75 });
    expect(row.bounty_amount / row.buy_in_amount).toBe(0.5);
  });

  it('caps a configured bounty at the entry contribution without absorbing its fee', async () => {
    const service = new ScheduledTournamentService();
    const cfg = {
      name: 'Capped Bounty',
      type: 'bounty',
      buyIn: 15,
      startingStack: 10000,
      maxPlayers: 100,
      bountyAmount: 50,
      blindPreset: 'STANDARD',
      payoutPreset: 'NINE',
    };
    const row = await (service as any).buildInsertRow(
      { id: 'schedule-1', club_id: 'club-1', union_id: null, name: cfg.name },
      cfg,
      new Date()
    );
    expect(row).toMatchObject({ buy_in_amount: 13.5, buy_in_fee: 1.5, bounty_amount: 13.5 });
  });
  it.each([
    [[{ durationMinutes: 10 }, { durationMinutes: 2 }], 'standard', false],
    [[{ durationMinutes: 4 }], 'turbo', true],
    [[{ duration_minutes: 5 }], 'turbo', true],
    [[{ duration: 120 }], 'hyper_turbo', true],
    [[{ durationMinutes: 15 }], 'slow', false],
    [[{ isBreak: true, durationMinutes: 5 }, { durationMinutes: 12 }], 'slow', false],
    [[{ durationMinutes: 0, duration: 180 }], 'turbo', true],
  ])('classifies the actual opening clock including legacy units (%j)', (levels, speed, turbo) => {
    expect(mttSpeedColumns(levels as unknown[])).toEqual({ blind_speed: speed, is_turbo: turbo });
  });

  it('keeps recurring and scheduled ladders on the same engine definition', () => {
    for (const name of ['STANDARD', 'TURBO', 'HYPER_TURBO'] as const) {
      expect(BLIND_STRUCTURES[name]).toBe(MTT_BLIND_PRESETS[name]);
      expect(SCHEDULE_BLIND_PRESETS[name]).toBe(MTT_BLIND_PRESETS[name]);
    }
    expect(SCHEDULE_BLIND_PRESETS.DEEPSTACK).toBe(MTT_BLIND_PRESETS.SLOW);
  });

  it('writes a scheduled custom turbo correctly despite its name, depth and overridden preset', async () => {
    const service = new ScheduledTournamentService();
    const cfg = {
      name: 'Deep Field',
      type: 'mtt',
      buyIn: 10,
      startingStack: 30000,
      maxPlayers: 100,
      blindPreset: 'STANDARD',
      payoutPreset: 'NINE',
      blindStructure: [{ level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 4 }],
    };
    const row = await (service as any).buildInsertRow(
      { id: 'schedule-1', club_id: 'club-1', union_id: null, name: cfg.name },
      cfg,
      new Date()
    );
    expect(row).toMatchObject({
      is_turbo: true,
      blind_speed: 'turbo',
      starting_chips: 30000,
      blind_structure: cfg.blindStructure,
    });
  });

  it.each(['createTournament', 'createXMTT'])(
    'persists clock and paid depth in the real %s insert path',
    async (method) => {
      const inserts: Record<string, unknown>[] = [];
      const chain = {
        insert: vi.fn((row: Record<string, unknown>) => {
          inserts.push(row);
          return chain;
        }),
        select: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => ({
          data: { ...inserts.at(-1), id: 'event-1', format_contract: 'mtt-v1' },
          error: null,
        })),
        update: vi.fn(() => chain),
        eq: vi.fn(async () => ({ error: null })),
      };
      vi.spyOn(supabase, 'from').mockReturnValue(chain as never);
      vi.spyOn(supabase, 'rpc').mockImplementation(((
        name: string,
        args: { p_tournament_ids: string[] }
      ) => {
        expect(name).toBe('fn_ca_tournament_admission_snapshot');
        expect(args).toEqual({ p_tournament_ids: ['event-1'] });
        return Promise.resolve({
          data: {
            ok: true,
            admission_abi: 'legacy-capacity-v1',
            entries: [
              { tournament_id: 'event-1', format_contract: 'mtt-v1', effective_max_players: 100 },
            ],
          },
          error: null,
        });
      }) as never);
      const service = new TournamentRecurringService();
      vi.spyOn(service as any, 'registerHorses').mockResolvedValue(0);
      const config = {
        name: 'Clock Test',
        payoutPercent: 20,
        gameVariant: 'nlh',
        type: 'mtt',
        buyIn: 10,
        guarantee: 0,
        startingStack: 10000,
        maxPlayers: 100,
        horsesToRegister: 0,
        blindStructure: MTT_BLIND_PRESETS.TURBO,
        payoutStructure: [{ place: 1, percentage: 100 }],
      };
      const result = await (service as any)[method](config, 'union-1', 'club-1');
      expect(result.tournamentId).toBe('event-1');
      expect(inserts).toHaveLength(1);
      expect(inserts[0]).toMatchObject({
        blind_speed: 'turbo',
        is_turbo: true,
        starting_chips: 10000,
        payout_percent: 20,
      });
    }
  );
});
