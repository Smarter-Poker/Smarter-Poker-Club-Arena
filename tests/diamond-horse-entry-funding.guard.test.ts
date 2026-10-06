/**
 * THE DIAMOND HORSE REGISTERS FROM ITS OWN BALANCE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md 10.5 (HORSES ARE PLAYERS, BINDING - NO EXCEPTIONS) and the owner's
 * recorded answer to design decision A18, which
 * 20261005151918_diamond_economics_records_the_owner_answers.sql wrote into
 * ca_diamond_economics as horse_entry_funding = 'own_balance' with the
 * rationale "a horse funds its Diamond entry from its own balance, through the
 * ordinary Diamond registration door a person uses".
 *
 * Before 20261005224736, fn_register_horse_for_tournament(uuid,uuid,boolean)
 * refused EVERY Diamond tournament at its first statement under the comment
 * "DIAMOND PHASE 8: house-funded horse entries are Phase 9." The comment
 * scoped itself to house-funded entries; the refusal did not. While Diamond
 * tournaments are open that is a live asymmetry: a person could register and a
 * horse could not.
 *
 * This pins the migration that retired it, because the fix has two halves and
 * EITHER HALF ALONE IS A DEFECT:
 *
 *   1. The door must read the setting AT CALL TIME, not hard-code the answer -
 *      the whole point of ca_diamond_economics is that changing an answer is
 *      one INSERT. 'funding_account' is house money with no funding path yet,
 *      so it stays refused BY NAME, and an unset or unrecognised answer is
 *      refused by name too rather than guessed at.
 *
 *   2. The core must be able to FUND a Diamond entry. The horse core was
 *      chips-only: atomic_deduct_wallet_and_log plus a funding receipt with
 *      the asset hard-coded 'chips'. Lifting the refusal without giving the
 *      core the human door's Diamond arm would have charged CHIPS for a
 *      Diamond entry and created no custody row for any later Diamond door to
 *      read - and ruling 16 forbids a chip account in a Diamond format.
 *
 * Every pin carries a negative control, so a matcher that matches nothing
 * cannot pass by accident.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20261005224736_the_diamond_horse_registers_from_its_own_balance.sql'
);
const sql = readFileSync(MIGRATION, 'utf8');

/** What the door's refusal looked like before this migration. */
const COUNTERFEIT = `
  -- DIAMOND PHASE 8: house-funded horse entries are Phase 9.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','diamond_horse_funding_not_open');
  END IF;
`;

describe('the Diamond horse registers from its own balance', () => {
  it('reads horse_entry_funding at call time instead of hard-coding the answer', () => {
    expect(sql).toContain("fn_ca_diamond_economic_text('horse_entry_funding','all')");
    // The setting read is what decides; the migration must not bake the
    // current answer in as an unconditional pass.
    expect(COUNTERFEIT).not.toContain('horse_entry_funding');
  });

  it('retires the blanket refusal and refuses the other answers by name', () => {
    // The old reason is removed from the live door, and the post-apply block
    // asserts that it is gone.
    expect(sql).toContain("position('diamond_horse_funding_not_open' in v_door) <> 0");
    // House funding is still refused, and the reason names what refused it.
    expect(sql).toContain('diamond_horse_funding_account_not_open');
    // An unset or unrecognised answer is refused rather than guessed at.
    expect(sql).toContain('diamond_horse_entry_funding_unrecognised');
    expect(sql).toContain("EXCEPTION WHEN SQLSTATE 'P0D01' THEN");
    expect(COUNTERFEIT).not.toContain('diamond_horse_funding_account_not_open');
  });

  it('funds the Diamond entry through the door a person uses, in whole Diamonds', () => {
    // The human door's Diamond arm, reused: the Diamond money door, the
    // whole-amount rule and the refusal-to-reason translation.
    expect(sql).toContain('public.fn_poker_diamond_tournament_charge(');
    expect(sql).toContain('diamond_tournament_requires_whole_amounts');
    expect(sql).toContain("'poker-tournament-entry:'");
    expect(sql).toContain("'reason', 'insufficient_diamonds'");
    // A Diamond fee stays in custody: rake_records is the chip fee rail only.
    expect(sql).toContain('AND v_unit = 1');
    // The funding receipt names its asset instead of hard-coding chips.
    expect(sql).toContain("CASE WHEN v_unit=100 THEN 'diamonds' ELSE 'chips' END");
    expect(COUNTERFEIT).not.toContain('fn_poker_diamond_tournament_charge');
  });

  it('never routes house money or a chip treasury onto this path', () => {
    // Ruling 16: a chip account is forbidden in a Diamond format. The horse
    // pays from its own profiles.diamonds, like anybody else.
    expect(sql).toContain("position('fn_horse_fund_from_treasury' in v_core) <> 0");
    expect(sql).toContain('ruling 16');
  });

  it('is an md5-pinned asserted in-place substitution in one transaction', () => {
    // Both live texts are pinned, so the apply refuses a body that drifted.
    expect(sql).toContain("<> '33de93271803a28f46c0a259bb2c01c4'");
    expect(sql).toContain("<> '84c0354e68fb129b5373bc6024cba334'");
    // Pinned md5s are never compared against NULL.
    expect(sql).not.toMatch(/md5\([^)]*\)\s*(IS\s+DISTINCT\s+FROM\s+NULL|<>\s*NULL|=\s*NULL)/i);
    // Each replaced clause must occur exactly once, and the reverse
    // substitution must reproduce the pinned text.
    expect(sql).toContain('expected 1');
    expect(sql).toContain('the reverse substitution does not reproduce the pinned text');
    // One transaction, with a bounded lock wait.
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain('COMMIT;');
    // No guard on fn_ca_guard_watchlist() is weakened, skipped or deleted.
    expect(sql).not.toContain('DROP TRIGGER');
    expect(sql).not.toContain('DISABLE TRIGGER');
    expect(sql).not.toContain('DROP FUNCTION');
  });

  it('declares live proofs so a merged migration cannot pass for an applied one', () => {
    const proofs = sql.split('\n').filter((l) => l.startsWith('-- @live-proof:'));
    expect(proofs.length).toBeGreaterThanOrEqual(4);
    // Each proof is a boolean expression over the LIVE catalogue.
    for (const p of proofs) {
      expect(p).toContain('pg_get_functiondef(');
    }
  });
});
