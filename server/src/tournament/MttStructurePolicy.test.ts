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

afterEach(() => vi.restoreAllMocks());

describe('engine MTT structure policy', () => {
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
        maybeSingle: vi.fn(async () => ({ data: { id: 'event-1' }, error: null })),
        update: vi.fn(() => chain),
        eq: vi.fn(async () => ({ error: null })),
      };
      vi.spyOn(supabase, 'from').mockReturnValue(chain as never);
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
