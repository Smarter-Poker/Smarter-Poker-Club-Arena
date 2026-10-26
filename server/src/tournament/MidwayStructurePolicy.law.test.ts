import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ScheduledTournamentService,
  fixedBoardRow,
} from '../services/ScheduledTournamentService.js';
import { fixedFreeBuyRow } from '../services/TournamentRecurringService.js';
import { auditFreeBuyRow } from '../services/FreeBuy.js';
import { MIDWAY_UNION_ID, withMidwayStructure } from './midwayStructurePolicy.js';
import { bigBlindAnteTotal } from '../engine/AnteMath.js';
import { maxSeatsFor } from '../engine/VariantRules.js';
import { validateMttBlindStructure } from '../domain/tournamentBlindContract.js';

const schedules: { name: string; config: Record<string, unknown> }[] = JSON.parse(
  readFileSync(new URL('./fixtures/midwaySchedules.json', import.meta.url), 'utf8')
);
const start = new Date('2026-10-25T18:00:00Z');
afterEach(() => vi.restoreAllMocks());

describe('Midway standard structures through the actual scheduled creator', () => {
  it.each(schedules.filter((s) => s.name !== 'Coffee Break Freeroll (PLO4)'))(
    '$name has a playable, conventional full structure',
    async ({ name, config }) => {
      const schedule = {
        id: 'schedule',
        name,
        club_id: MIDWAY_UNION_ID,
        union_id: MIDWAY_UNION_ID,
      };
      const service = new ScheduledTournamentService();
      vi.spyOn(service as any, 'resolveSatelliteTarget').mockResolvedValue(
        '00000000-0000-4000-8000-000000000001'
      );
      const row = await (service as any).buildInsertRow(schedule, config, start);
      expect(row, name).not.toBeNull();
      const smallBounty = ['Sunrise Bounty (NLH)', 'Midnight Bounty (NLH)'].includes(name);
      if (smallBounty) {
        expect(row).toMatchObject({
          buy_in_amount: 5,
          buy_in_fee: 0.5,
          bounty_amount: 2,
          rebuy_cost: 5.5,
          addon_cost: 5.5,
        });
        expect(row.buy_in_amount - row.bounty_amount).toBe(3);
      } else if (row.is_bounty && !row.is_pko && !row.is_mystery_bounty) {
        expect(row.bounty_amount % 5).toBe(0);
        expect(row.bounty_amount).toBeLessThanOrEqual(row.buy_in_amount);
      }
      const levels = row.blind_structure;
      expect(row.table_size).toBeLessThanOrEqual(maxSeatsFor(row.game_type));
      if (name === 'Mid-Morning Turbo (6-Max NLH)') expect(row.table_size).toBe(6);
      expect(levels).toHaveLength(40);
      expect(levels[0]).toMatchObject({ smallBlind: 25, bigBlind: 25, ante: 0 });
      expect(levels[1]).toMatchObject({ smallBlind: 25, bigBlind: 50, ante: 0 });
      expect(levels[2]).toMatchObject({ smallBlind: 50, bigBlind: 100, ante: 0 });
      for (const [i, level] of levels.entries()) {
        expect(level.smallBlind % 25).toBe(0);
        expect(level.bigBlind % 25).toBe(0);
        expect(level.durationMinutes).toBe(levels[0].durationMinutes);
        if (i > 0) expect(level.bigBlind).toBeGreaterThan(levels[i - 1].bigBlind);
        if (row.game_type === 'NLH' && i >= 4) {
          expect(row.big_blind_ante).toBe(true);
          expect(bigBlindAnteTotal(level.ante, 9, level.bigBlind)).toBe(level.bigBlind);
        } else expect(level.ante).toBe(0);
      }
      validateMttBlindStructure(levels, row.starting_chips);
      if (row.free_buy) {
        expect(row.starting_chips).toBe(3000);
        expect(row.late_reg_mins).toBe(60);
        expect(row.late_reg_levels).toBe(12);
        expect(row.rebuy_cost).toBe(1);
        expect(row.addon_cost).toBe(1);
        expect(row.addon_chips).toBe(10000);
      } else {
        expect(row.starting_chips % 5000).toBe(0);
        if (row.late_reg_levels > 0)
          expect(
            row.starting_chips / levels[row.late_reg_levels - 1].bigBlind
          ).toBeGreaterThanOrEqual(20);
        if (row.add_on_available)
          expect(row.addon_chips).toBeGreaterThanOrEqual(row.starting_chips * 2);
        if (config.buyIn != null && !smallBounty)
          expect(Number(row.buy_in_amount) + Number(row.buy_in_fee)).toBe(config.buyIn);
      }
      if (config.guaranteedPrize != null) expect(row.guaranteed_prize).toBe(config.guaranteedPrize);
      expect(row.is_rebuy).toBe(true);
      expect(row.add_on_available).toBe(!/^Sunday[ -]?200(?:\b|$)/i.test(name));
      if (row.is_rebuy) {
        expect(row.rebuy_levels).toBe(row.late_reg_levels);
        expect(row.rebuy_chips).toBe(row.starting_chips);
      }
      if (row.add_on_available) {
        expect(row.addon_levels).toBe(1);
        expect(row.addon_from_start).toBe(row.free_buy === true);
        expect(row.addon_break_minutes).toBe(1);
      }
      expect(withMidwayStructure(row)).toEqual(row);
    }
  );

  it('refuses the owner-removed Midway 11 AM freeroll', () => {
    expect(
      fixedBoardRow(
        {
          id: 'removed',
          club_id: MIDWAY_UNION_ID,
          union_id: MIDWAY_UNION_ID,
          name: 'Coffee Break Freeroll (PLO4)',
        },
        { fixedBoard: 'Coffee Break Freeroll (PLO4)' },
        start
      )
    ).toBeNull();
  });

  it('reproduces the former floor(25 / 2) opening and repairs its owner', () => {
    const old = fixedFreeBuyRow('Morning Free Buy (NLH)', start, {
      clubId: MIDWAY_UNION_ID,
      unionId: MIDWAY_UNION_ID,
      label: 'Midway',
    });
    expect((old!.blind_structure as any[])[0].smallBlind).toBe(12);
    const row = fixedBoardRow(
      {
        id: 'schedule',
        name: 'Morning Free Buy (NLH)',
        club_id: MIDWAY_UNION_ID,
        union_id: MIDWAY_UNION_ID,
      },
      { fixedBoard: 'Morning Free Buy (NLH)' },
      start
    );
    expect((row!.blind_structure as any[])[0].smallBlind).toBe(25);
    expect(row!.guaranteed_prize).toBe(250);
    expect(auditFreeBuyRow({ ...row!, start_time: '2026-10-25T13:30:00Z' })).toEqual([]);
  });

  it('rounds only fixed bounties up to five and refuses an unfunded promise', () => {
    const row = {
      club_id: MIDWAY_UNION_ID,
      tournament_type: 'MTT',
      name: 'Fixed Bounty',
      short_description: '25% Of Each Entry Contribution Funds A Fixed Knockout Bounty.',
      buy_in_amount: 13.5,
      buy_in_fee: 1.5,
      starting_chips: 5000,
      late_reg_levels: 6,
      blind_structure: [{ smallBlind: 25, bigBlind: 50, durationMinutes: 8 }],
      is_bounty: true,
      is_pko: false,
      is_mystery_bounty: false,
      bounty_amount: 7.5,
    };
    expect(withMidwayStructure(row).bounty_amount).toBe(10);
    expect(withMidwayStructure(row).short_description).toBe(
      'Fixed Knockout Bounty: 10 Chips. Entry: 3.5 Prize Pool + 10 Bounty + 1.5 Fee.'
    );
    expect(withMidwayStructure({ ...row, bounty_amount: 10 }).bounty_amount).toBe(10);
    expect(withMidwayStructure({ ...row, is_pko: true }).bounty_amount).toBe(7.5);
    expect(withMidwayStructure({ ...row, is_mystery_bounty: true }).bounty_amount).toBe(7.5);
    expect(() => withMidwayStructure({ ...row, buy_in_amount: NaN })).toThrow(
      'funded by the net entry'
    );
    expect(() => withMidwayStructure({ ...row, buy_in_amount: 4.5, bounty_amount: 1.5 })).toThrow(
      'funded by the net entry'
    );
  });

  it('uses authored freezeout intent and preserves purchase prices', () => {
    const base: Record<string, unknown> = {
      club_id: MIDWAY_UNION_ID,
      tournament_type: 'MTT',
      name: 'Daily',
      variant: 'freezeout',
      buy_in_amount: 18,
      buy_in_fee: 2,
      starting_chips: 5000,
      late_reg_levels: 6,
      blind_structure: [{ smallBlind: 25, bigBlind: 50, durationMinutes: 8 }],
    };
    expect(withMidwayStructure(base, { type: 'mtt' })).toMatchObject({
      is_rebuy: true,
      is_reentry: true,
      rebuy_cost: 20,
      add_on_available: true,
      addon_cost: 20,
      addon_chips: 10000,
      addon_break_minutes: 1,
    });
    for (const authored of [
      { type: 'freezeout' },
      { type: 'mtt_freezeout' },
      { name: 'Daily Freezeout' },
    ]) {
      expect(withMidwayStructure(base, authored)).toMatchObject({
        is_rebuy: false,
        is_reentry: false,
        rebuy_cost: null,
        rebuy_chips: null,
        rebuy_levels: null,
        add_on_available: false,
        addon_cost: null,
        addon_chips: null,
        addon_levels: null,
      });
    }
    expect(
      withMidwayStructure({ ...base, name: 'Sunday 200', add_on_available: true })
    ).toMatchObject({
      is_rebuy: true,
      rebuy_cost: 20,
      add_on_available: false,
      addon_cost: null,
    });
    expect(withMidwayStructure({ ...base, rebuy_cost: 7, addon_cost: 9 })).toMatchObject({
      rebuy_cost: 7,
      addon_cost: 9,
    });
  });

  it('does not change another club or a seat-first format', () => {
    const other = { club_id: 'another-club', tournament_type: 'MTT', blind_structure: [] };
    expect(withMidwayStructure(other)).toBe(other);
    const spin = { club_id: MIDWAY_UNION_ID, tournament_type: 'SPIN', blind_structure: [] };
    expect(withMidwayStructure(spin)).toBe(spin);
  });
});
