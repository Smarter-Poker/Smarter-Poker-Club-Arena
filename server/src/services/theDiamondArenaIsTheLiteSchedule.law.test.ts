/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE DIAMOND ARENA IS THE LITE VERSION OF THE MIDWAY SCHEDULE (2026-10-17)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "MAKE A 'LITE VERSION' OF THIS SCHEDULE FOR THE DIAMOND ARENA
 * ALL TOURNAMENT BUY IN ARE 10% OF THE PRICE OF THE MIDWAY TOURNAMENTS (1
 * DIAMOND = 1 CENT) AND KEEP THE SAME FREE ROLLS GUARANTEE AND REBUY ADD ON AT
 * 100 DIAMONDS."
 *
 * A Midway chip is a dollar and a Diamond a cent, so the arena charges ten
 * Diamonds for every chip the Midway occurrence of the same schedule charges:
 * entry, guarantee, bounty, rebuy and add-on. A freeroll keeps its guarantee as
 * a Diamond count and charges 100 Diamonds a rebuy or add-on.
 *
 * The board is checked event by event through the same builders the scheduler
 * uses (fixedBoardRow), so a template whose arena price drifts off ten
 * Diamonds a chip fails here by name.
 */
import { describe, expect, it } from 'vitest';
import { FIXED_BOARD } from '../config/fixedBoard.js';
import { BUY_IN_LADDER, buyInFor } from '../config/buyIn.js';
import { fixedBoardRow } from './ScheduledTournamentService.js';
import {
  DIAMOND_ARENA_DIAMONDS_PER_CHIP,
  DIAMOND_FREEROLL_REBUY_DIAMONDS,
  diamondSpawnConfig,
} from './diamondScheduledSpawn.js';

const ARENA = '002c2d27-9584-4e52-835a-bb2be148fc81';
const START = new Date('2026-10-21T00:00:00.000Z'); // 19:00 Chicago, Tuesday 2026-10-20

const arenaSchedule = (name: string) => ({
  id: '22222222-2222-2222-2222-222222222222',
  club_id: ARENA,
  union_id: null,
  name,
});

describe('the Diamond Arena charges ten Diamonds for every Midway chip', () => {
  it('is ten: a chip is a dollar, a Diamond is a cent, and the arena is 10%', () => {
    expect(DIAMOND_ARENA_DIAMONDS_PER_CHIP).toBe(10);
    expect(DIAMOND_FREEROLL_REBUY_DIAMONDS).toBe(100);
  });

  it('prices every paid board event at ten Diamonds a chip, guarantee and bounty included', () => {
    let paid = 0;
    for (const e of FIXED_BOARD) {
      const row = fixedBoardRow(arenaSchedule(e.name), { fixedBoard: e.name }, START)!;
      expect(row, e.name).toBeTruthy();
      const chips = Number(row.buy_in_amount) + Number(row.buy_in_fee);
      if (!(chips > 0)) continue;
      paid += 1;
      const mapped = diamondSpawnConfig(row, { fixedBoard: e.name }, START);
      expect(mapped.ok, e.name).toBe(true);
      if (!mapped.ok) continue;
      expect(mapped.config.buyIn, e.name).toBe(chips * 10);
      expect(mapped.config.guaranteedPrize, e.name).toBe(Number(row.guaranteed_prize) * 10);
      if (mapped.config.bountyAmount !== undefined) {
        expect(mapped.config.bountyAmount, e.name).toBe(
          Math.floor(Number(row.bounty_amount) * 10 + 1e-9)
        );
      }
      if (mapped.config.rebuyCost !== undefined) {
        expect(mapped.config.rebuyCost, e.name).toBe(Math.floor(Number(row.rebuy_cost) * 10));
      }
      if (mapped.config.addonCost !== undefined) {
        expect(mapped.config.addonCost, e.name).toBe(Math.floor(Number(row.addon_cost) * 10));
      }
    }
    expect(paid).toBeGreaterThan(15);
  });

  it('keeps every freeroll guarantee as it is and charges 100 Diamonds a rebuy or add-on', () => {
    let free = 0;
    for (const e of FIXED_BOARD) {
      const row = fixedBoardRow(arenaSchedule(e.name), { fixedBoard: e.name }, START)!;
      if (Number(row.buy_in_amount) + Number(row.buy_in_fee) > 0) continue;
      free += 1;
      const mapped = diamondSpawnConfig(row, { fixedBoard: e.name }, START);
      expect(mapped.ok, e.name).toBe(true);
      if (!mapped.ok) continue;
      expect(mapped.config.buyIn, e.name).toBe(0);
      expect(mapped.config.guaranteedPrize, e.name).toBe(Math.floor(Number(row.guaranteed_prize)));
      if (mapped.config.rebuyCost !== undefined) expect(mapped.config.rebuyCost, e.name).toBe(100);
      if (mapped.config.addonCost !== undefined) expect(mapped.config.addonCost, e.name).toBe(100);
    }
    // Five Free Buys and the Coffee Break Freeroll.
    expect(free).toBe(6);
  });

  it('the Nightly 10K is 35 chips at the Midway and 350 Diamonds in the arena', () => {
    // 35 is a ladder rung, so the scheduler charges it as set instead of 30.
    expect(BUY_IN_LADDER as readonly number[]).toContain(35);
    expect(buyInFor(35).total).toBe(35);
    const row = {
      name: 'Nightly 10K (NLH)',
      variant: 'freezeout',
      tournament_type: 'MTT',
      buy_in_amount: 31.5,
      buy_in_fee: 3.5,
      guaranteed_prize: 10000,
      max_players: 500,
      is_rebuy: true,
      rebuy_cost: 35,
      add_on_available: true,
      addon_cost: 35,
    };
    const mapped = diamondSpawnConfig(row, { buyIn: 35 }, START);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.config.buyIn).toBe(350);
    expect(mapped.config.rebuyCost).toBe(350);
    expect(mapped.config.addonCost).toBe(350);
    expect(mapped.config.guaranteedPrize).toBe(100000);
  });
});
