/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A CAPPED DIAMOND SATELLITE WINNER IS PAID, NOT HELD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-16, after MttPlayStopped paged him hourly: "TOURNAMENTS CAN
 * NOT, AND SHOULD NOT EVER EVER EVER FAIL, AND IF FOR SOME REASON THEY DO...
 * THEY MUST 1000% OF THE TIME SELF HEAL AND FINISH UP."
 *
 * What failed: Sunday Deep Stack Satellite 10 (a Diamond satellite) decided
 * at 01:32Z with one survivor and then sat RUNNING, undealt and unpaid for
 * over two hours, because both satellite settlement authorities refused the
 * finish with diamond_satellite_winner_at_the_table_cap - a refusal with no
 * exit while the winner (a horse at four long events) stayed at the cap -
 * and because the four-game cap counted the winner's seat at the very
 * satellite the settlement was about to close.
 *
 * The law, installed by migration
 * 20261017033733_a_capped_diamond_satellite_winner_is_paid_not_held.sql:
 *
 *   1. THE DYING SATELLITE IS NOT A GAME. The winner's live seats at the
 *      satellite being settled are subtracted from the cap load, with the
 *      same predicates fn_concurrent_game_load counts by, because the same
 *      transaction releases them.
 *   2. A CAPPED DIAMOND WINNER IS PAID, NOT HELD. A Diamond winner still at
 *      the cap takes the ticket's value as whole Diamonds through the
 *      duplicate-qualification pay door (delivery_kind 'cash'), in the same
 *      transaction that records the finish. The event always finishes and
 *      the winner is always paid.
 *   3. THE CHIP RULE IS UNCHANGED. A capped chip winner still receives the
 *      noncash tournament-entry ticket ('ticket'), never a fifth game and
 *      never silent wallet chips.
 *   4. NO SETTLEMENT AUTHORITY MAY REINTRODUCE A FINISH REFUSAL THAT CANNOT
 *      CLEAR ITSELF. The no-exit refusal name must not return to either
 *      authority's post-image.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_capped_diamond_satellite_winner_is_paid_not_held.sql'))
  .at(-1);
if (!NAME) throw new Error('the capped-winner migration is missing');
const MIG = migrationText(NAME);

describe('LAW: a capped Diamond satellite winner is paid, not held', () => {
  it('pins the live pre-images it substitutes against, and proves the reverse', () => {
    expect(MIG).toContain('384887d62082eec9a0d61a9d49d955a2');
    expect(MIG).toContain('e8986b5b177c88acbde1ac80fe7e029f');
    expect(MIG).toContain("md5(replace(v_def, v_new, v_old)) <> v_pin");
    expect(MIG).toContain('fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)');
    expect(MIG).toContain('fn_ca_settle_satellite_cohort(uuid,uuid[])');
  });

  it('the dying satellite is not a game: its own live seats leave the cap load', () => {
    expect(MIG).toContain('THE DYING SATELLITE IS NOT A GAME');
    expect(MIG).toContain('zt.tournament_id = p_tournament_id');
    expect(MIG).toContain('zts.left_at IS NULL');
    expect(MIG).toContain("zt.status <> 'closed'");
    // The subtraction mirrors clause (1): a seat at a terminal tournament was
    // never counted, so it is never subtracted either.
    expect(MIG).toContain("ztr.status IN ('COMPLETING','COMPLETED','CANCELLED')");
  });

  it('a capped Diamond winner takes the cash door; the chip ticket rule is unchanged', () => {
    const capBlock = MIG.slice(MIG.indexOf('IF v_cap_load>=4 THEN', MIG.indexOf('v_new constant')));
    expect(capBlock).toContain("A CAPPED DIAMOND WINNER IS PAID, NOT HELD");
    expect(capBlock).toContain("IF v_diamond THEN");
    expect(capBlock).toContain("v_delivery_kind := 'cash';");
    expect(capBlock).toContain("v_delivery_kind := 'ticket';");
    // The Diamond branch pays through the door the Phase 9 header itself
    // names for a ticket paid as money.
    expect(capBlock).toContain('fn_credit_and_log');
    expect(capBlock).toContain('fn_poker_diamond_tournament_pay');
  });

  it('the no-exit refusal is removed from the new clause and asserted gone from the post-image', () => {
    // The OLD clause (quoted for the substitution) carries the refusal; the
    // NEW clause must not, and the migration must prove the live post-image
    // no longer contains it at all.
    const newClause = MIG.slice(MIG.indexOf('v_new constant'), MIG.indexOf('BEGIN', MIG.indexOf('v_new constant')));
    expect(newClause).not.toContain('RAISE EXCEPTION');
    expect(newClause).not.toContain('diamond_satellite_winner_at_the_table_cap');
    expect(MIG).toContain("position('diamond_satellite_winner_at_the_table_cap' IN v_def) <> 0");
    expect(MIG).toContain('still carries the no-exit refusal');
  });

  it('the finish is self-healing by the live path, not a repair job', () => {
    // 10.12: no cron, sweep, healer or backfill is the answer. The migration
    // fixes the refusing clause itself and relies on the engine finish retry.
    expect(MIG).not.toMatch(/cron\.schedule|fn_[a-z_]*_(repair|backpay|redrive|sweep|catchup|heal)_/);
    expect(MIG).toContain('always finishes');
  });
});
