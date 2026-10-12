import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';
import { diamondSpinSettlementProven } from './diamondSpinLaunchProof.js';

const here = dirname(fileURLToPath(import.meta.url));
const manager = readFileSync(join(here, 'TournamentManagerBase.ts'), 'utf8');
const prove = sliceMethod(manager, 'private async proveTournamentLaunchSetup(');

const proven = {
  proof: { ok: true, multiplier: 4, prize_pool: 40, underwrite: 10, surplus: 0 },
  buyIn: 10,
  cachedMultiplier: 4,
  cachedPrizePool: 40,
  rowMultiplier: '4',
  rowPrizePool: '40',
};

describe("a Diamond Spin's launch is proved by its own draw", () => {
  it('admits the launch its proven draw, its row and the manager all name', () => {
    expect(diamondSpinSettlementProven(proven)).toBe(true);
    expect(
      diamondSpinSettlementProven({
        ...proven,
        proof: { ok: true, multiplier: 1, prize_pool: 10 },
        cachedMultiplier: 1,
        cachedPrizePool: 10,
        rowMultiplier: 1,
        rowPrizePool: 10,
      })
    ).toBe(true);
  });

  it('refuses a draw the database did not prove', () => {
    expect(diamondSpinSettlementProven({ ...proven, proof: null })).toBe(false);
    expect(
      diamondSpinSettlementProven({
        ...proven,
        proof: { ok: false, reason: 'diamond_spin_draw_unproven', multiplier: 4, prize_pool: 40 },
      })
    ).toBe(false);
  });

  it('refuses a multiplier the row or the manager does not carry', () => {
    expect(diamondSpinSettlementProven({ ...proven, cachedMultiplier: 1 })).toBe(false);
    expect(diamondSpinSettlementProven({ ...proven, rowMultiplier: 0 })).toBe(false);
    expect(
      diamondSpinSettlementProven({
        ...proven,
        proof: { ok: true, multiplier: 0, prize_pool: 0 },
        cachedMultiplier: 0,
        cachedPrizePool: 0,
        rowMultiplier: 0,
        rowPrizePool: 0,
      })
    ).toBe(false);
    expect(diamondSpinSettlementProven({ ...proven, proof: { ok: true, prize_pool: 40 } })).toBe(
      false
    );
  });

  it('refuses a pool that is not the buy-in times the drawn multiplier, wherever it is read', () => {
    expect(
      diamondSpinSettlementProven({ ...proven, proof: { ok: true, multiplier: 4, prize_pool: 30 } })
    ).toBe(false);
    expect(diamondSpinSettlementProven({ ...proven, rowPrizePool: 30 })).toBe(false);
    expect(diamondSpinSettlementProven({ ...proven, cachedPrizePool: 0 })).toBe(false);
  });

  it('reads the Diamond draw proof for a Diamond Spin before the chip reserve ledger, and nowhere else', () => {
    const diamond = prove.indexOf('this.tournamentUnit() === DIAMOND_UNIT_CENTS');
    const chip = prove.indexOf(
      'if (spinLaunch && Number(tournament.buy_in_amount) > 0) {\n      const { data: bookedRows'
    );
    expect(diamond).toBeGreaterThan(-1);
    expect(chip).toBeGreaterThan(diamond);
    expect(prove.indexOf(".from('spin_reserve_ledger')")).toBeGreaterThan(chip);
    const arm = prove.slice(diamond, chip);
    expect(arm).toContain("'fn_poker_diamond_spin_draw_proof'");
    expect(arm).toContain('{ p_tournament_id: this.tournamentId, p_launch_id: null }');
    expect(arm).toContain('diamondSpinSettlementProven({');
    expect(arm).toContain(
      "return refuse('the Spin row and its Diamond draw do not prove the same exact launch');"
    );
    expect(arm).toMatch(/return true;\s*\}\s*$/);
    // the chip settlement check is the one it always was
    expect(prove).toContain(".eq('kind', 'jackpot_draw')");
    expect(prove).toContain('Number(bookedRows[0].house_rake) !== expectedRake');
  });
});
