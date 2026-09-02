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

/** Just the body of recalculatePrizePool. */
function recalcBody(): string {
  const start = SRC.indexOf('async recalculatePrizePool(');
  expect(start).toBeGreaterThan(-1);
  // The next method declaration at the same indentation ends it.
  const rest = SRC.slice(start + 10);
  const end = rest.indexOf('\n  async ');
  return rest.slice(0, end === -1 ? rest.length : end);
}

describe('recalculatePrizePool treats horses as players', () => {
  it('never filters entries by is_horse', () => {
    expect(recalcBody()).not.toMatch(/is_horse/);
  });

  it('does not reintroduce a horse-id exclusion set', () => {
    const body = recalcBody();
    expect(body).not.toMatch(/horseIds/);
    expect(body).not.toMatch(/horseRows/);
  });

  it('counts every tournament_players row as an entry', () => {
    // One row is one paid entry; re-entries create additional rows.
    expect(recalcBody()).toMatch(/entryCount\s*=\s*entryRows\?\.length/);
  });

  it('the whole service no longer excludes horses anywhere', () => {
    expect(SRC).not.toMatch(/is_horse/);
  });
});

describe('recalculatePrizePool refuses to write on an unreadable input', () => {
  it('destructures error on the entry, rebuy and fee reads', () => {
    const body = recalcBody();
    // supabase-js does not throw on a PostgREST error, so an undestructured
    // `error` is invisible and the pool gets overwritten with a wrong number.
    expect(body).toMatch(/error:\s*entryErr/);
    expect(body).toMatch(/error:\s*rebuyErr/);
    expect(body).toMatch(/error:\s*feeErr/);
  });

  it('returns the existing pool rather than writing a guessed one', () => {
    const body = recalcBody();
    const guards = body.match(/return tournament\.prize_pool \|\| 0;/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });
});
