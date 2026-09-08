/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE PRIZE POOL COUNTS HORSES, BECAUSE HORSES PAY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * recalculatePrizePool subtracted every horse from the entry count on the
 * stated premise that "horses register free (buy_in 0) and must not inflate the
 * prize pool".
 *
 * Production, over the seven days to 2026-08-28:
 *
 *     humans   18 buy-ins        702.00 chips
 *     horses   104,317 buy-ins   2,313,221.00 chips
 *
 * Horses fund 99.97% of tournament prize money. fn_register_horse_for_tournament
 * charges them through atomic_deduct_wallet_and_log and adds v_split.prize to
 * prize_pool on the same terms as the human path — its own comment reads "a
 * horse and a human must enter the same event on the same terms". So the pool
 * the database builds is correct, and this function rebuilt it with the horses
 * deleted and overwrote it, after every rebuy, add-on and re-entry.
 *
 * These assert the SOURCE, not a live query, because the defect is a filter
 * that must never come back. They are deliberately about the contract rather
 * than about formatting — a guard test here has already been broken once by
 * prettier rewrapping a signature.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/services/TournamentService.ts'), 'utf8');

describe('the browser never reconstructs or finalizes a tournament prize pool', () => {
  it('removes both duplicate client-side pool writers', () => {
    expect(SRC).not.toContain('async recalculatePrizePool(');
    expect(SRC).not.toContain('async finalizePrizePool(');
  });

  it('leaves each purchase pool mutation inside process_tournament_rebuy', () => {
    expect(SRC).toContain("supabase.rpc('process_tournament_rebuy'");
    expect(SRC).not.toContain('await this.recalculatePrizePool(');
  });

  it('never filters entries by horse identity anywhere in the service', () => {
    expect(SRC).not.toMatch(/is_horse|horseIds|horseRows/);
  });
});
