/**
 * Dan's locked seat-first catalog (2026-09-01), pinned.
 *
 * Heads-Up: nine buy-ins x four games x four depth bands = 144 queues, every
 * band on the SAME three-minute clock (Dan 2026-08-23: "SPEED SHOULDN'T
 * CHANGE, ONLY THE STARTING STACK"). Spins: the locked eight-step price
 * ladder across five variants = 40 queues. ensureBoardOpen keys queues by
 * NAME, so name uniqueness is load-bearing: two configs sharing a name
 * would cover for each other and one queue would never open.
 */
import { describe, it, expect } from 'vitest';
import { SNG_CONFIGS, SPIN_CONFIGS } from './TournamentRecurringService.js';
import { HEADS_UP_BUYINS, HEADS_UP_GAME_TYPES, HEADS_UP_STACKS } from '../config/headsUpSpec.js';

describe('the heads-up board is the locked 144-queue grid', () => {
  it('nine buy-ins, four games, four depth bands', () => {
    expect(HEADS_UP_BUYINS).toEqual([1, 2, 5, 10, 25, 50, 100, 250, 500]);
    expect(HEADS_UP_GAME_TYPES).toEqual(['nlh', 'plo4', 'plo5', 'short_deck']);
    expect(Object.keys(HEADS_UP_STACKS).sort()).toEqual(['deep', 'hyper', 'regular', 'turbo']);
    expect(SNG_CONFIGS).toHaveLength(9 * 4 * 4);
  });

  it('every queue name is unique, because the board keys on it', () => {
    const names = SNG_CONFIGS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every duel is two-handed with one horse opener and a band stack', () => {
    const stacks = new Set<number>(Object.values(HEADS_UP_STACKS));
    for (const c of SNG_CONFIGS) {
      expect(c.maxPlayers).toBe(2);
      expect(c.minPlayers).toBe(2);
      expect(c.horsesToRegister).toBe(1);
      expect(stacks.has(c.startingStack)).toBe(true);
      expect(HEADS_UP_BUYINS).toContain(c.buyIn as (typeof HEADS_UP_BUYINS)[number]);
    }
  });

  it('depth is the only difference between bands: one shared blind ladder', () => {
    const ladders = new Set(SNG_CONFIGS.map((c) => JSON.stringify(c.blindStructure)));
    expect(ladders.size).toBe(1);
  });
});

describe('the spin board is the locked price ladder', () => {
  it('eight buy-ins across five variants', () => {
    const buyIns = [...new Set(SPIN_CONFIGS.map((c) => c.buyIn))].sort((a, b) => a - b);
    expect(buyIns).toEqual([1, 2, 5, 10, 25, 50, 100, 250]);
    const variants = [...new Set(SPIN_CONFIGS.map((c) => c.gameVariant))].sort();
    expect(variants).toEqual(['nlh', 'plo4', 'plo5', 'plo6', 'short_deck']);
    expect(SPIN_CONFIGS).toHaveLength(8 * 5);
  });

  it('every spin is three-handed with the last seat held for a human', () => {
    for (const c of SPIN_CONFIGS) {
      expect(c.maxPlayers).toBe(3);
      expect(c.horsesToRegister).toBe(2);
    }
  });

  it('every queue name is unique', () => {
    const names = SPIN_CONFIGS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
